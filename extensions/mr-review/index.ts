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
import { postNote } from "./glab.ts";
import { openIssueList } from "./issues-tui.ts";
import { type PreviewItem, openPostConfirm } from "./post-tui.ts";
import { ReviewStore, type ReviewData, type Severity } from "./state.ts";
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
};

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
			inline: !!(i.file && i.startLine),
			location: i.file ? `${i.file}:${i.endLine ?? i.startLine}` : "general",
			body: i.note ?? "",
		}));

		const selected = await openPostConfirm(ctx, items);
		if (selected === null) return { status: "cancelled", message: "Posting cancelled.", hadFailures: false };
		if (selected.length === 0) {
			return { status: "cancelled", message: "Posting cancelled (no notes selected).", hadFailures: false };
		}

		const results: string[] = [];
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
			}
		}
		persist();
		refreshWidget(ctx);
		const hadFailures = posted < selected.length;
		const detail = results.join(", ");
		// "failed" only when nothing landed, so the tool can signal an error.
		if (posted === 0) {
			return { status: "failed", message: `Failed to post any notes to MR #${store.activeMr}: ${detail}`, hadFailures };
		}
		// Lead with an explicit warning on partial failure so it is unmissable in
		// the tool result; a retry is safe because --unique skips posted notes.
		const message = hadFailures
			? `Posted with failures to MR #${store.activeMr}: ${detail}. Re-run post_mr_review to retry the failed notes (already-posted notes are skipped).`
			: `Posted to MR #${store.activeMr}: ${detail}`;
		return { status: "posted", message, hadFailures };
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
			await openIssueList(ctx, store);
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
			"Part of the /mr-review workflow; only available during an active review. Register an issue found during MR review into the tracked list. Silent (no UI). Provide file + startLine (and endLine for a range) when the issue is tied to specific lines; those drive inline diff comments. Omit them for a general MR note.",
		promptGuidelines: [
			"register_mr_issue and the other mr-review tools belong to the /mr-review MR-review workflow only. Do not use them for general code review that isn't posting findings to a GitLab MR.",
		],
		parameters: Type.Object({
			severity: SEVERITY,
			summary: Type.String({ description: "Short one-line summary shown in the issue list" }),
			details: Type.String({ description: "Full reasoning: why this is an issue and what to consider" }),
			file: Type.Optional(Type.String({ description: "Path to the file the issue is in (for inline comments)" })),
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
			"Part of the /mr-review workflow. Edit a registered issue or change its state. Use state 'rejected' to dismiss an issue or 'open' to reopen one. Reopening clears the drafted note AND the posted record, so if the issue was already posted, re-posting may create a second comment on GitLab when the new body differs. The 'commented' state is reached only through draft_mr_note approval.",
		parameters: Type.Object({
			issueId: Type.Number({ description: "Id of the issue to update" }),
			severity: Type.Optional(SEVERITY),
			summary: Type.Optional(Type.String()),
			details: Type.Optional(Type.String()),
			file: Type.Optional(Type.String()),
			startLine: Type.Optional(Type.Number()),
			endLine: Type.Optional(Type.Number()),
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
				state?: "open" | "rejected";
			};
			const issue = store.updateIssue(p.issueId, p);
			if (!issue) return errResult(`No issue #${p.issueId} in the current review.`);
			persist();
			refreshWidget(ctx);
			return okResult(`Updated issue #${issue.id} [${issue.severity}] (${issue.state}): ${issue.summary}`, {
				id: issue.id,
			});
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
				return errResult(outcome.message);
			}
			return okResult(outcome.message);
		},
	});
}
