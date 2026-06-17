---
name: jira
description: Use when the user mentions Jira issues (e.g., "PROJ-123"), asks about tickets, wants to create/view/update issues with the jira CLI, check sprint status, or manage their Jira workflow. Triggers on keywords like "jira", "issue", "ticket", "sprint", "backlog", or issue key patterns.
---

# Jira

Natural language interaction with Jira using the `jira` CLI.

## Required CLI

This skill only supports the `jira` CLI.

**Run this check first:**

```bash
which jira
```

- If `jira` is available, use the CLI commands below.
- If `jira` is not available, stop and tell the user the CLI is required.
- Do not install the CLI, run package-manager commands, or run `jira init` unless the user explicitly asks you to perform setup.

## When CLI Is Missing

If `which jira` fails:

1. Explain that this skill requires the local `jira` CLI.
2. Provide setup instructions for the user to run themselves.
3. Ask the user to install/configure it and then retry.
4. Only run installation or setup commands if the user explicitly asks you to do so.

Suggested user-run setup:

```bash
brew install ankitpokhrel/jira-cli/jira-cli
jira init
jira me
```

Project: https://github.com/ankitpokhrel/jira-cli

---

## Quick Reference

| Intent | Command |
|--------|---------|
| View issue | `jira issue view ISSUE-KEY` |
| List my issues | `jira issue list -a$(jira me)` |
| My in-progress | `jira issue list -a$(jira me) -s"In Progress"` |
| Create issue | `jira issue create -tType -s"Summary" -b"Description"` |
| Create issue under epic | `jira issue create -tStory -pPROJ --parent EPIC-KEY -s"Summary" -b"Description"` |
| Move/transition | `jira issue move ISSUE-KEY "State"` |
| Assign to me | `jira issue assign ISSUE-KEY $(jira me)` |
| Assign to someone | `jira issue assign ISSUE-KEY "user@example.com"` |
| Unassign | `jira issue assign ISSUE-KEY x` |
| Add comment | `jira issue comment add ISSUE-KEY -b"Comment text"` |
| Open in browser | `jira open ISSUE-KEY` |
| Current sprint | `jira sprint list --state active` |
| Who am I | `jira me` |

---

## Triggers

- "create a jira ticket"
- "show me PROJ-123"
- "list my tickets"
- "move ticket to done"
- "what's in the current sprint"

---

## Issue Key Detection

Issue keys follow the pattern: `[A-Z]+-[0-9]+` (e.g., PROJ-123, ABC-1).

When a user mentions an issue key in conversation, use:

```bash
jira issue view KEY
```

or, if the user wants to open it in a browser:

```bash
jira open KEY
```

---

## Workflow

**Creating tickets:**
1. Research context if user references code/tickets/PRs.
2. Check project requirements when needed.
3. Draft ticket content.
4. Review with user.
5. Create with `jira issue create`.
6. Verify the created issue.

**Body markup and the create vs edit quirk:**
- Some Jira instances (Server / Data Center) render **wiki markup**, not
  Markdown. On those, write descriptions in wiki markup (`h2.` headings,
  `*` bullets, `#` numbered lists, `{{...}}` monospace, `{code}{code}`
  blocks).
- `jira issue create` converts a Markdown `-b` body to the instance format,
  but `jira issue edit` sends the body **raw**. So a body that rendered fine
  on create can break on a later edit. Pass already-final wiki markup to
  `edit` on wiki-markup instances.
- Do **not** pass wiki markup to `jira issue create -b` on a wiki-markup
  instance: the Markdown conversion mangles it. Observed damage: the blank
  line between a heading and the list under it is dropped, gluing the first
  list item onto the heading (`h2. Done when* first item`), and special
  characters get backslash-escaped (`nba2\-core`, `hashed\_password`,
  `\(...\)`). Headings survive only because `h2.` is not Markdown.
- Recommended pattern on wiki-markup instances: create with a minimal body,
  then `jira issue edit -b` the final wiki markup (edit sends it raw, so it
  stores verbatim), and verify with `jira issue view KEY --raw`.
  Alternatively, write the create body in real Markdown and let the
  converter produce the wiki markup.

**Epic / parent handling:**
- If the user mentions an epic, parent epic, parent issue, or asks for a Story/Task to be under an epic, use `--parent EPIC-KEY` when creating the issue.
- Do not use `--custom` fields for Epic Link. With `jira` CLI, epic placement is done with `--parent`.
- On non-cloud Jira (Server / Data Center, classic projects), the Epic Link of an existing issue is stored in an instance-specific `customfield_*`, not in `fields.parent`. When inspecting raw issue JSON to find which epic an issue belongs to, scan the `customfield_*` entries rather than assuming `fields.parent` is populated. The specific field id varies by instance, so detect it per ticket instead of hardcoding.

**Updating tickets:**
1. Fetch issue details first with `jira issue view ISSUE-KEY`.
2. Check status, assignee, linked issues, and relevant fields.
3. Show current vs proposed changes.
4. Get approval before updating.
5. Apply the CLI command.
6. Verify the updated issue.
7. Add a comment explaining significant changes when appropriate.

---

## Before Any Operation

Ask yourself:

1. **What's the current state?** Always fetch the issue first. Don't assume status, assignee, or fields are what user thinks they are.

2. **Who else is affected?** Check watchers, linked issues, parent epics, and sprint context when relevant. A "simple edit" might notify many people.

3. **Is this reversible?** Transitions may have one-way gates. Some workflows require intermediate states. Description edits have no undo.

4. **Do I have the right identifiers?** Verify issue keys, transition names, project keys, users, and sprint IDs before acting.

---

## NEVER

- **NEVER transition without fetching current status first**. Workflows may require intermediate states. "To Do" -> "Done" might fail if "In Progress" is required first.

- **NEVER edit description without showing original content or a clear summary of what will change**. Jira has no undo.

- **NEVER use `--no-input` without all required fields**. It can fail with cryptic errors. Check the project's required fields first.

- **NEVER use `--custom` to set Epic Link when creating issues**. Use `--parent EPIC-KEY` instead.

- **NEVER assume transition names are universal**. "Done", "Closed", and "Complete" vary by project. If unsure, inspect the issue or use interactive/browser flow.

- **NEVER bulk-modify without explicit approval**. Each ticket change can notify watchers.

- **NEVER install, upgrade, or configure the `jira` CLI unless the user explicitly asks you to perform setup**. If the CLI is missing, provide instructions for the user to run.

---

## Safety

- Always show the CLI command before running it.
- Always get approval before modifying tickets.
- Preserve original information when editing.
- Verify updates after applying.
- Surface authentication and permission issues clearly so the user can resolve them.

---

## Deep Dive

**LOAD `references/commands.md` when:**
- Creating issues with complex fields or multi-line content.
- Building JQL queries beyond simple filters.
- Troubleshooting CLI errors or authentication issues.
- Working with transitions, linking, or sprints.

**Do NOT load reference for:**
- Simple view/list operations where the Quick Reference above is sufficient.
- Basic status checks (`jira issue view KEY`).
- Opening issues in browser.

| Task | Load Reference? |
|------|-----------------|
| View single issue | No |
| List my tickets | No |
| Create with description | **Yes**: CLI needs `/tmp` pattern for multi-line content |
| Transition issue | **Yes**: review transition command patterns |
| JQL search | **Yes**: for complex queries |
| Link issues | **Yes**: review link syntax |

Reference:
- CLI patterns: `references/commands.md`
