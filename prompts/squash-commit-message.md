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
- Output **only the commit message**. **No** preamble, **no** markdown fences,
  **no** explanation. **Your entire raw output will be copied directly as the squash commit
  message**.
- Ensure every line is wrapped to 72 chars

Learn this repository's conventions from its history before writing:

1. Run `git log main -n 30 --format='%h%n%B---'`.
2. Take scope names, subject phrasing, and body style from those commits.
   Prefer commits that have a body as the model for body style.
3. Where history disagrees with the rules above, follow the rules.
4. Write a body whenever the change is not trivial, even if recent commits
   have none.
5. If history is empty or does not use Conventional Commits, rely on the
   rules alone.

Breaking change example (history rarely demonstrates this one):

```
feat!: drop support for Node 6

BREAKING CHANGE: Node 6 is no longer supported.
```

Once you have inspected history, output the commit message. First character
**must be the type keyword** (feat / chore / etc.). No backticks, no "Here is...".
