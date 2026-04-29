---
name: big-feature-workflow
description: Structured workflow for large features and refactors. Use only when the user explicitly asks to use the big feature workflow.
---

# Big Feature Workflow

This skill provides a structured workflow for AI coding agents working on large
features or large refactors that may span multiple iterations.

The workflow is centered around persistent documentation in `docs/ai/` so that
planning, implementation, and later review can build on shared artifacts.

## Feature name

Before doing any work, identify a short and stable feature name.

Use a concise lowercase kebab-case identifier, for example:
- `info-layout-refactor`
- `query-rework`
- `bulk-import-api`

Derive the feature name from the user request when it is obvious.
If multiple names are plausible, propose one and ask the user to confirm.

## Files to use

Use these files under `docs/ai/`:

```text
docs/
  ai/
    <feature_name>_plan.md
    <feature_name>_tasks.md
    <feature_name>_devlog.md
```

- `docs/ai/<feature_name>_plan.md`: implementation plan and execution model
- `docs/ai/<feature_name>_tasks.md`: task graph for `task-driven` execution
  (optional for `direct` execution)
- `docs/ai/<feature_name>_devlog.md`: session log (Implement mode) and
  summary (Review mode)

Create `docs/ai/` if missing.

### File lifecycle

- `_devlog.md`: permanent record - append only, never rewrite past entries
- `_tasks.md`: ephemeral tracking artifact - exists only while work is in
  progress
- `_plan.md`: design record - captures rationale and scope boundaries that
  the devlog does not

## Resuming work

When the user asks to continue work on a feature that already has artifacts in
`docs/ai/`, read all existing files for that feature (`_plan.md`, `_tasks.md`,
`_devlog.md`) before entering any mode. Use past session log entries and task
state to understand what has already been done. If multiple features have
artifacts in `docs/ai/`, ask which one. Then proceed with the requested mode.

## Three modes of operation

When using this skill, always operate in exactly one of these modes:

1. Plan
2. Implement
3. Review

If the user does not clearly specify the mode, stop and ask.

The user may refer to the modes indirectly. For example:
- "Use the big feature workflow to plan the query rework" -> Plan mode
- "Now implement the next unblocked tasks" -> Implement mode
- "Check whether the implementation matches the plan" -> Review mode

## Terminology

A **session** is one complete unit of work in Implement mode: selecting tasks
(or a slice), implementing them, and finalizing tracking artifacts. A session
may include back-and-forth with the user (clarifications, corrections,
rework) but ends when the selected scope is done and the devlog entry is
written.

## Universal rules

Do not perform git operations (commit, branch, push, etc.) unless the user
explicitly asks.

Mode changes are user-initiated.

Announce the active mode and feature name on a single line:
- when entering or switching modes (e.g. `Plan mode, feature `query-rework``)
- when tracking artifacts are finalized at the end of work in that mode:
  - Plan mode: after `_plan.md` (and `_tasks.md` if applicable) is written
  - Implement mode: after task statuses and the devlog `## Session Log` entry
    are written
  - Review mode: after task markers are corrected and the devlog `## Summary`
    is updated

Do not repeat the announcement on every response within a mode.

Stop and ask the user if:
- the mode is unclear
- the feature name is unclear

---

## Plan mode

When the user asks you to plan the work, you are operating in Plan mode.

In this mode, your responsibility is to analyze the problem and write the
workflow documents needed for later implementation.

### Allowed edits

In Plan mode, you may only create or modify:

- `docs/ai/<feature_name>_plan.md`
- `docs/ai/<feature_name>_tasks.md`

Do not edit source code, tests, configs, or any other files in Plan mode.

### Goal

The goal of Plan mode is to produce a concrete, implementation-oriented plan
and choose the execution model for later implementation.

### Execution model decision

In Plan mode, choose exactly one execution model and record it in
`docs/ai/<feature_name>_plan.md`:

- `task-driven` (default): create `docs/ai/<feature_name>_tasks.md`
- `direct` (small scoped work): do not create tasks file

Use `direct` only when work is small, low-risk, and can be implemented in a
single session without dependency tracking. Direct mode is strictly
single-session: if the work does not fit, return to Plan mode and switch to
`task-driven`.

### How to work in Plan mode

To produce a high-quality plan:

- Always analyze first
  - inspect the relevant code
  - inspect existing documentation, ADRs, and related artifacts
  - identify affected components, boundaries, dependencies, and risks
