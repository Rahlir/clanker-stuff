# Commands Reference

`task` CLI reference for everyday operations: filters, reads, writes, JSON
pipelines, common pitfalls.

For rare features (defining contexts, recurrence, dependencies, custom
UDAs, hooks, sync, configuration edits, import, backup), see
`advanced.md`.

---

## Filter Grammar

Taskwarrior filters are space-separated terms applied left of the command
word. They AND together by default. Examples:

```bash
task project:work +urgent due.before:eow status:pending list
```

### Attribute filters

| Form | Meaning |
|------|---------|
| `project:work` | exact match |
| `project.not:work` | not equal |
| `project.is:work` | exact match (alias) |
| `project.isnt:work` | not equal (alias) |
| `project.has:cli` | substring contains |
| `project.hasnt:cli` | substring excludes |
| `project.startswith:per` | prefix |
| `project.endswith:.api` | suffix |
| `project.word:client_a` | word boundary match |
| `description.contains:login` | regex/substring |
| `due:today` | date equality |
| `due.before:tomorrow` | date strictly before |
| `due.after:monday` | date strictly after |
| `due.over:1week` | older than |
| `due.under:3d` | newer than |
| `due.any:` | has any value |
| `due.none:` | has no value |
| `urg.over:10` | numeric greater than |
| `urg.under:5` | numeric less than |

### Tag filters

```bash
task +work               # has tag work
task -waiting            # does not have tag waiting
task +work -waiting      # AND
task +OVERDUE            # virtual tag
```

### Logical operators

```bash
task '(project:work or project:learn)' list
task project:work and +urgent list
task project:work xor +waiting list
```

### ID, UUID, and ranges

```bash
task 12 list             # single id
task 12,15,17 list       # comma list
task 10-20 list           # range
task 9b1d2c3a-... list   # UUID prefix or full
```

### Status

`pending`, `completed`, `deleted`, `waiting`, `recurring`. Most reports
default to `pending`. `export` and `count` do not filter status by default.

```bash
task status:completed end.after:2024-01-01 export
```

### Date forms

| Form | Meaning |
|------|---------|
| `today`, `yesterday`, `tomorrow` | calendar day |
| `now` | current instant |
| `sod`, `eod` | start / end of day |
| `sow`, `eow` | start / end of week |
| `som`, `eom` | start / end of month |
| `soy`, `eoy` | start / end of year |
| `monday` ... `sunday` | next named day |
| `2025-01-15` | ISO date |
| `2025-01-15T17:00` | ISO datetime |
| `+3d`, `+2w`, `+1m`, `+1y` | relative future |
| `-1d` | relative past |
| `1week`, `2hours` | duration |

---

## Reading

### List & report variants

```bash
task list                  # default pending list
task next                  # urgency-sorted next actions
task ready                 # not blocked, not waiting, eligible to work on
task all                   # everything regardless of status
task waiting               # waiting status (deferred)
task blocked               # blocked by a dependency
task blocking              # blocking another task
task active                # currently started
task completed             # done tasks
task recurring             # recurrence templates
task minimal               # compact view
task long                  # wide view
task summary               # by-project completion summary
```

### Detail & metadata

```bash
task <id> info             # full task detail incl. urgency breakdown
task <id> stats            # global database statistics (no id needed)
task diagnostics           # config, hooks, paths, versions
task show                  # effective configuration
task show report.          # all report.* config
task show urgency.         # all urgency.* coefficients
task show uda.             # all uda.* config
```

### Helper commands (script-friendly)

```bash
task _projects             # one project per line
task _tags                 # one tag per line
task _context              # one context per line
task _udas                 # one UDA per line
task _commands             # all commands and aliases
task _columns              # available columns
task _config               # all config keys
task _ids <filter>         # space-separated ids matching filter
task _uuids <filter>       # space-separated uuids matching filter
task _get <task>.<attr>    # single field, e.g. task _get 12.uuid
task _urgency <filter>     # urgency values
```

### JSON export + jq

`task export` is the right entry point for any structured analysis.

