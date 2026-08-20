# pi Code Review Extension

A `pi` extension for reviewing your current changes with a separate read-only
`pi` subprocess that returns structured findings by severity. Reviews block until
they finish by default, or run in the background (`wait: false`) so the agent can
keep working, including several at once for multi-model review.

The reviewer can inspect files and run read-only commands such as `git diff`,
`git status`, linters, and type checkers. It cannot use write or edit tools.

## What it does

- Registers `code_review` plus `code_review_await`, `code_review_status`, and
  `code_review_cancel` for the main agent (see [Tools](#tools)).
- Runs each review in an isolated `pi` subprocess with a dedicated reviewer
  prompt.
- Limits the reviewer to read-only tools: `read`, `grep`, `find`, `ls`, and
  `bash`.
- Streams reviewer activity in the TUI while a review is running, and lists
  detached background reviews in a widget above the editor.
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
├── config.json           # Bundled default reviewer model and thinking level
└── reviewer-prompt.md    # Bundled default reviewer system prompt
```

## Configuration

The `config.json` and `reviewer-prompt.md` next to `index.ts` are **bundled
defaults**. When this extension is installed as a pi package, that directory is
managed by pi and reset on `pi update`, so edit your settings outside the
package instead. The extension resolves configuration with this precedence
(highest first):

**Model / thinking level**

1. Tool call parameter (`model`, `thinking`)
2. Environment variables `CODE_REVIEW_MODEL`, `CODE_REVIEW_THINKING`
3. User config file `${XDG_CONFIG_HOME:-$HOME/.config}/pi-clanker/code-review.json`
4. Bundled `config.json`
5. Hardcoded fallback (`openai-codex/gpt-5.4`, no thinking)

The user config file uses the same shape as the bundled default:

```json
{
  "model": "anthropic-vertex/claude-sonnet-4-6",
  "thinking": "medium"
}
```

Create it once and it survives package updates:

```bash
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/pi-clanker"
cat > "${XDG_CONFIG_HOME:-$HOME/.config}/pi-clanker/code-review.json" <<'EOF'
{
  "model": "anthropic-vertex/claude-sonnet-4-6",
  "thinking": "medium"
}
EOF
```

**Reviewer prompt**

1. Environment variable `CODE_REVIEW_PROMPT_FILE` (path to a prompt file)
2. User file `${XDG_CONFIG_HOME:-$HOME/.config}/pi-clanker/code-review-reviewer-prompt.md`
3. Bundled `reviewer-prompt.md`

The extension re-reads configuration every time `code_review` runs, so changes
do not require `/reload`.

If no model is provided in the tool call, env, or any config file, the extension
falls back to `openai-codex/gpt-5.4` and shows a warning.

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

## Tools

The blocking default preserves the original workflow: one `code_review` call
starts the subprocess, streams progress, and returns the report. The other three
tools exist for the async workflow, all keyed by a job id (`cr-1`, `cr-2`, ...).

| Tool | Blocks? | Purpose |
|---|---|---|
| `code_review` | Yes, unless `wait: false` | Start a review. Blocking returns the report; `wait: false` returns a job id immediately and runs it in the background. |
| `code_review_await` | Yes | Block until a background review finishes and return its report. Esc detaches and leaves it running (it does not stop it). |
| `code_review_status` | No | Report a background review's state, or list all reviews in the session. Not for polling in a loop. |
| `code_review_cancel` | No | Stop a running background review and discard its result. |

To review with several models at once, issue multiple `code_review` calls in one
message (they run concurrently), or start each with `wait: false` and collect
them with `code_review_await`. At most four reviews run concurrently; further
starts are rejected until one is collected or cancelled. Background reviews are
in-memory only: reloading, switching, or quitting the session kills their
subprocesses and forgets their job ids. Once collected, a finished review's result
is eventually dropped from the registry (the newest 20 collected results are
kept); uncollected results are retained until you await or check them.

## Tool parameters

The extension exposes these parameters to pi:

| Parameter | Required | Description |
|---|---:|---|
| `task` | Yes | What to review. Include changed files and a short description of the work. |
| `focus` | No | Optional focus area, such as `security`, `performance`, or `error handling`. |
| `model` | No | Model override for this review. Defaults to `config.json`. |
| `thinking` | No | Thinking-level override for this review. Defaults to `config.json`. |
| `wait` | No | Whether to block until the review finishes. Defaults to `true`; set `false` to run it in the background and collect it later with `code_review_await`. |

`code_review_await` and `code_review_cancel` take a required `jobId`;
`code_review_status` takes an optional `jobId` (omit to list all reviews).

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

- Check the precedence chain under [Configuration](#configuration): a tool
  parameter or `CODE_REVIEW_MODEL` env var overrides your config file.
- Check `${XDG_CONFIG_HOME:-$HOME/.config}/pi-clanker/code-review.json`.
- Restart or `/reload` is not required for config changes, since the extension re-reads config on each run.

### The review fails with no prompt found

The extension falls back to the bundled `reviewer-prompt.md` next to `index.ts`.
If you set `CODE_REVIEW_PROMPT_FILE`, make sure it points at an existing file.

### The review fails to start pi

The extension tries to reuse the current pi invocation when possible. If that
is not available, it falls back to running `pi` from your `PATH`. Make sure the
`pi` command is available in the environment where the main session is running.
