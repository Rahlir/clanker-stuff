# annotate

A generic, workflow-agnostic annotation surface for pi, built on the reusable
`lib/annotator.ts` TUI.

Use it whenever the agent drafts content you want to shape before it's finalized:
Jira tickets, personal notes, docs, commit messages, messages, etc.

## Tool

`annotate_text(body, title?, subtitle?, context?)` opens a review of the
drafted text. You can:

- **approve**: use it as-is
- **annotate**: attach per-line / per-line-range comments plus an overall note;
  these return to the agent as structured feedback to revise against
- **edit**: open a full editor and rewrite it yourself
- **reject**: it's off-base; the agent should step back / redraft, not tweak

The agent calls this after drafting content, incorporates your feedback (calling
`annotate_text` again until you approve), and then performs the actual action
(create the ticket via the jira skill, append to your notes file, etc.). This
extension only runs the review loop; it never finalizes anything itself.

## Command

`/annotate-last` annotates the agent's last message. Attach annotations (sent
back as feedback) or edit it (sent back as "use this version instead"). Esc
cancels without sending anything.

## On screen

The review renders as a centered, fully framed overlay in both regular and
fullscreen TUI modes, floating above the transcript instead of taking over the
input area. pi pads an overlay to its own width but draws no edges, so the box is
opaque; the border is what keeps it legible against dense text behind it. Long content
scrolls inside the box rather than being cut off (`↑`/`↓` on the review screen; the
annotate screen follows your cursor), with the header and help bar pinned.

Two consequences:

1. **edit** leaves the overlay for pi's own editor dialog at the bottom of the
   screen and returns afterwards, which is what preserves the `ctrl+g`
   external-editor round-trip.
2. pi refuses to switch TUI mode through `/settings` while an overlay is open,
   so close the review first.

## Reusable core

The TUI lives in `lib/annotator.ts` as `openAnnotator(ctx, options)`, a neutral
module that registers nothing. Other extensions import it directly to embed the
same annotation loop in their own workflows (see `mr-review`, which uses it for
per-issue note review with its own state and posting on top).

Only one interactive UI can be on screen at a time: pi's `ctx.ui.custom`,
`ctx.ui.editor` and `ctx.ui.confirm` share one container, and a second one evicts
the first, whose promise then never settles. So a tool that opens any of them
**must** declare `executionMode: "sequential"` (as `annotate_text` does), and
`openAnnotator` takes the process-wide lock in `lib/ui-lock.ts` so a caller that
forgets gets an error instead of a hung call.
