# pi Questionnaire Extension

A `pi` extension that registers a `questionnaire` tool. When the agent needs to
clarify requirements, gather preferences, or make a decision, it calls this tool
to present the user with a structured question interface instead of asking in
plain text.

## What it does

- Registers a `questionnaire` tool the LLM can call during any agent turn.
- **Single question:** renders a compact, scrollable option list.
- **Multiple questions:** renders a tab bar (one tab per question plus a Submit
  tab), so you can answer in any order and review before confirming.
- Supports a **"Type something"** option on every question, which opens an
  inline text editor for free-form answers.
- Returns answers to the LLM with each question's id, the selected label and
  value, and whether the answer was typed freely or chosen from the list.

## Installation

Either install the whole `clanker-stuff` package or copy this directory into
one of pi's extension auto-discovery locations.

You can also test the extension on its own without installing it:

```bash
pi -e ./index.ts
```

## Usage

You do not call this tool yourself. The agent calls it when it has questions it
cannot resolve from context alone. Prompt the agent in a way that benefits from
clarification and it will use the tool automatically.

Example prompts that tend to trigger it:

```text
Review my auth changes, but check with me first on scope and focus.
```

```text
I want to refactor the payment module, ask me a few questions before diving in.
```

The tool is especially useful alongside skills or prompts that conduct
structured interviews (such as `grill-me`).

## Keyboard reference

| Key | Action |
|-----|--------|
| `↑` / `↓` | Move between options |
| `Enter` | Select highlighted option (or submit on the Submit tab) |
| `Tab` / `→` | Next question tab (multi-question only) |
| `Shift+Tab` / `←` | Previous question tab (multi-question only) |
| `Esc` | Cancel the questionnaire |

When the **"Type something"** option is selected and the editor is open:

| Key | Action |
|-----|--------|
| `Enter` | Submit the typed answer |
| `Esc` | Close the editor and return to option list |

## Tool parameters

The LLM calls `questionnaire` with a `questions` array. Each question has:

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier for this question; returned with the answer |
| `prompt` | Yes | Full question text shown in the UI |
| `options` | Yes | List of choices; each has `value`, `label`, and optional `description` |
| `label` | No | Short tab-bar label, e.g. `"Scope"` (defaults to `Q1`, `Q2`, …) |
| `allowOther` | No | Include a "Type something" free-text option (default: `true`) |

## What the LLM receives

After you answer (or cancel), the tool returns a plain text summary and a
structured `details` object. For each answered question the text reads:

```
Scope: user selected: 2. This file only
Priority: user wrote: Performance before correctness
```

The `details` object includes the full question and answer data so the agent can
reason about your choices precisely.

If you cancel, the tool reports `"User cancelled the questionnaire"` and the
agent typically asks you what you would like to do next.

## One at a time

The tool is declared `executionMode: "sequential"` and takes the shared lock in
`lib/ui-lock.ts`, so it can never render alongside another interactive UI (a
second one would evict the first and hang whoever was waiting on it). A
concurrent call fails with a clear error instead.

## Non-interactive mode

The tool requires an interactive terminal. When pi runs in non-interactive mode
(JSON or print mode), the tool immediately returns an error and the agent falls
back to asking questions in plain text.
