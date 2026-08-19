---
description: Create conventional commit for a squash commit when merging to main
---

Create a git commit message following the Conventional Commits 1.0.0
specification for the squash commit that will be used when merging this branch
to `main`.

You should use this format:
```
  <type>[optional scope]: <description>

  [optional body]

  [optional footer(s)]
```

Rules:

- type MUST be one of: feat, fix, build, chore, ci, docs, style, refactor, perf, test, revert
- Use feat for new features, fix for bug fixes or very small features
- scope is optional: a noun in parentheses describing the affected section, e.g. feat(parser):
- description: short summary in present tense, max 72 chars total for the first line
- Append ! after type/scope for breaking changes, e.g. feat! or feat(api)!
- Breaking changes MUST also have a 'BREAKING CHANGE: <description>' footer
- Body and footers are optional; separate each section with a blank line
- Output **only the commit message**. **No** preamble, **No** markdown fences,
  **No** explanation. **Your entire raw output will be copied directly as the squash commit
  message**.
- Ensure every line is wrapped to 72 chars

Examples:

```
feat(auth): add OAuth2 login support

Implements the full OAuth2 workflow for authenticating the user to the
application. The implementation lives in `auth/oauth2.py`.

----------------------------------------------

fix: prevent race condition in request handler

The request handler had a race condition when multiple requests were processed
concurrently. This commit adds lock mechanism with `asyncio.Lock` that prevents
these race conditions.

----------------------------------------------

feat!: drop support for Node 6

BREAKING CHANGE: Node 6 is no longer supported.

----------------------------------------------

feat(memory): add durable per-project memory extension

Adds a new `memory` extension that gives every project a persistent
`memory.md` loaded into context at session start. The agent appends
entries only on explicit user instruction via `add_memory`; users
prune the file with `/edit-memory`.

Key design points:
- File resolves to `<root>/.pi/memory.md` for trusted repos or
  `<agent-dir>/memory/<encoded-root>/memory.md` otherwise, keyed
  to match pi's session-directory encoding
- Submodules climb to the superproject; linked worktrees collapse
  onto the main checkout
- Duplicate detection (case/spacing/punctuation-insensitive) rejects
  literal repeats at tool-call time
```
