# Big Feature Workflow Skill

Structured workflow for large features and refactors handled by AI coding agents.

This skill helps keep planning, implementation, and review work organized
across one or more sessions by maintaining persistent artifacts in `docs/ai/`.

## When to Use

Use this skill for work that is too large or risky to handle as a single ad hoc
coding request, such as:

- Multi-file features
- Large refactors
- Cross-service or cross-module changes
- Work that needs to be resumed later
- Work that benefits from explicit planning, task tracking, and review

Do not use it for small fixes, quick edits, or simple one-step changes.

The skill is only activated when the user explicitly asks to use the big
feature workflow.

## How It Works

The workflow has three modes:

1. **Plan**
   - The agent analyzes the codebase and writes a concrete implementation plan.
   - No source code is changed.

2. **Implement**
   - The agent implements one small, reviewable slice from the plan.
   - Progress is tracked in task and devlog files.

3. **Review**
   - The agent checks whether the implementation matches the plan.
   - This is a plan-fidelity review, not a general code review.

If the mode is unclear, the agent should stop and ask.

## Generated Files

The workflow stores artifacts under `docs/ai/` (relative to the current working
directory):

```text
docs/ai/<feature_name>_plan.md
docs/ai/<feature_name>_tasks.md
docs/ai/<feature_name>_devlog.md
```

- `_plan.md`: design and implementation plan
- `_tasks.md`: task tracking for task-driven execution
- `_devlog.md`: implementation session log and review summary

The feature name is a short lowercase kebab-case identifier, such as:

- `query-rework`
- `bulk-import-api`
- `info-layout-refactor`

## Example Prompts

Plan a feature:

```text
Use the big feature workflow to plan the query rework.
```

Implement the next slice:

```text
Use the big feature workflow to implement the next unblocked tasks for query-rework.
```

Review against the plan:

```text
Use the big feature workflow to review whether query-rework matches the plan.
```

Resume existing work:

```text
Use the big feature workflow to continue query-rework in implement mode.
```

## Important Notes

- The agent should not perform git operations unless explicitly asked.
- Plan mode should not modify source code.
- Implement mode should not silently expand scope beyond the selected task slice.
- Review mode should not modify source code.
- The devlog is append-only for implementation session entries.

## Files

- `SKILL.md`: agent instructions and workflow rules.
- `templates/plan-template.md`: structure for generated plan files.
- `templates/tasks-template.md`: structure and status rules for generated task files.
- `templates/devlog-template.md`: structure for implementation logs and review summaries.
