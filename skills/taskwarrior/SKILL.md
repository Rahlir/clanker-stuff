---
name: taskwarrior
description: Use when the user wants to manage their personal task list with Taskwarrior, e.g. "what should I work on next", "what's overdue", "add a task to ...", "mark task 12 done", "show my work tasks", "weekly review", or otherwise mentions tasks, todos, projects, or the `task` CLI. The user is the owner of the task list; the agent acts as a personal assistant for it, never as the task list's owner.
---

# Taskwarrior

Personal-assistant interface to the user's Taskwarrior task list using the local `task` CLI.

The user owns the task list. The agent's job is to read it, summarize it, prioritize it, and apply changes the user has approved. Never treat the task list as the agent's own todo list, never invent tasks the user did not ask for.

## Environment

Taskwarrior 3.x with a local replica of the user's REAL task list, synced
across deployments via a self-hosted taskchampion sync server. The same
skill runs in several places:

- **User machines** (workstation / laptops): `task` installed natively;
  config and data resolve through the standard mechanisms
  (dotfiles-managed `taskrc`, XDG paths). No environment overrides.
- **Chatbot sandbox**: `task` is preinstalled; `TASKDATA` and `TASKRC`
  point into a persistent mount and are preset in the environment.

Rules, everywhere:

- Never override or unset `TASKDATA` / `TASKRC` when they are set, and
  never hardcode database paths; let the environment decide.
- Every replica is the same real, synced task list - not a scratch
  database. Treat every write accordingly.
- If `task` fails because config is missing, report that this deployment
  has not been set up yet (dotfiles not applied, or sandbox seed not run)
  instead of creating config yourself.

Project: https://taskwarrior.org

## Local Configuration

Before answering any question, read `${XDG_CONFIG_HOME:-$HOME/.config}/pi-clanker/taskwarrior.local.md`. It captures **only what cannot be discovered by running `task`**:

- What each project, tag, and context **means** in the user's life
- The **purpose** and value semantics of any custom UDAs
- The user's personal definitions of "critical", "important", "soon"
- Working hours and how to interpret "today" / "this week"
- Personal rules (e.g. "I curate `+next` manually, never auto-add it")

Discoverable state lives in the database, not in `taskwarrior.local.md`. Always discover it live, every session, with the helpers below. Do not memorize it across turns either; project lists and contexts can change between calls.

```bash
task _projects                  # current project names
task _tags                      # current tag names (user + virtual)
task context list               # contexts and their filters
task context show               # which context is active
task _udas                      # custom UDA names
task show uda.                  # UDA types, labels, allowed values
task _get rc.default.command    # default report when user runs bare `task`
task show report.               # custom report definitions
task show alias.                # aliases
ls "$(task _get rc.hooks.location)" 2>/dev/null   # active hooks
```

If `${XDG_CONFIG_HOME:-$HOME/.config}/pi-clanker/taskwarrior.local.md` does not exist:

1. Tell the user the local config is missing. Point at `taskwarrior.local.example.md` in this skill's directory as a template to copy to `~/.config/pi-clanker/taskwarrior.local.md` (or `$XDG_CONFIG_HOME/pi-clanker/taskwarrior.local.md`).
2. Discover live state with the helpers above so you can still answer the current question.
3. When the answer depends on subjective meaning ("what's critical", "what's a work task"), state the assumption you are making and ask the user to confirm. Suggest they record the answer in `taskwarrior.local.md` for next time.

All concrete project / tag names in this skill file are placeholders. Resolve them from `taskwarrior.local.md` (for meaning) and live discovery (for which ones currently exist).

---

## Read vs Write

Taskwarrior commands fall into two camps. Treat them very differently.

**Read commands** (safe, run freely):
`task list`, `task next`, `task <filter> export`, `task projects`, `task tags`, `task summary`, `task active`, `task burndown.*`, `task calendar`, `task history.*`, `task ghistory.*`, `task stats`, `task count`, `task ids`, `task uuids`, `task _projects`, `task _tags`, `task _context`, `task _udas`, `task show`.

