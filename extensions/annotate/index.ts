/**
 * annotate: a generic, workflow-agnostic annotation surface.
 *
 * Thin wrapper around the reusable lib/annotator.ts TUI:
 *   - annotate_text tool: the agent calls it on content it drafted (a Jira
 *     ticket, a note, a doc section, a message); the user approves / annotates /
 *     edits / rejects, and the outcome flows back so the agent can revise. The
 *     agent performs any actual workflow action (create ticket, write note);
 *     this extension only runs the review loop.
 *   - /annotate-last: annotate the agent's last message and send feedback back.
 */

import type { TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { openAnnotator } from "../../lib/annotator.ts";

function okResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

function errResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: { error: true }, isError: true };
}

function getLastAssistantText(ctx: ExtensionContext): string | null {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const content = entry.message.content;
		if (Array.isArray(content)) {
			const text = content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("\n")
				.trim();
			if (text) return text;
		}
	}
	return null;
}

export default function annotate(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "annotate_text",
		label: "Annotate Text",
		description:
			"Open an interactive review of text you drafted. The user can approve it, annotate specific lines/ranges (returns structured feedback to revise), edit it directly, or reject it. Use after drafting content the user will want to refine (a Jira ticket, a note, a doc section, a message) to get their feedback before finalizing. Returns the outcome; you then perform the actual action (create the ticket, write the note, etc.).",
		promptGuidelines: [
			"Use annotate_text when you have drafted substantial content the user will want to refine (a Jira ticket, a note, a doc section, a message) and you want their structured feedback before finalizing. Do not use it for trivial replies.",
		],
		parameters: Type.Object({
			body: Type.String({ description: "The drafted text to review" }),
			title: Type.Optional(Type.String({ description: "Short header title, e.g. 'Draft Jira ticket'" })),
			subtitle: Type.Optional(Type.String({ description: "Optional one-line subtitle, e.g. the ticket title" })),
			context: Type.Optional(
				Type.String({ description: "Optional background shown while reviewing (not part of the drafted text)" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) return errResult("annotate_text requires an interactive UI.");
			const p = params as { body: string; title?: string; subtitle?: string; context?: string };
			if (!p.body?.trim()) return errResult("annotate_text requires a non-empty body.");

			const res = await openAnnotator(ctx, {
				body: p.body,
				title: p.title ?? "Review draft",
				subtitle: p.subtitle,
				context: p.context,
				actions: ["approve", "annotate", "edit", "reject"],
			});

			switch (res.action) {
				case "approve":
					return okResult("User approved the text as-is. Use it unchanged.");
				case "edit":
					return okResult(`User edited the text themselves. Use exactly this version:\n\n${res.body}`);
				case "annotate":
					return okResult(
						`User annotated the text. Revise it to address every point, then call annotate_text again with the updated body.\n\n${res.feedback}`,
					);
				case "reject":
					return okResult(
						"User rejected this draft as off-base \u2014 it is not what they wanted. Do not tweak it; step back and ask what they actually want, or redraft from scratch.",
					);
				default:
					return okResult("User dismissed the review without deciding. Ask how they would like to proceed.");
			}
		},
	});

	pi.registerCommand("annotate-last", {
		description: "Annotate the agent's last message and send feedback",
		handler: async (_args, ctx) => {
			const text = getLastAssistantText(ctx);
			if (!text) {
				ctx.ui.notify("No assistant message to annotate.", "error");
				return;
			}

			const res = await openAnnotator(ctx, {
				body: text,
				title: "Annotate last message",
				bodyLabel: "assistant message:",
				actions: ["annotate", "edit"],
			});

			if (res.action === "annotate") {
				pi.sendUserMessage(`Feedback on your last message:\n\n${res.feedback}`);
			} else if (res.action === "edit") {
				pi.sendUserMessage(`Please use this version of your last message instead:\n\n${res.body}`);
			}
			// skip / esc: nothing sent.
		},
	});
}
