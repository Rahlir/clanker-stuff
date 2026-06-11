---
name: task-review
description: Weekly task refresh ritual for Task System v3. Use when the user asks for a "refresh", "weekly review", "task review", "rebuild my week", a "catch-up" after a gap, or is following up on a scheduled refresh nudge or morning deadline check. Also defines the content rules for those two scheduled nudges.
---

# Task Review (Weekly Refresh)

The single ritual of Task System v3: a ~10 minute conversation that
rebuilds the `+active` working set, catches what slipped, prunes decay,
and records weekly focus. The design contract is
`projects/task-system-v3.md` in the notes repo.

The user makes decisions; the agent does **all** mechanics. The user
never scans, sorts, dedups, or moves anything.

## Principles (non-negotiable)

1. **Brain dump first.** The user states what matters next week BEFORE
   seeing any list. Never show leftovers, backlog, or Jira before the
   brain dump. This forces "what does my brain think matters?" instead
   of copy-paste rollover.
2. **Constant re-entry cost.** A refresh after a 5-week gap is the same
   10 minutes as after 1 week. Compress, summarize, batch. Never inflate
   the session because of a gap, and never mention the gap as a problem.
3. **No guilt.** Lead with what got done. Frame overdue/stale items
   forward-looking (reschedule? drop?). Never report how big the backlog
   is unless asked.
4. **Skipping is free.** If the user declines or abandons a refresh
   midway, finish nothing silently: state what was and wasn't done, and
   leave the system consistent (sync, push what was written).

## Prerequisites

- All `task` CLI operations follow the **taskwarrior skill** and its
  `taskwarrior.local.md` (capture rule, decay policy, due policy).
- Notes repo location: `$ZK_NOTEBOOK_DIR` if set (the environment
  decides; never override it), else `~/Documents/rahlir-notes` (user
  machine convention). Do not guess other paths.
- If the repo is missing at that location:
  - If you are able to clone from github (requires Github SSH access on the
    device), ask the user for approval and clone with:
    `git clone git@github.com:Rahlir/rahlir-notes.git <location>`
  - Otherwise, report that the repo is missing and continue with degraded
    refresh.
- If the repo is unavailable (not seeded, no auth, clone declined),
  run a **degraded refresh**: all taskwarrior steps proceed normally;
  skip daily-note mining (step 3) and the focus.md write (step 10).
  Like the Jira pass, state explicitly that these were skipped, and
  note that the focus entry should be written at the next refresh on a
  device with the repo.
- All writes to the notes repo follow the repo's `AGENTS.md` (git
  hygiene; agent commits/pushes there are pre-approved within its
  rules).

## Refresh procedure

Run steps in this order. Steps 4-7 are conversational; keep each to a
few lines.

1. **Sync & pull.** `task synchronize`; `git pull --rebase` in the notes
   repo. Surface failures, then continue with what is available.
2. **Establish the window.** Last refresh date = date of the top section
   in `focus.md` (fallback: git log for `focus.md`; first ever refresh:
   ~2 weeks). The window is [last refresh, now].
3. **Gather silently** (no output yet):
   - Completions in the window: `task end.after:<date> completed export`
   - Current `+active` leftovers, backlog (`task shelf`), upcoming hard
     deadlines (`task due.before:<now+3wk> list`)
   - Daily notes in the window (`daily/YYYY-MM-DD.md`): scan for
     finished work matching open tasks and for new commitments that
     match no existing task
   - Stale candidates per the decay policy (~8 weeks untouched)
4. **Momentum summary.** 3-6 lines: what got done since last time
   (from completions + daily notes). Then ask for the brain dump:
   "What matters next week?"
5. **Brain dump processing.** Map the user's items onto existing tasks
   (these become `+active`); capture genuinely new ones (accept-first,
   dedup per local config).
6. **Show what they forgot**, in three short blocks, each with a quick
   keep/drop/backlog decision:
   - leftover `+active` tasks not mentioned in the brain dump
   - backlog items that look timely (deadlines approaching, related to
     brain-dumped work, or repeatedly mentioned in daily notes)
   - hard deadlines inside the next ~3 weeks
7. **Stale batch.** One list, one question ("drop these 5?"). Approved
   items are deleted; the rest are left untouched. Never auto-delete.
8. **Jira pass** - only where Jira is reachable (work laptop). Use the
   jira skill: diff assigned open issues against pending tasks; propose
   additions (as user-shaped tasks, annotated with the issue key) and
   completions/closures. **Always state explicitly whether this pass ran
   or was skipped and why.**
9. **Apply.** Rebuild the `+active` set (bulk tag add/remove for the
   agreed set is pre-approved; no per-task confirmation theater). Mark
   confirmed completions done. Run `task synchronize`.
10. **Write focus.md** (format below): prepend the new week section from
    the user's brain dump + decisions; append the outcome line to the
    previous section. Commit and push per the repo's `AGENTS.md`.
11. **Close.** One screen: the new active set, hard deadlines, and what
    passes ran (Jira yes/no). Done.

Mid-refresh, the user may digress (annotate something, ask about a
project). Follow, then return to the sequence.

## focus.md format

Single file at the notes repo root. Dated sections, newest on top. The
agent prepends; never rewrites old sections except to append the
one-line outcome.

```markdown
---
tags:
  - focus
---
# Weekly Focus

## Week of 2026-06-15

Prose, 2-5 sentences, written from the user's brain dump in their
voice. What matters and why; hard deadlines in words.

## Week of 2026-06-08

(older entry, untouched)

_Outcome:_ shipped the selector; envelope decision slipped to web team.
```

- Section heading: `## Week of <ISO date of that week's Monday>`.
- The `_Outcome:_` line is appended to the **previous** section during
  step 10, based on the momentum summary. One line, factual, no grades.
- No task lists in this file. Tasks live in taskwarrior only.

## Scheduled nudges (content rules)

Job scheduling lives chatbot-side; the message content follows these
rules so nudges and follow-up conversations stay consistent.

**Refresh nudge** (Mondays):
- One message, actionable in place: "Ready for a ~10 minute refresh? We
  can do it right here."
- Never repeats within the week, never escalates.
- After a multi-week gap, get *softer*, not louder: "Been a few weeks -
  want a 5-minute catch-up? The backlog kept itself."
- If the user declines or ignores it: drop the subject until the next
  scheduled nudge.

**Morning deadline check** (daily):
- Query `task due:today or +OVERDUE`. **If empty, send nothing.**
- If non-empty: one short message listing the items, framed
  forward-looking. Overdue items get "still relevant - reschedule or
  drop?", never a red pile or a count of days overdue.
- Act on replies directly (reschedule, complete, drop) per the
  taskwarrior skill rules.

## NEVER

- **NEVER** show lists before the brain dump (step 4 before 5-6).
- **NEVER** auto-delete stale tasks; the batch question is mandatory.
- **NEVER** inflate a refresh because of a long gap, or remark on the
  gap as a failure.
- **NEVER** write task lists into focus.md or any other note.
- **NEVER** claim the Jira pass ran when it was skipped.
- **NEVER** leave the session half-applied: if aborted, sync taskwarrior,
  push what was committed, and say plainly what remains undone.