**Write commands** (state-changing):
`task add`, `task modify`, `task annotate`, `task denotate`, `task append`, `task prepend`, `task done`, `task start`, `task stop`, `task delete`, `task purge`, `task undo`, `task duplicate`, `task edit`, `task config`, `task context define`, `task context delete`, `task import`, `task synchronize`.

For machine-readable parsing of read operations, prefer:

```bash
task <filter> export        # JSON, parse with jq
task _projects              # one project per line
task _tags                  # one tag per line
task _ids <filter>          # space-separated ids
task _uuids <filter>        # space-separated uuids
```

For human display, the formatted reports (`task list`, `task next`, `task ready`) are usually nicer to summarize.

---

## Quick Reference

| Intent | Command |
|--------|---------|
| All pending tasks | `task list` |
| Next actions (urgency-sorted) | `task next` |
| Ready (not blocked, not waiting) | `task ready` |
| Single task detail | `task <id> info` |
| All tasks as JSON | `task export` |
| Filtered as JSON | `task project:work status:pending export` |
| List projects | `task projects` (or `task _projects` for plain) |
| List tags | `task tags` (or `task _tags`) |
| Active (currently started) | `task active` |
| Overdue | `task +OVERDUE list` |
| Due today | `task due:today list` |
| Due this week | `task due.before:eow list` |
| By project | `task project:<name> list` |
| Add task | `task add "Summary" project:<p> +tag due:<date> priority:<H/M/L>` |
| Modify | `task <id> modify <changes>` |
| Annotate (timestamped note) | `task <id> annotate "note text"` |
| Mark done | `task <id> done` |
| Start / stop timer | `task <id> start` / `task <id> stop` |
| Delete (destructive) | `task <id> delete` |
| Undo last change | `task undo` |
| Show contexts | `task context show` |
| Switch context | `task context <name>` / `task context none` |
| Effective config | `task show` |

---

## Triggers

- "what should I work on next"
- "what's most critical for work"
- "add a task to ..."
- "what's overdue / due today / due this week"
- "show my <project> tasks"
- "mark task 12 done" / "I finished ..."
- "annotate task 12 with ..."
- "what am I waiting on"
- "weekly review"
- "switch to work context"

---

## Workflow

### For "what should I do" / "what's important" questions

1. Read `taskwarrior.local.md` for the user's definition of work, personal, critical, etc. If missing, fall back to live discovery and ask.
2. Discover live state you need: `task context show`, `task _projects`, `task _tags` as relevant.
3. Translate the user's framing ("work", "critical") through the meanings recorded locally into concrete filters.
4. Run a focused query. Default ordering should follow Taskwarrior's built-in `urgency` (which combines priority, age, due, tags, dependencies). `task next` is usually the right starting point.
5. Pull JSON when you need to summarize structured fields:
   ```bash
   task <filter> export | jq '.[] | {id, description, project, due, urgency, tags}'
   ```
6. Present a short, ranked summary. Surface: id, description, project, due, urgency, blockers. Do not dump 50 lines of report output unless asked.
7. For deeper review patterns (daily plan, weekly review, overdue triage, "what's slipping"), load `references/assistant_patterns.md`.

### For adding a task

1. Confirm the description with the user if it is ambiguous.
2. Resolve project, tags, due date, and priority from local conventions when the user did not state them. Ask if any are non-obvious.
3. Build the command. Always quote the description.
4. Run it. `task add` returns `Created task N.` Capture that ID and immediately echo `task <N> info` so the user sees what got created.
5. If the user described several tasks in one breath, add them one at a time, not in a loop you cannot inspect.

### For modifying a task

1. Show current state first: `task <id> info`.
2. State the change in plain language: "I'll set due:friday and add +urgent."
3. Run `task <id> modify <changes>`.
4. Show the result: `task <id> info`.

### For marking done

1. Show what you are about to complete: `task <id> info`.
2. Run `task <id> done`.
3. Confirm completion. If the task was recurring, mention that the next instance will appear on its schedule.

### For destructive operations

See the **Destructive Operations** section below. Always confirm.

---

## Filter Discipline

Taskwarrior filters are positional and powerful, which means they are also easy to misuse.

