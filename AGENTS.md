# AGENTS.md

This file gives coding agents (pi, Codex, Claude Code, …) the repo-specific context they need to be useful here. Keep it concise: only include what an agent would get wrong without it.

## What this repo is

A pi package containing extensions, skills, prompts, and themes for the `pi` coding agent. The README has install/update instructions.

## Asset layout and auto-discovery

`package.json` uses globs that auto-discover new directories in the right place — **no edits to `package.json` are needed** when adding new assets:

| Asset | Add here | Required file |
|-------|----------|---------------|
| Extension | `extensions/<name>/` | `index.ts` |
| Skill | `skills/<name>/` | `SKILL.md` |
| Prompt | `prompts/` | `<name>.md` |
| Theme | `themes/` | `<name>.json` |

## Extensions: no build step

pi loads TypeScript extensions directly — there is no compile step. After editing `index.ts`, run `/reload` in pi to pick up the change.

## Extension config: do not edit bundled files

`extensions/code-review/config.json` and `extensions/code-review/reviewer-prompt.md` are bundled defaults that get **reset on `pi update`**. User overrides belong outside the repo:

- Model / thinking level: `${XDG_CONFIG_HOME:-$HOME/.config}/pi-clanker/code-review.json`
- Reviewer prompt: `${XDG_CONFIG_HOME:-$HOME/.config}/pi-clanker/code-review-reviewer-prompt.md`

## Frontmatter conventions

**Skills** (`SKILL.md`): required fields are `name` and `description`. Add `disable-model-invocation: true` for skills that should only be triggered explicitly (e.g., those with destructive side effects).

**Prompts** (`.md` in `prompts/`): required field is `description` (shown in pi's prompt picker). Optional `argument-hint` is shown as the input placeholder when selected. Use `$@` for all arguments or `$1`, `$2` for positional ones.

## Building new extensions, skills, and prompts (pi only)

> This section applies only when running inside `pi`. Other agents should skip it.

Before designing anything, read recent session logs to see how the workflow plays out in practice — tool choices, phrasing patterns, points of friction.

**Session logs** for the current working directory:

```bash
~/.pi/agent/sessions/-$(echo "$(pwd)/" | tr '/' '-')-/
```

Each session is a `.jsonl` file. Lines with `"type": "message"` hold the conversation; `role` is `user`, `assistant`, or `toolResult`; text lives in `content[].text` blocks. The same formula works for any directory — useful when a skill targets a workflow in a different repo.

**pi SDK and docs** for extension authoring (`docs/`, `examples/extensions/`):

```bash
$(dirname $(dirname $(which pi)))/lib/node_modules/@earendil-works/pi-coding-agent
```

The existing `extensions/` in this repo are the closest style reference for TypeScript conventions and TUI rendering patterns.

## Verification

`package.json` has no `scripts` — there is no `npm test`, lint, or type-check command. After editing an extension, the only meaningful check is loading it in pi with `/reload` and exercising it manually.
