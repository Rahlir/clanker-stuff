/**
 * annotate: a pre-publish review gate plus an ad-hoc annotation command.
 *
 * Thin wrapper around the reusable lib/annotator.ts TUI:
 *   - annotate_text tool: the agent calls it on an artifact headed for a durable
 *     destination (a Jira ticket, a file, an MR description, a message); the user
 *     approves / annotates / edits / rejects, and the outcome flows back so the
 *     agent can revise or publish. The required destination keeps ephemeral
 *     content (plans, summaries) out: those belong in chat, refined by discussion.
 *     The agent performs the publishing; this extension only runs the review loop.
 *   - /annotate-last: annotate the agent's last message and send feedback back.
 */

import { StringEnum, type TextContent } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AnnotationResult, openAnnotator } from "../../lib/annotator.ts";

// Deliberately no "chat": content without a durable destination must not be reviewed here.
const DESTINATIONS = ["jira", "file", "git", "confluence", "message", "other"] as const;
type Destination = (typeof DESTINATIONS)[number];

/** Kept in the tool result so the transcript still shows the outcome after the overlay closes. */
interface AnnotateDetails {
  action: AnnotationResult["action"];
  destination: Destination;
  target: string;
  /** Final text for approve/edit, feedback for annotate. */
  text?: string;
  error?: boolean;
}

function okResult(text: string, details: AnnotateDetails) {
  return { content: [{ type: "text" as const, text }], details };
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

const OUTCOME_LABEL: Record<AnnotationResult["action"], string> = {
  approve: "approved",
  edit: "edited by user",
  annotate: "annotated",
  reject: "rejected",
  skip: "dismissed",
};

export default function annotate(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "annotate_text",
    label: "Annotate Text",
    description:
      "Show a drafted artifact to the user for review before you publish it to a durable destination: a Jira ticket, a doc/ADR/notes file, a commit message or MR description, a Confluence page, a message to send. The user can approve it, annotate specific lines (structured feedback to revise against), edit it, or reject it.",
    promptGuidelines: [
      "Use annotate_text only for an artifact that will be written to a durable destination (Jira, a file, git, Confluence, a sent message) once approved. Print implementation plans, proposals, designs under discussion, summaries, and answers that will not be persisted to a file to the chat instead, even when they are long; the user refines those through discussion.",
      "After annotate_text returns approved or edited, continue in the same turn and publish the text to its destination; do not stop at the approval.",
    ],
    // Serialize the whole tool batch: ctx.ui.custom has no mutual exclusion, so a
    // second concurrent component steals focus and hangs the first call forever.
    executionMode: "sequential",
    parameters: Type.Object({
      body: Type.String({ description: "The drafted artifact text to review" }),
      destination: StringEnum(DESTINATIONS, {
        description:
          "Where this exact text goes after approval. git = commit message or MR/PR description; message = Slack, email, or similar.",
      }),
      target: Type.String({
        description:
          "The concrete target within the destination, e.g. 'new HSCTR story', 'HSCTR-1234', 'docs/adr/0012-x.md', 'MR !18'",
      }),
      title: Type.Optional(Type.String({ description: "Short header title, e.g. 'Draft Jira ticket'" })),
      subtitle: Type.Optional(Type.String({ description: "Optional one-line subtitle, e.g. the ticket title" })),
      context: Type.Optional(
        Type.String({ description: "Optional background shown while reviewing (not part of the drafted text)" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) return errResult("annotate_text requires an interactive UI.");
      if (!params.body?.trim()) return errResult("annotate_text requires a non-empty body.");
      const target = params.target?.trim();
      if (!target) {
        return errResult(
          "annotate_text requires a target. If this text has no durable destination, print it to the chat instead.",
        );
      }
      const { destination } = params;
      const where = `${destination}: ${target}`;

      const res = await openAnnotator(ctx, {
        body: params.body,
        title: params.title ?? "Review draft",
        location: where,
        subtitle: params.subtitle,
        context: params.context,
        actions: ["approve", "annotate", "edit", "reject"],
      });

      const details = (text?: string): AnnotateDetails => ({ action: res.action, destination, target, text });
      const publish = `Continue now and publish it to ${where}. Approval alone does not complete the task.`;
      switch (res.action) {
        case "approve":
          return okResult(`User approved the text as-is. ${publish}`, details(params.body));
        case "edit":
          return okResult(
            `User edited the text. Use exactly this version. ${publish}\n\n${res.body}`,
            details(res.body),
          );
        case "annotate":
          return okResult(
            `User annotated the text. Revise it to address every point, then call annotate_text again with the updated body.\n\n${res.feedback}`,
            details(res.feedback),
          );
        case "reject":
          return okResult(
            "User rejected this draft as off-base; it is not what they wanted. Do not tweak it; step back and ask what they actually want, or redraft from scratch.",
            details(),
          );
        default:
          return okResult("User dismissed the review without deciding. Ask how they would like to proceed.", details());
      }
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("annotate_text "));
      if (args.destination) text += theme.fg("muted", `→ ${args.destination}: ${args.target ?? ""}`);
      if (args.title) text += theme.fg("dim", ` (${args.title})`);
      return new Text(text, 0, 0);
    },

    renderResult(result, options, theme) {
      const details = result.details as Partial<AnnotateDetails> | undefined;
      if (!details?.action) {
        const first = result.content[0];
        const text = first?.type === "text" ? first.text : "";
        return new Text(details?.error ? theme.fg("error", text) : text, 0, 0);
      }

      const positive = details.action === "approve" || details.action === "edit";
      const icon = positive ? theme.fg("success", "✓") : theme.fg("warning", "•");
      const container = new Container();
      container.addChild(new Text(`${icon} ${OUTCOME_LABEL[details.action]}`, 0, 0));
      if (!details.text) return container;

      if (options.expanded) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("toolOutput", details.text), 0, 0));
      } else {
        const what = details.action === "annotate" ? "feedback" : "text";
        const hint = `${theme.fg("muted", "(")}${keyHint("app.tools.expand", `to show the ${what}`)}${theme.fg("muted", ")")}`;
        container.addChild(new Text(hint, 0, 0));
      }
      return container;
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