- **Numeric IDs are not stable.** They get reassigned as tasks complete. Two `task` calls minutes apart can refer to different tasks with the same id. For any modification the user did not explicitly initiate by id in the same turn, prefer the UUID:
  ```bash
  task <id> _uuids       # get the UUID
  task <uuid> modify ...
  ```
- **Always count first** when a filter could match multiple tasks:
  ```bash
  task <filter> count
  ```
  If the count is more than 1, surface the list and the count to the user before running the modification.
- **`status:pending` is the default for most reports** but not for `export` or `count`. When the user says "all my tasks", clarify whether they mean pending only or include completed/deleted.
- **`+TAG` includes, `-TAG` excludes.** Virtual tags (uppercase) like `+OVERDUE`, `+ACTIVE`, `+BLOCKED`, `+UNBLOCKED`, `+WAITING`, `+CHILD`, `+PARENT` are computed; do not try to set them.
- **Date attributes accept named values:** `today`, `tomorrow`, `eod`, `eow`, `eom`, `monday`, `friday`, `now`, `2025-01-15`, `2025-01-15T17:00`, `1week`, `+3d`. Use `due.before:`, `due.after:`, `due.over:`, `due.under:` for ranges.

---

## Contexts (brief)

Contexts are saved filters that scope every read and write until cleared. The everyday ops (`show`, `list`, `<name>`, `none`) are in the Quick Reference above. When the user references a category that maps to an existing context (e.g. they say "work" and a `work` context exists), prefer activating the context over duplicating its filter inline.

For defining / deleting contexts, read/write filter splits, or bypassing the active context for a single call, load `references/advanced.md`.

---

## Urgency, Priority, Due

Taskwarrior computes a numeric `urgency` per task from configurable coefficients (priority, age, due proximity, tags, project, dependencies, annotations, active state). It is the default sort key for `task next`.

- `priority:H`, `priority:M`, `priority:L`, `priority:` (clear) are the only built-in priority values.
- `due:` accepts the date forms above. Setting `due:` triggers urgency boosts as the date approaches.
- To filter by computed urgency: `task urg.over:10 list` or `task urg.under:5 list`.
- The user's personal definitions of "critical" / "important" / "soon" live in `taskwarrior.local.md`. Use them verbatim if present. If absent, default to: overdue first, then `due.before:eow` and `priority:H`, then highest urgency. Tell the user once that you used defaults and offer to record their preferred definitions.

---

## Destructive Operations

These need explicit user approval each time. Show the affected tasks and the exact command before running.

**`task <filter> delete`**
- Deletes are reversible only with `task undo` and only until the next mutating command (and only one step back).
- If the filter is non-trivial (anything beyond a single id), run `task <filter> count` and `task <filter> list` first, present the list, and ask for confirmation.
- Never bypass `rc.confirmation` with `rc.confirmation=off` to silence a prompt.

**`task <filter> purge`**
- Permanently removes already-deleted tasks from the database. No undo. Only run with explicit user request and confirmation.

**`task undo`**
- Reverts the most recent change in the local database.
- Before running, describe what the most recent change was. The user may have done unrelated work between the change you want to undo and now.
- After running, show the current state of the affected task.

**`task <filter> modify` matching multiple tasks**
- If `task <filter> count` returns more than 1, treat as bulk. Show the count and a sample list, get explicit approval, then run.
- Be explicit if the modification touches a recurring template (`+PARENT`): changes propagate to all future instances.

**`task <filter> done` matching multiple tasks**
- Same rule as modify: count, sample, confirm.

**Recurring task templates**
- A task with `recur:` and `+PARENT` is the template; visible instances are `+CHILD`. Editing the parent affects all future children. Editing or completing a child affects only that occurrence.
- If the user asks to "delete that recurring task", clarify: only this occurrence (delete the child id) or the whole series (delete the parent uuid)?

**`task edit <id>`**
- Opens `$EDITOR` on the raw task representation. Do not invoke from the agent unattended; it will hang or corrupt the task. Tell the user to run it themselves.

**`task synchronize`**
- **Exception: sync is routine in this deployment** (local replicas on every machine and the chatbot sandbox, self-hosted taskchampion sync server). Run `task synchronize` silently at the **start and end of any session that reads or writes tasks**, so other replicas always see current state.
- Only surface sync output when it fails. On failure: report it plainly, continue working locally (changes sync later), do not retry in a loop.
- Do not spam sync between individual commands within a session.