```bash
task export                                           # all tasks
task status:pending export                            # pending only
task project:work export | jq length                  # count
task +OVERDUE export | jq '.[] | {id, description, due, urgency}'

# Top 10 by urgency
task status:pending export | jq 'sort_by(-.urgency) | .[:10] |
  .[] | {id, urg: .urgency, desc: .description, due, project}'

# Group counts by project
task status:pending export | jq 'group_by(.project)
  | map({project: .[0].project, count: length})'

# All projects flattened from JSON
task export | jq -r '.[].project // empty' | sort -u
```

JSON object fields: `id`, `uuid`, `description`, `entry`, `modified`,
`status`, `project`, `tags` (array), `urgency`, `due`, `start`, `end`,
`scheduled`, `until`, `wait`, `priority`, `depends` (array of UUIDs),
`annotations` (array of `{entry, description}`), `recur`, `imask`, `mask`,
`parent`, plus any UDAs.

---

## Writing

### Add

```bash
# Minimal
task add "Pay invoice"

# Rich
task add "Write quarterly review" \
  project:work.admin \
  +deep +next \
  due:friday \
  scheduled:wednesday \
  priority:H

# With future date
task add "Renew passport" project:personal.admin due:2025-06-01

# Set a UDA on add
task add "Implement login flow" project:work.client_a estimate:120 jira:PROJ-123

# Quote attribute values containing spaces
task add "Buy birthday card" project:personal.errands tags:errand description:"Buy birthday card for Alex"
```

### Modify, append, prepend

```bash
task <id> modify project:work due:tomorrow priority:H +urgent
task <id> modify -waiting               # remove a tag
task <id> modify project:                # clear an attribute
task <id> modify due:                    # remove due date
task <id> append "extra context"         # appends to description
task <id> prepend "[BLOCKED] "           # prepends to description
```

### Annotate / denotate

Annotations are timestamped notes, separate from the description.

```bash
task <id> annotate "spoke to Alex, will follow up Monday"
task <id> denotate "spoke to Alex"        # removes matching annotation
```

### Done / start / stop / duplicate

```bash
task <id> done
task <id> start                          # marks active, +ACTIVE virtual tag
task <id> stop
task <id> duplicate project:other        # copy with overrides
```

### Delete & purge

```bash
task <id> delete                         # soft delete, undoable
task status:deleted purge                # permanent removal, no undo
```

### Undo

```bash
task undo
```

Reverts the most recent transaction. Only one step. Cannot undo `purge`.
Not a substitute for a backup before bulk operations.

### Custom UDAs in writes

Custom UDAs (defined in `$TASKRC`) are used like any other attribute:

```bash
task <id> modify estimate:30 energy:low
task estimate.over:60 list
```

To discover what UDAs exist and configure new ones, see `advanced.md`.

---

## Common Pitfalls

- **`task done` with no id silently does nothing useful.** It applies to the
  default filter (often empty) and may operate on more tasks than intended.
  Always provide an id or explicit filter.
- **`task add` description quoting.** Without quotes, the shell may swallow
  attribute-looking words. Always quote the description.
- **Numeric ids reshuffle.** After a `done`/`delete`, ids may renumber.
  Re-fetch ids before a follow-up operation.
- **`task export` does not honor the default report filter.** It returns
  everything matching the filter you provide, regardless of `default.command`.
- **Virtual tags cannot be set.** `+OVERDUE`, `+ACTIVE`, etc. are computed.
  Trying to `task <id> modify +OVERDUE` is an error.
- **`task edit`** opens `$EDITOR` and blocks. Do not invoke from the agent.
- **`rc.confirmation=off` is a footgun.** Do not pass it to dodge prompts.
- **Time zones.** Date parsing uses the local time zone of the shell. If the
  user is traveling, the result of `due:today` may surprise them.

---

## Exit Codes

- `0` ‑ success
- `1` ‑ generic error (no matches, parse error, etc.)
- `2` ‑ runtime error (database, hook failure, sync error)

Always check the exit code of writes. A non-zero exit means the task was
likely not modified.
