# Jira Skill

Natural language Jira interaction through the [`jira` CLI](https://github.com/ankitpokhrel/jira-cli).

## What It Does

This skill helps an AI agent use Jira conversationally while relying only on the local `jira` command.

It can help with:

- Viewing issues
- Listing and searching tickets
- Creating issues
- Assigning, updating, and transitioning issues
- Adding comments
- Checking sprints
- Creating Stories or Tasks under epics using `--parent EPIC-KEY`

## Prerequisites

This skill requires the `jira` CLI to already be installed and configured.

The agent must not install, upgrade, or configure the CLI unless the user explicitly asks it to perform setup. If `jira` is missing, the agent should stop and provide setup instructions for the user to run.

Suggested user-run setup:

```bash
brew install ankitpokhrel/jira-cli/jira-cli
jira init
jira me
```

Linux and other installation options are available from the project releases:
https://github.com/ankitpokhrel/jira-cli/releases

## Example Prompts

- "Show me PROJ-123"
- "List my open tickets"
- "Create a bug for the login timeout"
- "Create a story under epic PROJ-100"
- "Move PROJ-123 to Done"
- "Assign PROJ-123 to me"
- "Add a comment to PROJ-123"
- "What's in the current sprint?"

## Important Notes

- To place a Story or Task under an epic, use `--parent EPIC-KEY`.
- Do not use `--custom` for Epic Link.
- The agent should ask before modifying Jira tickets.
- The agent should fetch current issue state before updating or transitioning tickets.

## Files

- `SKILL.md`: agent instructions, workflow rules, and safety constraints.
- `references/commands.md`: detailed `jira` CLI command reference and examples.
