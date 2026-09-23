/**
 * mr-review: tracked GitLab MR review with an issue list + annotation loop.
 *
 * Scope: the extension owns the scaffolding around the review (entry command,
 * issue tracking + state, the annotation TUI, and posting). The LLM still does
 * the analysis and fetches the diff via the glab skill.
 *
 * Flow:
 *   /mr-review <MR>  -> records MR context, kicks off the agent with the rubric
 *   register_mr_issue -> builds the tracked list (silent)
 *   draft_mr_note     -> per-issue annotation TUI (approve/annotate/edit/reject/skip)
 *   update_mr_issue   -> reject / reopen / edit an issue via conversation
 *   post_mr_review or /mr-post -> confirm + preview, then post via glab
 *
 * State persists via pi.appendEntry and is restored on session_start so a
 * review survives restarts.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { openAnnotator } from "../../lib/annotator.ts";
import { locationLabel, severityColor } from "./format.ts";
import { type AnchorErrorKind, isAnchorFailure, postNote } from "./glab.ts";
import { openIssueList } from "./issues-tui.ts";
import { type PreviewItem, openPostConfirm } from "./post-tui.ts";
import { ReviewStore, type ReviewData, type Severity, validateAnchor } from "./state.ts";
import { issueWidgetFactory } from "./widget.ts";

const WIDGET_ID = "mr-review";
const STATE_TYPE = "mr-review";
// Tools gated to an active review (see setToolsActive) so the agent can't call
// them during unrelated work like a general /review.
const MR_TOOLS = ["register_mr_issue", "draft_mr_note", "update_mr_issue", "post_mr_review"];

function getExtensionDir(): string {
	return path.dirname(fileURLToPath(import.meta.url));
}

function getUserConfigDir(): string {
	const base = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
	return path.join(base, "pi-clanker");
}

// User override wins over the bundled default so `pi update` never clobbers it.
function loadRubric(): string {
	const userPath = path.join(getUserConfigDir(), "mr-review-rubric.md");
	const bundled = path.join(getExtensionDir(), "rubric.md");
	for (const file of [userPath, bundled]) {
		try {
			return fs.readFileSync(file, "utf-8").trim();
		} catch {
			// try next
		}
	}
	return "";
}

function buildKickoff(mr: string, extraContext?: string): string {
	const rubric = loadRubric();
	const instructions = `Review GitLab merge request #${mr}.

Use the glab skill to fetch the MR metadata and full diff, and read the changed code thoroughly.

Then:
1. Post a short Overview (the author's intent and what they achieved) and Strengths as a normal message.
2. For every issue you find, call register_mr_issue(severity, summary, details, file?, startLine?, endLine?).
   - severity is critical, major, or minor.
   - Include file + startLine (and endLine for a range) when the issue is tied to specific lines; those become inline diff comments. Omit them for a general MR note.
   - startLine is a new-side line number that must appear in one of the MR's diff hunks (an added or context line). GitLab rejects an anchor outside the diff, so prefer a general note over a guessed line.
   - file without startLine means a finding about the file as a whole. GitLab cannot attach a comment to a file, so it posts as a general note with the path quoted at the top; write it so it reads that way.
   - A line number without a file, or endLine without startLine, is rejected.
   - Do NOT draft note text yet.
3. After registering every issue, tell me the list is ready. We then go through issues one at a time.

When I ask you to draft a note for an issue, call draft_mr_note(issueId, body) with a concise, reviewer-style comment. Write the body with semantic line breaks: one short sentence or point per line (or markdown bullets), rather than one long paragraph. This keeps it readable when posted to GitLab and lets me annotate individual lines. I will approve, annotate, edit, reject, or skip it. If I annotate, revise the body to address each point and call draft_mr_note again for the same issue until I approve.

If I tell you about an issue I found, call register_mr_issue for it (when you agree). To dismiss or reopen an issue, call update_mr_issue with state rejected or open.

When the issues are addressed, call post_mr_review (or I will run /mr-post) to post the approved notes.`;

	const base = rubric ? `${rubric}\n\n---\n\n${instructions}` : instructions;
	if (extraContext?.trim()) {
		return `${base}\n\n---\n\nAdditional focus / context from the reviewer for this MR:\n${extraContext.trim()}`;
	}
	return base;
}

const SEVERITY = StringEnum(["critical", "major", "minor"] as const);

type PostOutcome = {
	status: "no-review" | "empty" | "cancelled" | "posted" | "failed";
	message: string;
	hadFailures: boolean;
	/**
	 * Recovery instructions aimed at the agent, appended to the tool result only.
	 * /mr-post's notify shows `message` alone: a human reading the per-note detail
	 * does not need the tool-call recipe.
	 */
	guidance?: string;
};

