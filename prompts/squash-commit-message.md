---
description: Create conventional commit for a squash commit
argument-hint: "<changes in the squash commit>"
---

Create a git commit message following the Conventional Commits 1.0.0 specification for the following changes: $@

This commit message will be used for a squash commit when merging.

Format:
  <type>[optional scope]: <description>

  [optional body]

  [optional footer(s)]

  Changelog: <gitlab changelog type>

Rules:
- type MUST be one of: feat, fix, build, chore, ci, docs, style, refactor, perf, test, revert
- gitlab changelog type must be one of: added, fixed, changed, deprecated, removed, security, performance, other
- Use feat for new features, fix for bug fixes or very small features
- scope is optional: a noun in parentheses describing the affected section, e.g. feat(parser):
- description: short summary in present tense, max 72 chars total for the first line
- Append ! after type/scope for breaking changes, e.g. feat! or feat(api)!
- Breaking changes MUST also have a 'BREAKING CHANGE: <description>' footer
- Body and footers are optional; separate each section with a blank line
- Output ONLY the commit message. NO preamble, NO markdown fences, NO explanation.
- Ensure every line is wrapped to 72 chars

Examples:
```
feat(auth): add OAuth2 login support

Implements the full OAuth2 workflow for authenticating the user to the
application.

Changelog: added

----------------------------------------------

fix: prevent race condition in request handler

The request handler had a race condition when multiple requests were processed
concurrently. This commit adds lock mechanism with `asyncio.Lock` that prevents
these race conditions.

Changelog: fixed

----------------------------------------------

feat!: drop support for Node 6

BREAKING CHANGE: Node 6 is no longer supported.

Changelog: removed
```