**`task import`**
- Imports JSON. Can create or overwrite tasks in bulk. Always show the file and a preview of `jq length` and a sample object before running.

**`task config`**
- Edits `$TASKRC`. Treat as configuration changes the user must initiate.

---

## NEVER

- **NEVER** treat the user's task list as your own. Do not add tasks, mark tasks done, or change priorities to reflect what the agent thinks should happen. Only act on explicit user intent.
- **NEVER** delete or purge without showing the affected tasks and getting explicit approval.
- **NEVER** modify a filter that could match multiple tasks without first running `task <filter> count` and surfacing the result.
- **NEVER** edit `$TASKRC` or files under `$TASKDATA/` directly. Use `task config` only when the user asks to change configuration.
- **NEVER** silence confirmation prompts with `rc.confirmation=off` or `rc.bulk=0` to avoid a question. The prompt is there for a reason.
- **NEVER** invoke `task edit` from the agent. Tell the user to run it.
- **NEVER** end a task-touching session without syncing (or telling the user the sync failed).
- **NEVER** run `task import` against an unverified file. Preview the JSON first.
- **NEVER** assume numeric ids are stable across CLI invocations. Use UUIDs for any deferred or scripted operation.
- **NEVER** invent project names, tags, contexts, or UDAs. If the user references something not present in the local config or live `task _projects` / `task _tags` output, ask.
- **NEVER** install, upgrade, or reconfigure Taskwarrior unless the user explicitly asks.

---

## Safety

- Show the `task` command before running it.
- Auto-run safe writes for single tasks: `task add`, `task <id> annotate`, `task <id> done`, `task <id> start`, `task <id> stop`, `task <id> modify` for a single id.
- Get explicit approval before any destructive operation (delete, purge, undo, multi-match modify/done, recurring template edits, import, config).
- After a write, surface the resulting state (`task <id> info` or a short list).
- If a Taskwarrior command exits non-zero or prints "No matches", report it plainly. Do not retry with looser filters silently.

---

## Deep Dive

Three reference files, loaded only when triggered. Do not preload.

**LOAD `references/commands.md` when:**
- Building filters beyond simple `project:` / `+tag` / `due:`.
- Writing JSON pipelines through `task export | jq`.
- Needing the full attribute / tag / date filter grammar.
- Troubleshooting CLI errors, exit codes, or quoting / id-reshuffle pitfalls.

**LOAD `references/advanced.md` when:**
- Defining or deleting contexts, or doing read/write filter splits.
- Setting up recurring tasks or editing a series vs an instance.
- Working with dependencies (blocked / blocking chains).
- Discovering, configuring, or suggesting custom UDAs.
- Inspecting or reasoning about hooks.
- Running sync, import, configuration changes, or backup.

**LOAD `references/assistant_patterns.md` when:**
- The user asks for a daily plan, weekly review, overdue triage, or any "what should I do" question deeper than a single `task next` call.
- You need to combine urgency, due date, project, and tags into a ranked summary.
- The user wants a recurring review ritual.

**Do NOT load references for:**
- Simple show / list / add / done / annotate operations covered by the Quick Reference.
- Single-task info display.
- Activating or clearing an existing context.

| Task | Load |
|------|------|
| `task next` summary | none |
| Add a task with project + tag + due | none |
| Modify or mark a single task done | none |
| Activate an existing context | none |
| Filters beyond `project:` / `+tag` / `due:` | `commands.md` |
| JSON export + jq pipeline | `commands.md` |
| Common pitfalls / exit codes / quoting | `commands.md` |
| Daily plan / weekly review / triage | `assistant_patterns.md` |
| "What should I focus on" with ranking | `assistant_patterns.md` |
| Define / delete a context | `advanced.md` |
| Recurring task setup or edit | `advanced.md` |
| Dependency graph / blocked-by chain | `advanced.md` |
| Custom UDA discovery or new UDA config | `advanced.md` |
| Hooks, sync, import, `task config`, backup | `advanced.md` |
