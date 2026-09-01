# AGENTS.md

This file gives coding agents (pi, Codex, Claude Code, …) the repo-specific context they need to be useful here. Keep it concise: only include what an agent would get wrong without it.

## What this repo is

A pi package containing extensions, skills, prompts, and themes for the `pi` coding agent. The README has install/update instructions.

## Asset layout and auto-discovery

`package.json` uses globs that auto-discover new directories in the right place: **no edits to `package.json` are needed** when adding new assets:

| Asset | Add here | Required file |
|-------|----------|---------------|
| Extension | `extensions/<name>/` | `index.ts` |
| Skill | `skills/<name>/` | `SKILL.md` |
| Prompt | `prompts/` | `<name>.md` |
| Theme | `themes/` | `<name>.json` |

## Shared code between extensions (`lib/`)

Code reused by more than one extension lives in repo-root `lib/` (e.g.
`lib/annotator.ts`, the annotation TUI used by both `annotate` and `mr-review`).
It is a plain module, not an extension: the `./extensions/*/index.ts` glob does
not match it, so pi never auto-loads it, but it ships with the package. Extensions
import it by relative path (`../../lib/<name>.ts`). Prefer this over one extension
reaching into another's files, so extensions don't depend on each other.

A `lib/` module is **not a singleton**: pi loads every extension through its own
jiti instance with the module cache disabled, so each importing extension gets a
separate copy. Module-level state is therefore per-extension. State that must be
shared process-wide has to live on `globalThis` under a `Symbol.for` key (see
`lib/ui-lock.ts`).

## Interactive UI: one at a time

pi's `ctx.ui.custom`, `ctx.ui.editor`, `ctx.ui.confirm` and `ctx.ui.select` all
clear and repopulate the same editor container. A second one opened while the
first is up evicts the first from the component tree, so the evicted component
never receives the keystroke that resolves it and its promise stays pending for
the rest of the session. Any tool that opens UI must declare
`executionMode: "sequential"` (which forces its whole tool batch to run one call
at a time) and should run the UI inside `withUiLock` from `lib/ui-lock.ts`, which
turns a leftover concurrent open into a clear error instead of a silent hang.

## Extensions: no build step

pi loads TypeScript extensions directly; there is no compile step. After editing `index.ts`, run `/reload` in pi to pick up the change.

## Extension config: do not edit bundled files

`extensions/code-review/config.json` and `extensions/code-review/reviewer-prompt.md` are bundled defaults that get **reset on `pi update`**. User overrides belong outside the repo:

- Model / thinking level: `${XDG_CONFIG_HOME:-$HOME/.config}/pi-clanker/code-review.json`
- Reviewer prompt: `${XDG_CONFIG_HOME:-$HOME/.config}/pi-clanker/code-review-reviewer-prompt.md`

## Frontmatter conventions

**Skills** (`SKILL.md`): required fields are `name` and `description`. Add `disable-model-invocation: true` for skills that should only be triggered explicitly (e.g., those with destructive side effects).

**Prompts** (`.md` in `prompts/`): required field is `description` (shown in pi's prompt picker). Optional `argument-hint` is shown as the input placeholder when selected. Use `$@` for all arguments or `$1`, `$2` for positional ones.

## Building new extensions, skills, and prompts (pi only)

> This section applies only when running inside `pi`. Other agents should skip it.

Before designing anything, read recent session logs to see how the workflow plays out in practice: tool choices, phrasing patterns, points of friction.

**Session logs** for the current working directory:

```bash
~/.pi/agent/sessions/-$(echo "$(pwd)/" | tr '/' '-')-/
```

Each session is a `.jsonl` file. Lines with `"type": "message"` hold the conversation; `role` is `user`, `assistant`, or `toolResult`; text lives in `content[].text` blocks. The same formula works for any directory, which is useful when a skill targets a workflow in a different repo.

**pi SDK and docs** for extension authoring (`docs/`, `examples/extensions/`):

```bash
$(dirname $(dirname $(which pi)))/lib/node_modules/@earendil-works/pi-coding-agent
```

The existing `extensions/` in this repo are the closest style reference for TypeScript conventions and TUI rendering patterns.

## Verification

Run `npm run type-check` (`tsc --noEmit` against `tsconfig.json`) after editing any
extension or `lib/` module. It covers all of `lib/**` and `extensions/**` with
`strict`, bundler resolution, and `allowImportingTsExtensions` (matching how pi
loads the `.ts` files), and the whole repo is expected to stay green.

Use the `npm run type-check` script, not a bare `tsc` with file arguments: passing
files on the command line makes tsc ignore `tsconfig.json` (including its
`noEmit`), which can drop stray compiled `.js` next to the sources. (Those are
gitignored under `lib/`/`extensions/` as a safety net, but avoid creating them.)

`npm test` runs the unit/integration suite via Node's built-in runner (`node
--test`, no framework or transpiler: Node runs the `.test.ts` files and their
`.ts`-extension imports natively). Test files are colocated as `*.test.ts` next
to their sources, so `tsconfig` already type-checks them. There is still no lint.

What is tested, and what is not: unit and integration tests target the
dependency-free "pure core" only, i.e. modules that import at most `import type`
from pi. Logic worth testing gets extracted behind such a pure export (the
pattern the repo already follows: `lib/shell-tokens.ts`, `mr-review/state.ts`,
`format.ts`, `glab.ts`'s `buildNoteArgs`, the guards' exported `analyzeCommand`).
The guards' behavior is covered by fixture corpora over `analyzeCommand`; a
single inline smoke test per guard checks that the extension factory registers a
blocking `tool_call` hook (and, for cd-guard, threads `ctx.cwd`). Do NOT boot the
pi runtime (or a live model) inside tests.

Type-check plus tests are still static/headless only, so after editing an
extension, also load it in pi with `/reload` and exercise it manually, since the
TUI/runtime behavior can't be covered here.
