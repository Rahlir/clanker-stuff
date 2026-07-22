# pi search-guard Extension

A `pi` extension that blocks two reflexive search-command mistakes at the moment
the agent runs them, instead of relying on an AGENTS.md rule the model skims past.

## What it does

Hooks `tool_call` for `bash` and blocks the command (returning an instructive
reason the agent acts on) in two cases:

1. **`rg -r` misuse** (the dangerous one). In ripgrep, `-r`/`-R` is `--replace`,
   not "recursive" (rg already recurses). `rg -rn "pat" path` parses as
   `--replace=n`: it silently rewrites every match to the literal `n` and still
   prints file paths, so the corrupted output looks like a normal search result
   and the agent reasons over garbage. The guard rejects any short `-r`/`-R`
   cluster (`-r`, `-rn`, `-rln`, `-rni`, `-nr`, ...).

2. **Recursive `grep -r`/`-R`** tree search, where `rg` is preferred (recurses
   by default, honors `.gitignore`). Also catches `--recursive` /
   `--dereference-recursive`.

Blocking, not silently rewriting: command semantics never change under the
agent, and the block reason teaches the correct form, so the agent immediately
re-issues it correctly. Models that never make the mistake never trigger it.

## Why a hook instead of a prompt rule

Analysis of ~600 real session logs showed both mistakes are persistent,
model-specific `grep` muscle memory: they fire at a constant rate proportional
to how much a model uses `rg`/`grep`, independent of how recently the rule
appeared in context. Prose in AGENTS.md does not override that reflex; a
deterministic interceptor does.

## What it allows

- `rg -n` / `rg -l` / `rg -C3` / `rg -t py` and every other non-`r` flag.
- Genuine substitution via the long form: **`rg --replace ...`** (the escape
  hatch; the short `-r` is always rejected).
- `grep` for filtering piped input (`... | grep foo`) or scanning a single named
  file (`grep -n foo file`). Only recursive `grep` is blocked.
- Search commands written *as data* into a heredoc body (e.g. `cat > s.sh
  <<'EOF' ... EOF`) are not mistaken for executed commands.

## Configuration

Two module-level constants at the top of `index.ts` toggle each check
independently:

```ts
const CHECK_RG_REPLACE = true;      // block rg -r / -rn / ...
const CHECK_GREP_RECURSIVE = true;  // block grep -r / -R / --recursive
```

Set either to `false` to disable that check. After editing, run `/reload` in pi.

## Installation

Install the whole `clanker-stuff` package, or test standalone:

```bash
pi -e ./index.ts
```

## Limitations

Detection is a shell-approximate tokenizer, not a full parser. It understands
quotes (with bash-accurate escaping), backslash line continuations,
`|`/`;`/`&&`/`||`/`$(`/newlines, redirections (leading ones and `2>&1`-style fd
dups), env-assignment and wrapper prefixes with their own flags (`sudo -u root`,
`env -i`, `nice -n 10`, `xargs -0`, ...), the `--` end-of-options marker,
short-flag clusters with attached values, and skips heredoc bodies.

Known gaps: a search command hidden inside a quoted string passed to another
program (`sh -c "grep -r ..."`) or run via `find ... -exec grep -r` is not
inspected, and exotic quoting can still slip through. When in doubt the guard
fails open (no block) rather than blocking legitimate work; a false block, if it
happens, only costs one retry and never corrupts output.
