# Advanced Features

Reference for Taskwarrior features that are rare in day-to-day operation but
need depth when they do come up: defining contexts, recurrence, dependencies,
custom UDAs, hooks, sync, configuration, import, backup.

For everyday filters / reads / writes / JSON pipelines, see `commands.md`.

---

## Contexts (Management)

Contexts are saved filters bound to a name, applied to every read and write
until cleared. Day-to-day usage (`show`, `list`, `<name>`, `none`) is in
`SKILL.md`'s Quick Reference. This section covers definition and bypass.

### Define

```bash
# Single filter applied to both reads and writes (write op, confirm)
task context define work project.is:work or project:work.

# Read and write filters separately (Taskwarrior 2.6+)
task context define work \
  rc.context.work.read=project:work \
  rc.context.work.write=project:work
```

When a context is active, `task` adds the read filter to every query and the
write filter to every `add`. Defining a context is a write to `$TASKRC`;
confirm with the user.

### Delete

```bash
task context delete <name>
```

Destructive. Confirm before running.

### Bypass for one call

```bash
task rc.context: list                    # ignore active context for this call
```

Useful inside scripts that need to query across contexts without disrupting
the user's active context.

### Save and restore around a one-off cross-context query

```bash
prev=$(task _get rc.context)
task context other
task list
task context "$prev"
```

---

## Recurrence

Recurring tasks are defined by a parent template carrying `recur:` and
`due:`. Visible instances are children created on demand.

```bash
# Weekly recurring task starting next Monday
task add "Submit timesheet" \
  project:work.admin \
  due:monday \
  recur:weekly \
  until:2026-01-01
```

Common `recur:` values: `daily`, `weekdays`, `weekly`, `biweekly`, `monthly`,
`quarterly`, `semiannual`, `annual`, `monthly+1week`, `14days`, `2hours`.

### Editing a series vs an instance

```bash
task list +PARENT                        # see templates
task <parent_uuid> modify project:new    # affects all future children
task <child_id> modify due:tomorrow      # affects this occurrence only
task <child_id> done                     # completes this occurrence; next appears
task <parent_uuid> delete                # confirm; ends the series
```

Always disambiguate "this occurrence" vs "the whole series" with the user
before editing recurring tasks.

---

## Dependencies

```bash
task <id> modify depends:42              # this depends on 42 (this is blocked)
task <id> modify depends:42,43,44        # multiple
task <id> modify depends:-42             # remove dependency
task blocked                             # tasks blocked by something
task blocking                            # tasks that block something
task <id> info | grep -i depend          # see dependency state of one task

# Visualize a dependency chain via JSON
task export | jq '.[] | select(.depends) | {id, description, depends}'
```

Dependencies use UUIDs internally. The CLI accepts ids and converts them.

---

## UDAs (User Defined Attributes)

UDAs are configured in `$TASKRC`. The agent does not edit `$TASKRC`
directly; if the user wants a new UDA, suggest the config they should add.

### Discover

```bash
task _udas                               # list defined UDA names
task show uda.                           # all uda.* config (types, labels, allowed values)
```

### Use (filters and modifications)

```bash
task estimate.over:60 list
task <id> modify estimate:30 energy:low
task estimate.any: export | jq '[.[].estimate | tonumber] | add'
```

### Suggested config to suggest to the user

```ini
# $TASKRC
uda.estimate.type=numeric
uda.estimate.label=Estimate

uda.energy.type=string
uda.energy.label=Energy
uda.energy.values=low,med,high
```

UDA types: `string`, `numeric`, `date`, `duration`. `values=` is optional and
restricts the allowed set.

---

## Hooks

Hooks live in `$TASKDATA/hooks/` and are scripts named `on-launch-*`,
`on-add-*`, `on-modify-*`, or `on-exit-*`. They run on every relevant
command and can mutate tasks (on-add, on-modify).

The agent should:

- Read `$TASKDATA/hooks/` to know what hooks are active.
- Surface hook output if a write command produces unexpected stderr.
- Not install or edit hooks unless asked.

```bash
ls $TASKDATA/hooks/                        # what hooks exist
task diagnostics | grep -A1 Hooks        # whether hooks are enabled
```

---

## Sync (Taskserver / Taskchampion)

```bash
task synchronize                         # push & pull
task sync init                           # initialize a sync (taskchampion-sync-server)
```

The sync is routine: run silently at the start and end of any task-touching
session (see SKILL.md). Surface failures only; on failure continue locally and
let a later sync catch up. `task sync init` remains a setup operation - only on
explicit user request.

---

## Configuration

```bash
task show                                # all effective config
task show <prefix>.                      # filtered, e.g. task show urgency.
task config <key> <value>                # write to $TASKRC (write op, confirm)
task config <key>                         # remove the key (write op, confirm)
```

Common knobs the user may have set:

| Key | Effect |
|-----|--------|
| `default.command` | what `task` with no args runs (often `next` or `list`) |
| `report.<name>.filter` | default filter for a report |
| `report.<name>.sort` | default sort order |
| `urgency.user.tag.<TAG>.coefficient` | urgency boost for a tag |
| `urgency.user.project.<PROJ>.coefficient` | urgency boost for a project |
| `bulk` | threshold above which Taskwarrior asks before bulk modify |
| `confirmation` | global on/off for confirmation prompts |
| `context` | the active context name |

`task config` writes to `$TASKRC`. Treat as configuration changes the user
must initiate. Never call `task config rc.confirmation off` to dodge a
prompt.

---

## Import

```bash
# Always preview first
jq length tasks.json
jq '.[0]' tasks.json

# Then import
task import tasks.json
```

Import accepts an array of JSON task objects (same shape as `task export`).
If `uuid` is present and matches an existing task, that task is updated.
Otherwise a new task is created.

Always show the file size, the array length, and a sample object to the user
before running `task import`. Suggest a backup first (see below).

---

## Backup & Recovery

```bash
# Where the data lives
task _get rc.data.location               # usually $TASKDATA

# Quick backup
tar czf ~/task-backup-$(date +%Y%m%d).tgz -C ~ .task .taskrc

# Pure data export for portability
task export > tasks.json
```

Suggest these to the user before any large/destructive bulk operation. Do
not run them silently.

`task undo` only reverts the most recent transaction. It is not a
substitute for a backup before a bulk modify or import.
