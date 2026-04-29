# <Feature Name> - Tasks

## Status Legend
- `[ ]` not started (default; includes tasks waiting on dependencies)
- `[~]` in progress
- `[x]` done
- `[!]` blocked by an external issue (missing decision, broken environment,
  dependency that cannot be completed as planned). Do not use `[!]` simply
  because dependencies are incomplete.

A task is *unblocked* when its status is `[ ]` or `[~]` and all dependencies
are satisfied by the rules below. A `[~]` task left from a previous session
represents partially completed work and should be treated as unblocked.
Whether a task is waiting on dependencies is derived from the dependency
graph, not from the status marker.

Dependency resolution rules:
- `Depends on: <task id>` is satisfied only when that task is `[x]`.
- `Depends on: Phase N` is satisfied only when all tasks in Phase N are `[x]`.
- Mixed dependencies (tasks plus phases) require all dependencies to be
  satisfied.
- Tasks marked `[!]` do not satisfy dependencies.

Conventions:
- Task IDs use `<phase>.<sequence>` format (e.g., `1.1`, `2.3`).
- Always include a `Depends on:` line. Use `Depends on: none` when there are no dependencies.
- A dependency may be a task id (`1.2`), a list (`1.1, 1.2`), or a whole phase (`Phase 1`).
- Keep each task small enough to be reviewed in isolation.

## Phase 1: <Short name>

- [ ] **1.1** <Concrete actionable task>
  - Depends on: none
  - Files: `path/to/file`
  - Notes: <optional, only if non-obvious>

- [ ] **1.2** <Concrete actionable task>
  - Depends on: 1.1
  - Files: `path/to/file`, `path/to/other`

## Phase 2: <Short name>

- [ ] **2.1** <Concrete actionable task>
  - Depends on: Phase 1
  - Files: `path/to/file`
