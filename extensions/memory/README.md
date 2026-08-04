# memory

Gives every project a durable, user-curated `memory.md` that is loaded into
context at the start of each session there. The agent appends to it only when
you explicitly teach it something; you prune it by hand.

Generalizes the memory protocol that used to be hand-rolled inside individual
skills, so projects without a bespoke skill get the same durable context.

## Where the file lives

Resolved once per session from the project root:

| Case | Root |
|------|------|
| Normal checkout | `git rev-parse --show-toplevel` |
| Subdirectory of a monorepo | the repo root (same memory everywhere in the repo) |
| Git submodule | the **superproject** working tree |
| Linked worktree | the **main checkout** (throwaway worktrees share the parent's memory) |
| Not a repo | the session's cwd |

The root is canonicalized (symlinks resolved), so reaching the same project
through a symlinked path always gives the same memory file.

The file is then either:

1. `<root>/.pi/memory.md`, if it exists **and** the project is trusted. The
   deliberate opt-in for team-shared memory committed to the repo. Untrusted
   projects silently fall back to (2), because an in-repo file is text the agent
   reads and follows.
2. `<agent-dir>/memory/<encoded-root>/memory.md` otherwise (default:
   `~/.pi/agent/memory/--Users-you-dev-repo--/memory.md`). The key matches pi's
   session-directory encoding, so a project's memory dir and session dir are
   cross-navigable. Created lazily on first write, with a header explaining the
   format.

## Format

```
- YYYY-MM-DD: <one-line lesson in imperative voice>
```

Newest last, append-only in normal use. Anything else in the file (notes,
headings) is preserved verbatim and ignored by the parser.

The one exception is the boilerplate header written when the file is created.
It orients a human opening the file, and every line of it is already in the
preamble, so it is stripped before injection rather than spending context every
session. The match is exact: a hand-written file (a team-shared `.pi/memory.md`
with real scope notes, say) never matches and its prose does reach the model,
and editing the boilerplate makes it yours, at which point it is injected too.

## Injection

At session start the extension injects one custom message: a protocol preamble
plus the file's entries. It renders as a single dim line in the transcript
(`memory 12 lessons ~/.pi/agent/memory/...`); ctrl+o expands it.

A fresh copy is re-injected, marked as superseding earlier ones, when:

- **compaction** happens (the memory block is the oldest message in the session,
  so it is the first thing summarized away);
- **`/edit-memory`** saves a change (the copy in context is now wrong, which
  matters most right after a prune);
- a session is **resumed** and the file changed since the copy in that session
  (another session taught something in the meantime).

`/reload` does not re-inject: the context is intact.

## Tool

`add_memory(lesson)` appends `- <today>: <lesson>`, creating the file if needed.

The rule that it fires **only on explicit user teaching or confirmation** lives
in the tool description, which is where it bites: the model reads it at the
moment it considers calling. The injected preamble restates it with the context
the description cannot carry (the memory is authoritative; check the entries
below before appending). Both are re-sent with every request, so compaction
reaches neither.

Deliberately *not* a `promptGuidelines` bullet. That would put a third copy of
the same restriction in the system prompt of every project, read before the
model is considering the tool at all. Guidelines placement only earns its tokens
for a rule that encourages proactive capture, which is the opposite of what this
file wants.

Literal duplicates (ignoring case, spacing, trailing punctuation) are rejected
with a pointer to `/edit-memory`. Reworded near-duplicates are the model's job:
it has the whole file in context and the preamble tells it to look.

## Command

`/edit-memory` opens the file in pi's editor dialog, prefilled (with the header
if the file does not exist yet). ctrl+g inside the dialog opens `$VISUAL` /
`$EDITOR`. Saving writes the file and refreshes the copy in context. In headless
modes it prints the resolved path instead.

## Configuration

Only the preamble is overridable, at
`${XDG_CONFIG_HOME:-$HOME/.config}/pi-clanker/memory-preamble.md`. It takes
precedence over the bundled `preamble.md`, which `pi update` resets.

Above 8KB the extension notifies you at session start that the file is large;
pruning is a judgement call, so it never nags the model.

## Layout

- `store.ts` — pure string core (key encoding, entry parse/format, duplicate
  and size checks, message assembly). No fs, git, or pi imports; unit tested in
  `store.test.ts`.
- `index.ts` — all IO: git root resolution, file reads/writes, hooks, tool,
  command, renderer. Root resolution is exported and tested against real temp
  repos in `root.test.ts`.
