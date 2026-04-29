# pi Code Review Extension

A `pi` extension that adds a `code_review` tool. The tool launches a separate
read-only `pi` subprocess to review your current changes and return structured
findings by severity.

The reviewer can inspect files and run read-only commands such as `git diff`,
`git status`, linters, and type checkers. It cannot use write or edit tools.

## What it does

- Registers a `code_review` tool for the main agent.
- Runs the review in an isolated `pi` subprocess with a dedicated reviewer
  prompt.
- Limits the reviewer to read-only tools: `read`, `grep`, `find`, `ls`, and
  `bash`.
- Streams reviewer activity in the TUI while the review is running.
- Returns findings in this structure:
  - Critical, must fix
  - Major, should fix
  - Minor, nice to have
  - Summary
- Tracks model, token usage, cost, and exit status in the tool details.

## Installation

Copy this directory into one of pi's extension auto-discovery locations.

Global installation, available in all projects:

```bash
mkdir -p ~/.pi/agent/extensions
cp -R code-review ~/.pi/agent/extensions/code-review
```

Project-local installation, available only in the current repository:

```bash
mkdir -p .pi/extensions
cp -R code-review .pi/extensions/code-review
```

Then start pi, or run `/reload` if pi is already open.

You can also test the extension directly:

```bash
pi -e ./index.ts
```

## Files

```text
code-review/
├── index.ts              # Extension entry point
├── config.json           # Default reviewer model and thinking level
└── reviewer-prompt.md    # System prompt used by the reviewer subprocess
```

## Configuration

Edit `config.json` to set the default model and thinking level used by the reviewer.

```json
{
  "model": "anthropic-vertex/claude-sonnet-4-6",
  "thinking": "medium"
}
```

Fields:

- `model`: The default model for reviews.
- `thinking`: Optional thinking level, for example `off`, `medium`, or `high`, depending on model support.

The extension re-reads `config.json` every time `code_review` runs, so configuration changes do not require `/reload`.

If no model is provided in the tool call or config file, the extension falls back to `claude-sonnet-4-6` and shows a warning.

## Usage

Ask pi to run the code review tool after making changes. Be explicit that you want the tool or subagent used.

Example prompts:

```text
Please run the code_review tool on my changes to src/auth.ts and src/middleware.ts. Focus on security and error handling.
```

```text
Use the code review subagent to review the recent changes. I updated the retry logic in src/client.ts and added tests in src/client.test.ts.
```

The main agent is instructed to call `code_review` only when you explicitly ask for the tool or subagent. A normal request like "review this code" may be handled directly by the main agent instead.

## Tool parameters

The extension exposes these parameters to pi:

| Parameter | Required | Description |
|---|---:|---|
| `task` | Yes | What to review. Include changed files and a short description of the work. |
| `focus` | No | Optional focus area, such as `security`, `performance`, or `error handling`. |
| `model` | No | Model override for this review. Defaults to `config.json`. |
| `thinking` | No | Thinking-level override for this review. Defaults to `config.json`. |

## How the review subprocess runs

The extension starts a subprocess similar to:

```bash
pi --mode json -p \
  --no-session \
  --no-prompt-templates \
  --tools read,grep,find,ls,bash \
  --model <model> \
  --thinking <thinking> \
  --append-system-prompt reviewer-prompt.md \
  "<task>"
```

The subprocess runs in the same working directory as the main pi session.

## Reviewer behavior

The reviewer prompt tells the subagent to:

- Review only, never modify files.
- Use bash only for read-only commands.
- Include file paths and line numbers.
- Be concise and avoid filler.
- Calibrate severities honestly.
- Use the fixed output format with Critical, Major, Minor, and Summary sections.

You can customize this behavior by editing `reviewer-prompt.md`.

## Safety notes

This extension restricts the reviewer subprocess to read-only pi tools, but the
`bash` tool can still execute arbitrary shell commands. The reviewer prompt
instructs it to use bash only for read-only commands, such as `git diff`, `git
status`, linters, and type checkers.

This is not fail safe. AI is known to ignore safety rules at times, so use at
your own risk and always check what the agent is doing.

## Troubleshooting

### The tool does not appear

- Make sure the directory contains `index.ts`.
- Make sure it is installed under one of these locations:
  - `~/.pi/agent/extensions/code-review/index.ts`
  - `.pi/extensions/code-review/index.ts`
- Run `/reload` in pi.

### The review uses the wrong model

- Check `config.json`.
- Pass a model override in the review request.
- Restart or `/reload` is not required for config changes, since the extension re-reads config on each run.

### The review fails with no prompt found

Make sure `reviewer-prompt.md` is next to `index.ts` in the extension directory.

### The review fails to start pi

The extension tries to reuse the current pi invocation when possible. If that
is not available, it falls back to running `pi` from your `PATH`. Make sure the
`pi` command is available in the environment where the main session is running.