- Clarify ambiguity before writing the plan
  - ask the user questions if requirements, constraints, or scope are unclear
- Keep the plan concrete and concise
  - include only context that helps future implementation
  - avoid repeated summaries and generic filler
- Focus on design and execution guidance
  - describe the intended end state
  - identify likely files, modules, or subsystems that will need changes
  - call out important constraints, patterns, or migration concerns
- Split larger work into phases
  - unless the task is genuinely small, the plan should describe multiple
    phases or implementation steps

### What the plan should contain

Read `{baseDir}/templates/plan-template.md` and use it as the structural
reference for `docs/ai/<feature_name>_plan.md`. Sections marked optional in the template may
be omitted when empty.

Do not turn the plan into full code.
Your responsibility is to provide high-level implementation guidance, not to
pre-write the entire change line by line.

### What the tasks file should contain

Read `{baseDir}/templates/tasks-template.md` and use it as the structural
reference for `docs/ai/<feature_name>_tasks.md`. The status legend and dependency
conventions defined in that template are normative and must be followed so
that later modes can reliably parse task state.

Tasks should be:
- small and actionable
- independently reviewable where possible
- dependency-aware
- aligned with the phases in `<feature_name>_plan.md` so progress traces
  back to the plan
- detailed enough that implementation can proceed incrementally without
  re-planning the whole feature

Avoid vague tasks such as:
- "implement backend"
- "finish frontend"
- "do refactor"

Prefer concrete tasks such as:
- "Refactor query builder to support grouped filters"
- "Add request validation for bulk import payload"
- "Update info layout state handling for async loading"

### Stop conditions

Stop and ask the user if:

- the scope is too ambiguous to produce a reliable plan
- the user asks for source-code changes while in Plan mode

### Done criteria

Plan mode checklist:
- `docs/ai/<feature_name>_plan.md` exists, is actionable, and declares
  execution model (`task-driven` or `direct`)
- `docs/ai/<feature_name>_tasks.md` exists for `task-driven` plans
- no source files modified

---

## Implement mode

When the user asks you to implement work from the plan, you are operating in
Implement mode.

In this mode, your responsibility is to execute implementation work from the
plan. In `task-driven` execution, complete one or more unblocked tasks from
`docs/ai/<feature_name>_tasks.md` and keep task state in sync with reality.
In `direct` execution, implement the entire plan in a single session without
task tracking. In both cases, record what you did in the devlog.

### Allowed edits

In Implement mode, you may create or modify:

- source code, tests, configs, and any other project files needed to complete
  the selected implementation scope
- `docs/ai/<feature_name>_tasks.md` (status updates only, task-driven mode)
- `docs/ai/<feature_name>_devlog.md` (append to `## Session Log` only)

You must not:

- modify `docs/ai/<feature_name>_plan.md`
- modify the `## Summary` section of `docs/ai/<feature_name>_devlog.md`
- rewrite past entries in `## Session Log`
- restructure the tasks file (no renaming, reordering, or removing tasks);
  only update the status marker when the tasks file exists

### Goal

Complete one small, reviewable implementation increment from the plan.

### How to work in Implement mode

1. Read `docs/ai/<feature_name>_plan.md` in full.
2. Resolve execution model:
   - if `docs/ai/<feature_name>_tasks.md` exists: `task-driven`
   - if tasks file does not exist: require `Execution Model` with
     `Mode: direct`
   - if ambiguous: stop and ask
3. Choose session scope:
   - `task-driven`: read tasks file, find unblocked `[ ]` tasks (dependency
     rules from `{baseDir}/templates/tasks-template.md`), and either use
     user-requested unblocked tasks or pick the next unblocked logical group;
     prefer 1-4 tightly related tasks per session, erring toward fewer when
     they involve complex logic or cross-component changes;
     if multiple plausible groupings exist, stop and ask
   - `direct`: the session scope is the entire plan (single session)
4. Mark selected tasks `[~]` before coding (`task-driven` only).
5. Implement within selected scope. Do not silently expand scope.
6. Run the narrowest relevant verification commands per `AGENTS.md` /
   `CLAUDE.md`.
7. Finalize tracking artifacts:
   - `task-driven`: set each selected task to `[x]`, `[~]`, `[!]`, or `[ ]`
     as appropriate; `[!]` is for external blockers only; if a task remains
     `[~]`, devlog must include done, remaining, and why
   - ensure `docs/ai/<feature_name>_devlog.md` exists (read
     `{baseDir}/templates/devlog-template.md` and create from it if missing)
   - append a new `## Session Log` entry; for direct execution use
     `Tasks completed: n/a - direct mode`

