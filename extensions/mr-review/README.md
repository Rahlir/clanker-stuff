# mr-review

Tracked GitLab MR review for pi: an issue list plus a per-issue annotation loop,
with safe posting via `glab`.

The LLM still does the analysis and fetches the diff (via the `glab` skill). The
extension owns the scaffolding: the entry command, the tracked issue list with
state, the annotation loop, and posting.

The annotation TUI itself is the shared `lib/annotator.ts` module (also used by
the `annotate` extension); `draft_mr_note` calls `openAnnotator` and wires the
outcome into the issue store. This is a plain in-repo import, so mr-review needs
`lib/annotator.ts` present (both ship together in this package).

## Flow

1. `/mr-review <MR>` records the MR and kicks the agent off with a review rubric.
2. The agent posts an Overview + Strengths, then calls `register_mr_issue` for
   each finding. A passive list appears above the editor with per-issue state.
3. Go through issues one at a time: the agent calls `draft_mr_note(issueId, body)`,
   the review TUI opens, and you **approve / annotate / edit / reject / skip**.
   - **Annotate** lets you attach per-line and per-line-range comments plus an
     overall note; these go back to the agent as structured feedback to revise
     and resubmit.
   - **Edit** opens a full editor to fix the text yourself.
3. Inject your own findings in conversation ("I found another: ..."); the agent
   registers them with `register_mr_issue`. Dismiss/reopen via `update_mr_issue`.
4. `post_mr_review` (agent) or `/mr-post` (you) opens a confirm + preview screen,
   then posts the approved notes. Issues with `file` + `startLine` post as inline
   diff comments; the rest as general MR notes.

State persists across restarts; re-running `/mr-review` on the same MR resumes.

## Commands

- `/mr-review <MR> [focus/context]`: start or resume a review. Any text after the
  MR number is passed to the agent as extra reviewer focus/context: appended to
  the kickoff for a fresh review, or sent as a steering message when resuming.
  Use `/mr-review <MR> --context` to compose longer/multi-line context in an
  editor (seeded with any text after the flag).
- `/mr-issues`: browse the full issue list in a scrollable view
- `/mr-post`: preview and post approved notes
- `/mr-reset`: clear the current review

The issue widget above the editor auto-sizes to the terminal: it uses the full
width for summaries and shows as many issues as fit. In fullscreen mode it takes
at most a third of the height, because every row it occupies is taken from the
transcript for as long as the review lasts. When there are more issues than fit,
it shows a `+N more` notice; use `/mr-issues` to see them all.

`/mr-issues` and `/mr-post` hide the widget while they are open, since all three
share pi's bottom dock and the dock clips whatever does not fit.

## Tools (agent-callable)

These tools are **gated to an active review**: they're only in the agent's active
tool set between `/mr-review` and `/mr-reset`, so the agent can't reach for them
during unrelated work (e.g. a general `/review`). Outside a review they aren't
registered as callable and cost no prompt tokens.

- `register_mr_issue(severity, summary, details, file?, startLine?, endLine?)`
- `draft_mr_note(issueId, body)`
- `update_mr_issue(issueId, { severity?, summary?, details?, file?, lines?, state? })`
- `post_mr_review()`

`draft_mr_note` and `post_mr_review` are declared `executionMode: "sequential"`,
which makes pi run their whole tool batch one call at a time. Without it, an
agent that fires several `draft_mr_note` calls in one message opens several TUIs
at once; the last one steals focus and the earlier calls hang forever. The issue
list and post-preview screens additionally take the shared lock in
`lib/ui-lock.ts`, which covers the case `executionMode` cannot: `/mr-issues` or
`/mr-post` fired while a note TUI is already open.

## Rubric override

The review rubric is read from, in order:

1. `${XDG_CONFIG_HOME:-$HOME/.config}/pi-clanker/mr-review-rubric.md` (your override)
2. the bundled `rubric.md` (reset on `pi update`)

## Reusable annotation core

The review/annotate TUI lives in `lib/annotator.ts` (`openAnnotator`), a neutral
module shared with the `annotate` extension. mr-review supplies the MR-specific
framing (title, severity tag, `file:line` location, the issue summary/details as
context) and maps the result into its `ReviewStore`.

## Posting safety

Notes are posted with `execFile("glab", ...)` (no shell), so backticks, `$`, and
quotes in note bodies are passed literally and never interpreted.

General notes use `--unique` for idempotent re-runs. Inline diff comments cannot
(glab treats `--file` and `--unique` as mutually exclusive), so their idempotency
relies on the stored `posted` flag, which already prevents re-posting on retry.