type AnchorFailure = { id: number; location: string; kind: AnchorErrorKind };

/**
 * Tell the agent to fix the anchors instead of retrying.
 *
 * Without this, a rejected position produced a generic failure plus the blanket
 * "re-run post_mr_review" advice, so the agent looped on an argv that can only
 * ever fail the same way. The two kinds get different advice because repointing
 * is only possible when the file itself is in the diff.
 */
function anchorGuidance(failures: AnchorFailure[]): string {
	const label = (f: AnchorFailure) => `#${f.id} (${f.location})`;
	const all = failures.map(label).join(", ");
	const lineFailures = failures.filter((f) => f.kind === "anchor-line");
	const fileFailures = failures.filter((f) => f.kind === "anchor-file");

	const lines = [
		`Anchor rejected for ${all}: that position is not part of this MR's diff, so GitLab cannot attach an inline comment there.`,
		`Do NOT call post_mr_review again for ${all} unchanged; those calls will fail identically. Fix each one first:`,
	];
	if (lineFailures.length > 0) {
		lines.push(
			`For ${lineFailures.map(label).join(", ")} the line is outside the diff. Re-read the MR diff and call either:`,
			"  - update_mr_issue(issueId, file, startLine[, endLine]) with a new-side line number that actually appears in a diff hunk of that file, or",
			"  - update_mr_issue(issueId, postAsGeneral: true) to post it as a general MR note.",
		);
	}
	if (fileFailures.length > 0) {
		lines.push(
			`For ${fileFailures.map(label).join(", ")} the file itself is not in the diff, so no line number will work. Call update_mr_issue(issueId, postAsGeneral: true), and pass a corrected file too if the path is wrong.`,
		);
	}
	lines.push(
		"A general note keeps its recorded file:line: it is quoted at the top of the posted body, so do not repeat it in the text.",
		"Re-draft with draft_mr_note when the wording leans on the note being inline ('this line', 'here', 'the call above'): name the file and the symbol instead. The user approves the rewrite.",
		"The approved note text is preserved and the issues stay queued, so post_mr_review picks up whichever anchors you have fixed.",
	);
	return lines.join("\n");
}

function toolText(outcome: PostOutcome): string {
	return outcome.guidance ? `${outcome.message}\n\n${outcome.guidance}` : outcome.message;
}

