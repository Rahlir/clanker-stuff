---
description: Pick up a task from a handoff document in .handoffs/
argument-hint: "[topic] [extra-instructions]"
---
Pick up the task described in a handoff document under `.handoffs/` in the
repo root: $1

Resolving the document:

- If a topic was given, use `.handoffs/<topic>.md`.
- If no topic was given and exactly one handoff document exists, use it.
- Otherwise list the available documents and ask me which one to pick up.

Then:

1. Read the handoff in full. It hands you one specific task; it is not a
   description of all work in this repo.
2. Verify before acting - handoff docs drift. Check every claim about your
   task and its Baseline against reality (`git status`, the referenced
   files, the recorded verification commands). The tree may contain
   unrelated in-progress changes from other work; the Baseline section
   tells you what is yours. Do not treat unrelated changes as
   discrepancies, and do not touch them. Report discrepancies that do
   affect your task before doing anything else.
3. Summarize back: the task as you understand it, the first step you
   propose, and anything unclear. Wait for my confirmation before editing
   any file.

When the task's definition of done is met, **remind me to delete the handoff
document**.

Optional extra instructions: ${@:2}
