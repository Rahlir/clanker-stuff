# pi cd-guard Extension

A `pi` extension that blocks a bash `cd` which lands back in the working
directory the call already starts in - a pure no-op - at the moment the agent
runs it.

## What it does

Hooks `tool_call` for `bash` and blocks the command (returning an instructive
reason the agent acts on) when a top-level `cd` resolves to the current working
directory: `cd /path/to/cwd && cmd`, `cd .`, `cd "$PWD"`. Every bash call
already starts there, so the prefix does nothing except get recorded in the
transcript permanently and re-sent on every later turn.

Blocking, not silently rewriting: command semantics never change under the
agent, and the block reason teaches the correct form, so the agent immediately
re-issues it correctly.

## What it does not do

It leaves a `cd` into another directory alone (`cd /other && cmd`). Inside pi's
isolated subprocess that is functionally identical to the subshell form
`(cd /other && cmd)` - neither persists to the next call - so forcing the
subshell would cost retries without preventing anything. (An earlier version
also blocked this; it was dropped as style enforcement rather than harm
prevention.)

## Why a hook instead of a prompt rule

The redundant `cd` prefix is reflexive muscle memory. The rule can sit at the
very top of AGENTS.md, with rationale, and session logs still show violations.
Prose does not override the reflex; a deterministic interceptor does.

## What it allows

- `cd` into any directory other than the cwd, top-level or in a subshell.
- `cd` inside `(...)`, `$(...)`, or backtick command substitution.
- `cd` written *as data*: inside quotes (`sh -c "cd ..."`) or heredoc bodies.
- Any `cd` whose target is not statically resolvable (`cd "$SOMEDIR"`, `cd -`):
  the guard cannot prove a no-op, so it lets it through.

## Configuration

One module-level constant at the top of `index.ts` toggles the guard:

```ts
const CHECK_CD_NOOP = true; // block cd that resolves back to the cwd
```

Set it to `false` to disable. After editing, run `/reload` in pi.

## Installation

Install the whole `clanker-stuff` package, or test standalone:

```bash
pi -e ./index.ts
```

## Limitations

Detection uses the shared shell-approximate tokenizer in `lib/shell-tokens.ts`,
not a full parser (see `search-guard` for the same trade-off). Known gaps: a
wrapper prefix (`time cd . && ...`) hides the `cd` from detection, and exotic
quoting can still slip through. When in doubt the guard fails open (no block); a
false block only costs one retry and never corrupts anything. Conversely, a
piped no-op `cd . | cmd` is blocked even though that segment already runs in its
own subshell; the harmless retry is to drop the `cd`.
