# Taskwarrior Skill

Personal-assistant interface to the user's [Taskwarrior](https://taskwarrior.org)
task list using the local `task` CLI.

## What It Does

This skill lets an AI agent act as a personal assistant over the user's
Taskwarrior database. It helps with questions like:

- "What should I work on right now?"
- "What's the most critical work task this week?"
- "What's overdue?"
- "Plan my day."
- "Walk me through a weekly review."
- "Add a task to follow up with Alex about the RFC, due Friday."
- "I have 60 minutes and low energy, suggest something."

It can:

- List, search, and rank tasks (by urgency, due date, project, tag, context)
- Add, modify, annotate, start/stop, complete tasks
- Switch contexts and respect the active context
- Run daily plan, weekly review, overdue triage, project health snapshots
- Translate plain language requests into the right `task` filters and
  reports

The user owns the task list. The agent never invents tasks, never
auto-prioritizes silently, and never runs destructive operations without
confirmation.

## Prerequisites

The skill is deployment neutral: it assumes Taskwarrior 3.x and a synced
replica of the user's task list, resolving config/data through the
standard mechanisms (`TASKRC` / `TASKDATA` when set, XDG paths
otherwise). Known deployments:

- **User machines**: `task` installed natively, dotfiles-managed taskrc.
- **fluke-chat sandbox**: `task` baked into the `fluke-chat:personal`
  image, database/config under the persistent `/shared/task` mount
  (`TASKDATA` / `TASKRC` set in the image), scaffolded by the host-side
  seed script; see `docs/sandbox-image.md` in the fluke-chat repo.

## Recommended Local Configuration

The `SKILL.md` is intentionally generic. A separate `taskwarrior.local.md`
file holds **only what the agent cannot discover by running `task`**:
meaning, intent, and personal conventions.

```
~/.config/pi-clanker/
└── taskwarrior.local.md            <- your conventions (create from template)

skills/taskwarrior/
├── README.md
├── SKILL.md
├── taskwarrior.local.example.md    <- template, copy and edit
└── references/
    ├── commands.md
    ├── advanced.md
    └── assistant_patterns.md
```

The local config lives in `${XDG_CONFIG_HOME:-$HOME/.config}/pi-clanker/`
so it survives `pi update` without manual intervention.

### What belongs in `taskwarrior.local.md` vs not

The agent reads `taskwarrior.local.md` on every turn. Keep it short and
focused on things the CLI cannot reveal. Anything queryable belongs in the
live database, not in the file, otherwise it rots the moment you rename a
project or tweak a context filter.

| Discoverable (do NOT hardcode) | Discover with |
|---|---|
| Which projects exist | `task _projects` |
| Which tags exist | `task _tags` |
| Which contexts exist and their filters | `task context list` |
| Which UDAs exist and their types/values | `task show uda.` / `task _udas` |
| Default report, aliases, custom reports | `task _get rc.default.command`, `task show report.`, `task show alias.` |
| Active hooks | `ls "$(task _get rc.hooks.location)"` |
| Sync configuration | `task show taskd.` / `task show sync.` |
| Built-in virtual tags (`+OVERDUE`, `+ACTIVE`, ...) | universal Taskwarrior knowledge |

| Not discoverable (write it down) |
|---|
| What each project/tag/context **means** in your life |
| Why you defined a UDA and what its values **represent** |
| What "critical", "important", "soon" mean to you |
| Working hours and how to interpret "today" / "this week" |
| Personal rules the agent should respect (e.g. "I curate `+next` manually") |

### Setup

1. Find the template bundled with the skill and copy it to the config
   directory:
   ```bash
   mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/pi-clanker"
   # Locate the skill (adjust path if installed elsewhere)
   cp ~/.pi/agent/git/github.com/Rahlir/clanker-stuff/skills/taskwarrior/taskwarrior.local.example.md \
      "${XDG_CONFIG_HOME:-$HOME/.config}/pi-clanker/taskwarrior.local.md"
   ```
2. Fill in the sections that apply, following the discoverable-vs-not
   table above. Delete sections you have nothing non-obvious to record
   for.
3. The agent will read it automatically the next time you invoke the
   skill.

The file lives outside the package directory, so it is never overwritten
by `pi update` and never committed to any repo.

The skill works without `taskwarrior.local.md`. The agent will still
discover your projects, tags, contexts, and UDAs live, but it will have
to guess at what they **mean** and ask you to confirm subjective terms
like "critical" each session.

## Example Prompts

- "What should I work on next?"
- "Show me overdue work tasks ranked by urgency."
- "Plan my day."
- "Add a task: write quarterly review, work.admin project, due Friday, deep tag."
- "Mark task 12 done."
- "Annotate task 18 with 'spoke to Alex, will follow up Monday'."
- "I have 30 minutes at the computer, what should I do?"
- "Walk me through a weekly review."
- "What's slipping?"
- "Switch to the work context."

## Important Notes

- **Numeric task ids are not stable.** The agent uses UUIDs for any
  deferred or scripted operation.
- **Destructive operations require confirmation.** Delete, purge, undo,
  bulk modify, recurring template edits, import, and sync are never
  auto-run.
- **`rc.confirmation` is respected.** The agent will not silence
  Taskwarrior prompts to push through.
- **`task edit` is not invoked from the agent.** It opens `$EDITOR` and
  blocks. The agent will tell you to run it yourself.
- **Sync is manual only.** The agent will not run `task synchronize`
  unless you explicitly ask.

## Files

- `SKILL.md` ‑ generic, agent-facing instructions, safety rules, and
  Quick Reference.
- `taskwarrior.local.example.md` ‑ template for the local config; your
  filled-in copy lives at
  `${XDG_CONFIG_HOME:-$HOME/.config}/pi-clanker/taskwarrior.local.md`.
- `references/commands.md` ‑ everyday CLI reference: filter grammar, reads,
  writes, JSON+jq pipelines, common pitfalls, exit codes.
- `references/advanced.md` ‑ rare features loaded only when triggered:
  context definition, recurrence, dependencies, custom UDAs, hooks, sync,
  configuration, import, backup.
- `references/assistant_patterns.md` ‑ personal-assistant recipes (daily
  plan, weekly review, overdue triage, focus block suggestions, project
  health).