export default function mrReview(pi: ExtensionAPI): void {
	const store = new ReviewStore();

	function persist(): void {
		pi.appendEntry(STATE_TYPE, store.serialize());
	}

	function refreshWidget(ctx: ExtensionContext): void {
		if (store.hasReview()) {
			ctx.ui.setWidget(WIDGET_ID, issueWidgetFactory(store));
		} else {
			ctx.ui.setWidget(WIDGET_ID, undefined);
		}
	}

	/**
	 * Run a docked interactive surface with the issue widget hidden.
	 *
	 * The widget shares pi's fullscreen bottom dock with these screens, and the dock
	 * clips over-tall entries at the bottom - exactly where their help bars live.
	 * Not needed for the annotator, which floats above the dock in its own overlay;
	 * hiding the widget there would only add two pointless dock reflows.
	 */
	async function withWidgetHidden<T>(ctx: ExtensionContext, open: () => Promise<T>): Promise<T> {
		ctx.ui.setWidget(WIDGET_ID, undefined);
		try {
			return await open();
		} finally {
			refreshWidget(ctx);
		}
	}

	// Keep the MR tools out of the active set unless a review is in progress, so the
	// agent can't reach for them during unrelated work (e.g. a general /review).
	// Preserves other extensions' / built-in tools.
	function setToolsActive(enabled: boolean): void {
		const active = new Set(pi.getActiveTools());
		let changed = false;
		for (const tool of MR_TOOLS) {
			if (enabled && !active.has(tool)) {
				active.add(tool);
				changed = true;
			} else if (!enabled && active.has(tool)) {
				active.delete(tool);
				changed = true;
			}
		}
		if (changed) pi.setActiveTools([...active]);
	}

	function okResult(text: string, details?: Record<string, unknown>) {
		return { content: [{ type: "text" as const, text }], details: details ?? {} };
	}

	function errResult(text: string) {
		return { content: [{ type: "text" as const, text }], details: { error: true }, isError: true };
	}

	// Shared by the post_mr_review tool and the /mr-post command. The structured
	// outcome lets each caller pick the right signal: the tool maps precondition
	// failures to errResult, the command maps partial failures to an error notice.
	async function runPost(ctx: ExtensionContext): Promise<PostOutcome> {
		if (!store.hasReview()) {
			return { status: "no-review", message: "No active review. Run /mr-review <MR> first.", hadFailures: false };
		}
		const queued = store.queued();
		if (queued.length === 0) {
			return {
				status: "empty",
				message: "No approved notes to post. Approve some issues with draft_mr_note first.",
				hadFailures: false,
			};
		}

		const items: PreviewItem[] = queued.map((i) => ({
			id: i.id,
			severity: i.severity,
			location: locationLabel(i),
			body: i.note ?? "",
		}));

		const selected = await withWidgetHidden(ctx, () => openPostConfirm(ctx, items));
		if (selected === null) return { status: "cancelled", message: "Posting cancelled.", hadFailures: false };
		if (selected.length === 0) {
			return { status: "cancelled", message: "Posting cancelled (no notes selected).", hadFailures: false };
		}

		const results: string[] = [];
		const anchorFailures: AnchorFailure[] = [];
		const retryableIds: number[] = [];
		let posted = 0;
		for (const id of selected) {
			const issue = store.getIssue(id);
			if (!issue) continue;
			const r = await postNote(store.activeMr as string, issue, ctx.cwd);
			if (r.ok) {
				store.markPosted(id);
				posted++;
				results.push(`#${id} \u2713`);
			} else {
				results.push(`#${id} \u2717 ${r.error}`);
				if (isAnchorFailure(r.kind)) {
					anchorFailures.push({ id, location: locationLabel(issue), kind: r.kind });
				} else retryableIds.push(id);
			}
		}
		persist();
		refreshWidget(ctx);
		const hadFailures = posted < selected.length;
		const detail = results.join(", ");
		const guidance = anchorFailures.length > 0 ? anchorGuidance(anchorFailures) : undefined;
		// The retry hint names the ids it applies to rather than saying "the failed
		// notes": in a mixed batch a blanket hint would contradict the anchor guidance
		// appended right after it, which is how the retry loop starts. The contrast
		// clause only appears when there is an anchor failure to contrast against.
		const retryHint =
			retryableIds.length === 0
				? ""
				: ` Re-run post_mr_review to retry ${retryableIds.map((id) => `#${id}`).join(", ")}${
						guidance ? " (unrelated to the anchor rejections below)" : ""
					}; already-posted notes are skipped.`;
		// "failed" only when nothing landed, so the tool can signal an error.
		if (posted === 0) {
			return {
				status: "failed",
				message: `Failed to post any notes to MR #${store.activeMr}: ${detail}.${retryHint}`,
				hadFailures,
				guidance,
			};
		}
		// Lead with an explicit warning on partial failure so it is unmissable.
		const message = hadFailures
			? `Posted with failures to MR #${store.activeMr}: ${detail}.${retryHint}`
			: `Posted to MR #${store.activeMr}: ${detail}`;
		return { status: "posted", message, hadFailures, guidance };
	}

	// ── Session restore ──────────────────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const last = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === STATE_TYPE)
			.pop() as { data?: ReviewData } | undefined;
		if (last?.data?.mr) {
			store.load(last.data);
		}
		refreshWidget(ctx);
		setToolsActive(store.hasReview());
	});

	// ── Commands ─────────────────────────────────────────────────────────
	pi.registerCommand("mr-review", {
		description:
			"Start/resume a tracked GitLab MR review. Usage: /mr-review <MR> [focus/context], or /mr-review <MR> --context to compose longer context in an editor",
		handler: async (args, ctx) => {
			const [mr, ...rest] = (args ?? "").trim().split(/\s+/);
			if (!mr) {
				ctx.ui.notify("Usage: /mr-review <MR> [focus/context]", "error");
				return;
			}

			// Extra reviewer context: inline trailing text, or `--context` to open an
			// editor (prefilled with any text after the flag) for longer/multi-line input.
			let extraContext: string;
			if (rest[0] === "--context") {
				const composed = await ctx.ui.editor(`Extra focus / context for MR #${mr}`, rest.slice(1).join(" ").trim());
				extraContext = (composed ?? "").trim();
			} else {
				extraContext = rest.join(" ").trim();
			}

			// Same MR -> resume (never re-kick). If extra context was given, steer the
			// ongoing review with it instead of dropping it.
			if (store.hasReview() && store.activeMr === mr) {
				refreshWidget(ctx);
				setToolsActive(true);
				if (extraContext) {
					const steer = `Additional focus / context for the ongoing review of MR #${mr}:\n\n${extraContext}`;
					if (ctx.isIdle()) pi.sendUserMessage(steer);
					else pi.sendUserMessage(steer, { deliverAs: "steer" });
					ctx.ui.notify(`Resumed review of MR #${mr} (${store.list().length} issues); added your context.`, "info");
				} else {
					ctx.ui.notify(`Resumed review of MR #${mr} (${store.list().length} issues).`, "info");
				}
				return;
			}

			if (store.hasReview() && store.activeMr !== mr) {
				const ok = await ctx.ui.confirm(
					"Reset review?",
					`A review of MR #${store.activeMr} is in progress. Discard it and start MR #${mr}?`,
				);
				if (!ok) return;
			}

			store.start(mr);
			setToolsActive(true);
			persist();
			refreshWidget(ctx);
			pi.sendUserMessage(buildKickoff(mr, extraContext));
		},
	});

	pi.registerCommand("mr-post", {
		description: "Preview and post the approved MR review notes",
		handler: async (_args, ctx) => {
			const outcome = await runPost(ctx);
			const severity = outcome.hadFailures
				? "error"
				: outcome.status === "no-review" || outcome.status === "empty"
					? "warning"
					: "info";
			ctx.ui.notify(outcome.message, severity);
		},
	});

	pi.registerCommand("mr-issues", {
		description: "Browse the full issue list of the current MR review",
		handler: async (_args, ctx) => {
			await withWidgetHidden(ctx, () => openIssueList(ctx, store));
		},
	});

	pi.registerCommand("mr-reset", {
		description: "Clear the current MR review",
		handler: async (_args, ctx) => {
			if (!store.hasReview()) {
				ctx.ui.notify("No active MR review.", "info");
				return;
			}
			const mr = store.activeMr;
			store.reset();
			setToolsActive(false);
			persist();
			refreshWidget(ctx);
			ctx.ui.notify(`Cleared review of MR #${mr}.`, "info");
		},
	});

	// ── Tools ────────────────────────────────────────────────────────────
	pi.registerTool({
		name: "register_mr_issue",
		label: "Register MR Issue",
		description:
			"Part of the /mr-review workflow; only available during an active review. Register an issue found during MR review into the tracked list. Silent (no UI). Provide file + startLine (and endLine for a range) when the issue is tied to specific lines; those drive inline diff comments. startLine must be a new-side line number that appears in one of the MR's diff hunks; GitLab rejects an anchor outside the diff, so omit the position rather than guessing a line. file on its own means a finding about the whole file: GitLab cannot anchor those, so it posts as a general note with the path quoted at the top. Omit all three for a general MR note. A line without a file, or endLine without startLine, is rejected.",
		promptGuidelines: [
			"register_mr_issue and the other mr-review tools belong to the /mr-review MR-review workflow only. Do not use them for general code review that isn't posting findings to a GitLab MR.",
		],
		parameters: Type.Object({
			severity: SEVERITY,
			summary: Type.String({ description: "Short one-line summary shown in the issue list" }),
			details: Type.String({ description: "Full reasoning: why this is an issue and what to consider" }),
			file: Type.Optional(Type.String({ description: "Path to the file the issue is in (required for a line anchor)" })),
			startLine: Type.Optional(Type.Number({ description: "First line the issue refers to (for inline comments)" })),
			endLine: Type.Optional(Type.Number({ description: "Last line of the range, if the issue spans multiple lines" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!store.hasReview()) return errResult("No active review. Run /mr-review <MR> first.");
			const p = params as {
				severity: Severity;
				summary: string;
				details: string;
				file?: string;
				startLine?: number;
				endLine?: number;
			};
			const anchorError = validateAnchor(p);
			if (anchorError) return errResult(`Cannot register issue: ${anchorError}`);
			const issue = store.addIssue(p);
			persist();
			refreshWidget(ctx);
			return okResult(
				`Registered issue #${issue.id} [${issue.severity}]: ${issue.summary}. (${store.counts().total} total.)`,
				{ id: issue.id },
			);
		},
	});

	pi.registerTool({
		name: "draft_mr_note",
		label: "Draft MR Note",
		description:
			"Part of the /mr-review workflow. Open the review TUI for a registered issue with a proposed note body. Write the body with semantic line breaks (one short sentence or point per line, or markdown bullets) rather than one long paragraph, so it reads well when posted and the user can annotate individual lines. The user can approve, annotate (returns structured feedback to revise and resubmit), edit, reject, or skip. Call this one issue at a time when the user wants to go through the list.",
		// Serialize the whole tool batch: ctx.ui.custom has no mutual exclusion, so a
		// second concurrent component steals focus and hangs the first call forever.
		executionMode: "sequential",
		parameters: Type.Object({
			issueId: Type.Number({ description: "Id of the registered issue (see the issue list)" }),
			body: Type.String({ description: "Proposed reviewer-style comment to post for this issue" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) return errResult("draft_mr_note requires an interactive UI.");
			const p = params as { issueId: number; body: string };
			const issue = store.getIssue(p.issueId);
			if (!issue) return errResult(`No issue #${p.issueId} in the current review.`);
			if (issue.state === "rejected") {
				return errResult(`Issue #${p.issueId} was rejected. Reopen it with update_mr_issue(state: "open") first.`);
			}

			const res = await openAnnotator(ctx, {
				title: `Draft note \u00b7 issue #${issue.id}`,
				tag: { text: `[${issue.severity}]`, color: severityColor(issue.severity) },
				location: locationLabel(issue),
				subtitle: issue.summary,
				context: issue.details,
				bodyLabel: "proposed note (posted to the MR):",
				editTitle: `Edit note for issue #${issue.id}`,
				body: p.body,
				actions: ["approve", "annotate", "edit", "reject", "skip"],
			});
			switch (res.action) {
				case "approve":
					store.setNote(issue.id, p.body);
					persist();
					refreshWidget(ctx);
					return okResult(`Issue #${issue.id} approved and queued for posting.\n\nNote:\n${p.body}`, {
						action: "approve",
					});
				case "edit":
					store.setNote(issue.id, res.body);
					persist();
					refreshWidget(ctx);
					return okResult(
						`Issue #${issue.id} approved with the user's manual edits and queued for posting.\n\nFinal note:\n${res.body}`,
						{ action: "edit" },
					);
				case "annotate":
					return okResult(
						`The user annotated your draft for issue #${issue.id}. Revise the note body to address each point, then call draft_mr_note again for issue #${issue.id}.\n\nAnnotations:\n${res.feedback}`,
						{ action: "annotate" },
					);
				case "reject":
					store.markRejected(issue.id);
					persist();
					refreshWidget(ctx);
					return okResult(`Issue #${issue.id} rejected. No comment will be posted for it.`, { action: "reject" });
				default:
					return okResult(`Issue #${issue.id} skipped (still open). You can revisit it later.`, { action: "skip" });
			}
		},
	});

	pi.registerTool({
		name: "update_mr_issue",
		label: "Update MR Issue",
		description:
			"Part of the /mr-review workflow. Edit a registered issue or change its state. Use state 'rejected' to dismiss an issue or 'open' to reopen one. Reopening clears the drafted note AND the posted record, so if the issue was already posted, re-posting may create a second comment on GitLab when the new body differs. The 'commented' state is reached only through draft_mr_note approval. Use this to repair an anchor GitLab rejected: pass file/startLine/endLine for a line inside a diff hunk, or postAsGeneral to post the issue as a general note instead. Passing a new startLine also re-enables inline posting. Fixing an anchor keeps the approved note and leaves the issue queued for the next post_mr_review.",
		parameters: Type.Object({
			issueId: Type.Number({ description: "Id of the issue to update" }),
			severity: Type.Optional(SEVERITY),
			summary: Type.Optional(Type.String()),
			details: Type.Optional(Type.String()),
			file: Type.Optional(Type.String()),
			startLine: Type.Optional(Type.Number()),
			endLine: Type.Optional(Type.Number()),
			postAsGeneral: Type.Optional(
				Type.Boolean({
					description:
						"Post as a general MR note instead of an inline comment. The recorded file/startLine are kept and quoted at the top of the posted body, so the reader still knows what the note is about; pass a corrected file alongside if the path is wrong.",
				}),
			),
			state: Type.Optional(StringEnum(["open", "rejected"] as const)),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!store.hasReview()) return errResult("No active review. Run /mr-review <MR> first.");
			const p = params as {
				issueId: number;
				severity?: Severity;
				summary?: string;
				details?: string;
				file?: string;
				startLine?: number;
				endLine?: number;
				postAsGeneral?: boolean;
				state?: "open" | "rejected";
			};
			const outcome = store.updateIssue(p.issueId, p);
			if (!outcome.ok) {
				return errResult(
					outcome.reason === "not-found"
						? `No issue #${p.issueId} in the current review.`
						: `Issue #${p.issueId} left unchanged: ${outcome.error}`,
				);
			}
			const issue = outcome.issue;
			persist();
			refreshWidget(ctx);
			return okResult(
				`Updated issue #${issue.id} [${issue.severity}] (${issue.state}) at ${locationLabel(issue)}: ${issue.summary}`,
				{ id: issue.id },
			);
		},
	});

	pi.registerTool({
		name: "post_mr_review",
		label: "Post MR Review",
		description:
			"Part of the /mr-review workflow. Open the confirm + preview screen for the approved (queued) notes and post them to the MR via glab. Call when the issues have been addressed.",
		// Same reason as draft_mr_note: two TUIs open at once hang the first caller.
		executionMode: "sequential",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) return errResult("post_mr_review requires an interactive UI.");
			const outcome = await runPost(ctx);
			if (outcome.status === "no-review" || outcome.status === "empty" || outcome.status === "failed") {
				return errResult(toolText(outcome));
			}
			return okResult(toolText(outcome));
		},
	});
}
