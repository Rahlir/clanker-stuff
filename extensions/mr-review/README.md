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

- `/mr-review <MR>` — start or resume a review
- `/mr-issues` — browse the full issue list in a scrollable view
- `/mr-post` — preview and post approved notes
- `/mr-reset` — clear the current review

The issue widget above the editor auto-sizes to the terminal: it uses the full
width for summaries and shows as many issues as fit the viewport height. When
there are more than fit, it shows a `+N more` notice; use `/mr-issues` to see
them all. Long note text in the draft/annotate screens is soft-wrapped so it is
never cut off (the posted note keeps its original line breaks).

## Tools (agent-callable)

- `register_mr_issue(severity, summary, details, file?, startLine?, endLine?)`
- `draft_mr_note(issueId, body)`
- `update_mr_issue(issueId, { severity?, summary?, details?, file?, lines?, state? })`
- `post_mr_review()`

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