### Deviation policy

- Minor deviations are acceptable. Record them under `Deviations from plan`.
- Significant deviations (design change, new affected components, phase
  changes) require returning to Plan mode. Stop and tell the user.
- Newly discovered work goes to `Follow-ups`. Do not add tasks in Implement
  mode.

### Stop conditions

Stop and ask the user if:

- `docs/ai/<feature_name>_plan.md` does not exist
- `docs/ai/<feature_name>_tasks.md` does not exist and the plan does not set
  `Execution Model` to `Mode: direct`
- in `task-driven` mode, there are no unblocked tasks
- in `task-driven` mode, user-requested tasks are blocked or have unmet
  dependencies
- the implementation requires significant deviation from the plan
- in `direct` mode, the work cannot be completed in the current session
  (return to Plan mode and recommend switching to `task-driven`)
- verification fails in a way you cannot resolve within the selected scope

### Done criteria

Implement mode checklist:
- in `task-driven` mode, each selected task has an accurate final status
  (`[x]`, `[~]`, `[!]`, or `[ ]`)
- one new `## Session Log` entry appended in the devlog
- relevant verification commands run and results recorded

---

## Review mode

When the user asks whether implementation matches the plan, you are in Review
mode.

Review mode verifies plan fidelity and completion state. Check the plan
against actual implementation, validate task markers if a tasks file exists,
and update the devlog summary. This is not a general code review.

### Allowed edits

You may:
- update `## Summary` in `docs/ai/<feature_name>_devlog.md` (replace content)
- correct inaccurate status markers in `docs/ai/<feature_name>_tasks.md` (if
  it exists)

You must not:
- modify source code, tests, configs, or other project files
- modify `docs/ai/<feature_name>_plan.md`
- rename, reorder, add, or remove tasks
- rewrite past `## Session Log` entries

If `docs/ai/<feature_name>_devlog.md` does not exist, read
`{baseDir}/templates/devlog-template.md` and create the devlog from it before
updating `## Summary`.

### Goal

Determine whether implementation matches the documented plan, and report
whether the current state is complete, partial, blocked, or divergent.

### How to work in Review mode

1. Read `docs/ai/<feature_name>_plan.md` in full.
2. Read `docs/ai/<feature_name>_tasks.md` (if present) and
   `docs/ai/<feature_name>_devlog.md` (if present).
3. Inspect relevant implementation artifacts (source, tests, configs).
4. Compare implementation to the plan:
   - phase status: complete, partial, or missing
   - key design and behavioral decisions: followed or materially changed
   - task markers: accurate or inaccurate (if tasks file exists)
5. Correct inaccurate task markers (if tasks file exists).
6. Update devlog `## Summary` status:
   - `complete`: planned scope implemented
   - `partial`: some planned work missing
   - `blocked`: remaining work is externally blocked
   - `divergent`: implementation materially differs from the plan
   - `in progress`: implementation is active but not review-complete
7. Report findings to the user with missing work and material deviations.

The Summary template is oriented toward service architectures. For other
project types (frontend apps, CLI tools, libraries), adapt:
- "External changes" → public-facing changes (UI, routes, CLI flags,
  library API)
- "Consumer impact" → downstream impact on dependents, or omit if none
- "Unchanged surfaces worth noting" → omit if not relevant

### Review focus

Prioritize plan fidelity and completion state: scope, phases, key decisions,
missing work, and task-marker accuracy (if tasks file exists).
Deprioritize style nits, unrelated cleanup, and speculative improvements.

### Deviation policy

- Minor differences that preserve plan intent are acceptable. Note them.
- Significant differences must be called out explicitly; mark status
  `divergent` when material.
- If tasks claim completion not reflected in code, call out the mismatch and
  correct task markers.

### Stop conditions

Stop and ask the user if:

- `docs/ai/<feature_name>_plan.md` does not exist
- the relevant code or artifacts needed for review are missing
- the plan is too vague to verify reliably against the implementation
- the repository state is inconsistent enough that implementation completeness
  cannot be determined with confidence

### Done criteria

Review mode checklist:
- plan compared against actual implementation
- missing, partial, blocked, or divergent work clearly identified
- inaccurate task markers corrected (if tasks file exists)
- devlog `## Summary` updated to current state
- user told final state: complete, partial, blocked, or divergent
