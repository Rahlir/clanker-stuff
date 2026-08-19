---
description: Hand off a specific task to a fresh agent session
argument-hint: "<what to hand off>"
---
Hand off the following task to a fresh agent session:

$@

If the task description above is empty, ask me what exactly I want to hand
off before doing anything else. Never assume you are handing off all of this
session's work.

You have context the fresh agent will not have. Your job is to extract only
what this task needs - not to summarize this session.

Write the handoff document to `.handoffs/<topic>.md` in the repo root
(create the directory if needed), with a short slug derived from the task.
Before writing, verify every claim relevant to this task (`git status`, the
files concerned); label anything you did not verify as `(unverified)`.

Structure:

1. **Task** - the deliverable and definition of done (analysis only? code in
   tree? branch + MR?), plus ground rules (e.g. whether git commit/push is
   allowed).
2. **Baseline** - where the fresh agent starts: branch/commit; which
   uncommitted changes in the tree, if any, belong to this task; what in the
   tree it must NOT touch because it belongs to other in-flight work.
3. **Context** - only what this task needs: why it came up (one or two
   lines), constraints, binding decisions with links to ADRs / design docs.
4. **Suggested approach** - if one emerged in this session; clearly mark
   requirements vs. mere suggestions.
5. **Landmines** - gotchas and dead ends already ruled out, scoped to this
   task.
6. **References** - tickets, docs, key files.

Rules:

- Scope discipline: nothing about work that is not being handed off, beyond
  the boundary described in Baseline.
- Write for a cold reader; no session narrative ("we then tried...").
- Durable knowledge goes to a design doc, ADR, or memory first; the handoff
  only references it.
- Target under 80 lines.

Finish by (a) printing the exact kickoff for the fresh session - normally
`/pickup <topic>` plus any extra arguments - and (b) stating in one line
what this session has handed off and therefore no longer owns.
