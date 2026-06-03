---
description: Interactively set up AGENTS.md and skills for this repo, written to be portable to teammates
argument-hint: "[fast|review|fresh]"
---

Set up a minimal AGENTS.md (and optionally skills) for this repo. AGENTS.md is loaded into every agent session, so it must be concise — only include what an agent would get wrong **about this repo** without it.

The argument $1, if present, pre-answers Phase 1:
- `fast` → "Let pi decide" path (skip questions, propose everything, ask only for approval)
- `review` → "Review and improve" path (only valid if AGENTS.md exists)
- `fresh` → "Start fresh" path (replace existing AGENTS.md)
- anything else or empty → ask normally

## Phase 0: Check for an existing AGENTS.md

Before asking anything, run `cat ./AGENTS.md` (and also `cat ./CLAUDE.md` if AGENTS.md doesn't exist — pi reads both, and a CLAUDE.md left by another tool is informative). Only the project-root file counts here. Don't explore the tree yet. The result branches Phase 1.

Do **not** read `~/.pi/agent/AGENTS.md` or any other global agent file at any point during Phases 0-6. The generated file must be written for a reader with no global context. Phase 7 reads the global, and only for redundancy reporting.

## Phase 1: Ask intent

Before the first question, print this primer as normal assistant text:

> Quick context:
> - **AGENTS.md** gives every agent persistent, repo-specific instructions. pi (and Codex, Claude Code, etc.) read it at the start of every session in this directory.
> - **Skills** are packaged instructions an agent invokes automatically when a task matches, or that you trigger with `/skill:name`.
> - This `/init` writes an AGENTS.md that's portable to teammates whose global agent setup is different from yours.

If $1 is `fast`, `review`, or `fresh`, skip the questionnaire and use that answer. Otherwise call `questionnaire` with **a single question** matching the situation:

**If AGENTS.md (or CLAUDE.md) already exists:**

```
prompt: "I found an existing AGENTS.md. What would you like to do?"
options:
  - value: "review",   label: "Review and improve it",  description: "Explore what's changed in the repo and propose targeted edits."
  - value: "leave",    label: "Leave it, set up skills only", description: "Skip AGENTS.md. Go straight to skills."
  - value: "fresh",    label: "Start fresh (replace it)", description: "Discard it and write a new file."
```

Routing:
- `review` → skip the rest of Phase 1; explore (Phase 2); ask one Phase 3-lite question; go to Phase 4's diff-proposal flow; then Phases 5-7.
- `leave` → skip the rest of Phase 1 and Phase 4; run Phase 2 (skills-focused); propose in Phase 3 (no AGENTS.md bullet); Phase 5 (skills); Phase 6 summary; skip Phase 7 (nothing was written).
- `fresh` → continue below as if no file existed.

**If no AGENTS.md exists (or user picked `fresh`):**

```
prompt: "What should /init set up?"
options:
  - value: "agents_md", label: "AGENTS.md only",     description: "Just the repo's persistent agent instructions."
  - value: "with_skills", label: "AGENTS.md + skills", description: "Also propose repo-specific skills for repeatable workflows."
  - value: "let_pi",    label: "Let pi decide",      description: "Fastest path — propose AGENTS.md plus any skills that fit. You'll approve everything before it's written."
```

`let_pi` is the same as `with_skills` plus "skip Phase 3's gap-fill questions; propose directly from Phase 2 findings."

## Phase 2: Explore the codebase

Survey the repo using `bash` (rg, fd, cat) and `read`. Read the obvious manifests first, then anything they reference:

- Manifests: `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`, `build.gradle`, `Gemfile`, etc.
- README and any `docs/` overview
- Build scripts: `Makefile`, `Taskfile.yml`, `justfile`, `tox.ini`
- CI config: `.github/workflows/*`, `.gitlab-ci.yml`, `.circleci/`, `Jenkinsfile`
- Existing agent context: `AGENTS.md`, `CLAUDE.md` (if any), `.cursor/rules/`, `.cursorrules`, `.github/copilot-instructions.md`, `.windsurfrules`, `.clinerules`
- Existing skills: `.agents/skills/`, `.pi/skills/`, `.claude/skills/`
- Formatter / linter configs: `.prettierrc*`, `biome.json`, `ruff.toml`, `pyproject.toml [tool.ruff]`, `.eslintrc*`, `eslint.config.*`, `.rubocop.yml`, `.golangci.yml`, `.editorconfig`

Detect and record:

- **Build, test, lint, type-check, and format commands** — read the actual scripts in `package.json`/`pyproject.toml`/`Makefile`/etc. Capture the exact command strings (including workspace flags like `pnpm --filter web`, `nx run`, `cargo -p`, `go work`).
- **Pre-steps required before checks pass** (codegen, proto generation, schema build, required env vars or `.env` setup).
- **Monorepo / workspace layout** — what packages exist, which one runs which checks.
- **Languages, frameworks, package manager** (only as far as needed to write the file; don't list these explicitly in AGENTS.md — they're obvious from the manifest).
- **Branch / PR / commit conventions** if discoverable from CI or templates.
- **Non-obvious gotchas** — things that would trip a stranger reading the code cold.
- **What the code does NOT reveal** — these become Phase 3 questions.

**Do not read `~/.pi/agent/AGENTS.md` or `~/.agents/` files.** The repo's own files are the only source of truth for what the generated AGENTS.md should contain.

## Phase 3: Fill in the gaps

Use `questionnaire` to ask only what the code can't answer. Skip this phase entirely on the `let_pi` path. On the `review` path, ask only one question: *"Has anything changed about how the team works since this AGENTS.md was written (new conventions, commands, gotchas)?"* with options `"No — nothing's changed"` | `"Yes — let me describe"` (free text via the "Type something" option).

Otherwise, ask 1-3 focused questions at most. Examples:
- Non-obvious commands the code hints at but doesn't fully document (e.g., "do you run the full test suite or just one package most of the time?")
- Branch / PR conventions if CI didn't reveal them
- Required env setup or secrets the agent should be aware of (but **never** asking for the secret values themselves)

Do not mark options as "recommended". This is about how the team actually works, not best practices.

**Then synthesize a proposal.** For each item, pick the artifact type that fits:

- **AGENTS.md note** — guidance that shapes agent behavior (conventions, commands, gotchas).
- **Skill** — an on-demand multi-step workflow worth its own `/skill:name` (e.g., a release process, a deep-verify routine, a session-report format).

Print the proposal as normal assistant text, one bullet per item:

> Here's what I'd set up:
> • **AGENTS.md** — [one-line summary of what it will cover]
> • **Skill: `<name>`** — [one-line purpose]
> • …

Then call `questionnaire` once: prompt `"Does this look right?"`, options including `"Looks good — proceed"`, `"Drop <skill name>"` for each skill in the proposal, and rely on the auto-added "Type something" for free-text tweaks.

Build a preference queue from the accepted proposal: `[{type, name, description, target_file, source_details}]`. Phase 4 consumes the AGENTS.md notes; Phase 5 consumes the skill entries.

## Phase 4: Write AGENTS.md

Skip this phase entirely on the `leave` path.

On the `review` path: read the existing file, compare against Phase 2 findings and the Phase 3-lite answer, and propose specific additions and removals as a diff with a one-line reason for each. Print the diff, then call `questionnaire`: `"Apply these edits?"` with options `"Apply all"` | `"Let me pick which"` | `"Skip — leave it as is"`. Do not write until approved.

On the `fresh` / `agents_md` / `with_skills` / `let_pi` paths: write a minimal AGENTS.md at the project root.

**The discipline rule:** every line must pass this test:

> "Would removing this line cause an agent to make a mistake **about this repo**?"

This is scoped to the repo. Generic agent-hygiene rules ("use fd over find", "never use em dashes", "be concise") do **not** belong here — they belong in a teammate's personal global file, not in a committed repo file. Repo-specific commands (exact `npm`/`pnpm`/`cargo`/`make` invocations) **do** belong here even if your personal global already prescribes the pattern, because the file must be useful to teammates whose global says nothing.

**Write the file for a stranger.** Spell out commands. Don't write "the usual checks" — write `pnpm --filter web type-check && pnpm --filter web lint`.

Include:
- **Non-obvious build / test / lint / type-check / format commands** with workspace flags and pre-steps. Skip standard, manifest-obvious commands (`npm test`, `cargo test`, `pytest` with no flags).
- **Code style rules that deviate from language defaults** (e.g., "prefer `type` over `interface` in TypeScript", "no implicit `Optional` in Python").
- **Testing quirks** (e.g., "single test: `pytest -k <name>`", "integration tests need `docker compose up -d` first").
- **Branch / PR / commit conventions** (only if the repo has its own, non-default ones).
- **Required env vars or setup steps** that aren't in the README's quickstart.
- **Non-obvious architectural gotchas** that a fresh reader would trip over.
- **Important specifics from other AI tool configs** if discovered (`AGENTS.md`, `.cursor/rules/`, `.cursorrules`, `.github/copilot-instructions.md`, `.windsurfrules`, `.clinerules`). Distill, don't dump.

Always include (when Phase 2 found non-trivial commands) a section like:

```markdown
## Verification

After editing code, run the narrowest relevant static checks:

- <type-check command>
- <lint command>
- <test command — only if running tests is cheap and expected per change>
```

If the project's checks are exactly what the manifest implies (`npm test`, `pytest`, `cargo test` with no flags or pre-steps), omit this section. Note that omission for the Phase 6 summary.

Exclude:
- File-by-file structure or component lists (the agent discovers these by reading the repo).
- Standard language conventions any competent agent knows.
- Generic advice ("write clean code", "handle errors").
- Dependency lists or anything obvious from the manifest.
- Long API docs or tutorials. Link to docs with normal Markdown relative links, or cite code/config files as relative paths in backticks. Move long workflow instructions into a skill.
- Information that changes frequently. Reference the live source with normal Markdown links for docs, or relative paths in backticks for code/config.
- Agent prompt shorthand such as `@path/to/file` is forbidden in generated AGENTS.md; it is not portable Markdown for teammates.
- Personal preferences (yours or a teammate's). Those go in `~/.pi/agent/AGENTS.md`, not here.

Consume `note` entries from the Phase 3 preference queue. Add each as a concise line in the most relevant section.

Prefix the file with:

```markdown
# AGENTS.md

This file gives coding agents (pi, Codex, Claude Code, …) the repo-specific context they need to be useful here. Keep it concise: only include what an agent would get wrong without it.
```

For monorepos or multi-module projects, mention that **subdirectory AGENTS.md files** can be added for module-specific instructions; pi (and other harnesses) discover them by walking up from the cwd. Offer to create one if the user wants.

After writing, run `cat ./AGENTS.md` so the user sees the result inline.

## Phase 5: Suggest and create skills

Skip on the `agents_md` path. On `leave`, `with_skills`, `let_pi`, and `review` paths, consume `skill` entries from the Phase 3 preference queue.

For each skill, create `.agents/skills/<name>/SKILL.md`:

```yaml
---
name: <name>
description: <what it does and when to invoke it — be specific>
---

<Instructions for the agent>
```

Write the body from the user's own words plus what Phase 2 found (commands, formats, target files). Ask a quick follow-up if the preference is underspecified ("which test command should `verify-deep` run?").

Note for the user that:
- The model can auto-invoke the skill when relevant.
- They can also trigger it explicitly with `/skill:<name>`.
- For skills with side effects (deploys, schema migrations), add `disable-model-invocation: true` to the frontmatter so only the user can trigger them.

If `.agents/skills/` already contains skills, review them first. Do not overwrite. Only propose new ones that complement what exists.

## Phase 6: Summary

Print a recap:
- Which files were written or modified, with their paths.
- The key sections / commands captured in AGENTS.md.
- Names and one-line purposes of any new skills.
- If the Verification section was omitted because checks are manifest-standard, say so explicitly so the user knows it wasn't an oversight.
- A reminder that these files are a starting point; running `/init` again re-scans.

Then add a short to-do list of *optional* follow-ups, only including items that apply:
- If `gh` is missing AND the repo is on GitHub: suggest installing it.
- If no lint config was found for the project's primary language: suggest setting one up.
- If tests are missing or sparse: suggest setting up a test framework so the agent can verify its own changes.
- If you need *enforcement* (not just advice — e.g., compliance, security gates): mention that AGENTS.md is advisory; hard gates need a git pre-commit hook, CI, or a pi extension.

## Phase 7: Redundancy report

This phase runs **only** if Phase 4 wrote or modified AGENTS.md. Skip on the `leave` path.

Now (and not before) read `~/.pi/agent/AGENTS.md` and any other global agent files pi loads from the user's home. Compare the just-written AGENTS.md against the user's global **by intent, not by string match**. A repo line `pyright src/ && uvx ruff check src/` overlaps with a global line "prefer pyright + ruff" even though they share no exact text.

Print the overlaps as a single block:

> The following lines in the new AGENTS.md duplicate guidance already in your personal global (`~/.pi/agent/AGENTS.md`):
>
> - `<line or section>` — already covered by global: `<short paraphrase>`
> - …
>
> The default is to **keep them** — that makes this file useful to teammates whose global says nothing. Trim them only if this AGENTS.md will stay private (e.g., it won't be committed, or your team is small enough that everyone has the same global).

Do **not** offer to auto-trim. Leave the edit to the user.

If there are no overlaps, print one line: `No overlap with your personal global — the file is fully repo-specific.` and stop.
