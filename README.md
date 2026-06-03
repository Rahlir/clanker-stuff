# clanker-stuff

My personal collection of AI-agent workflow assets: prompts, skills, and pi
extensions that I use for day-to-day coding work.

This repository is not a packaged product or framework. It is meant to be
useful in two ways:

- **Directly**, if you use pi or another agent that can load prompts, skills,
  or custom instructions from files.
- **As reference material**, if you want to adapt the workflows, safety rules,
  review prompts, or planning templates to your own AI-agent setup.

The prompts are plain Markdown and skills follow [agent skills
spec](https://agentskills.io/specification), so they are not inherently tied to
`pi`. The only pi-specific components are the extensions in `extensions/` and
themes in `themes/`.

## Related skills and extensions

Some assets here reference skills and extensions that are maintained by others
and are **not** bundled in this repo. The repo works without them, but for the
full out-of-the-box experience install the ones whose features you want, since
the referencing prompt or skill assumes the tool is available.

| External tool | Type | Used by (in this repo) | Source |
|---------------|------|------------------------|--------|
| `glab` | skill | `prompts/mr-review.md` (gathers MR context) | [gitlab-org/ai/skills](https://gitlab.com/gitlab-org/ai/skills/-/blob/main/skills/glab/SKILL.md?ref_type=heads) |
| `browser-tools` | skill | `prompts/debug.md` (replicate frontend workflow in a browser) | [badlogic/pi-skills](https://github.com/badlogic/pi-skills) (Mario Zechner) |
| `questionnaire` | extension | `skills/grill-me/SKILL.md` (structured question batches) | [earendil-works/pi examples](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/questionnaire.ts) |

I re-use these "as is" or with only minor modifications, so they are not
included here. Install them through their own sources.

Note also that the review prompts (`prompts/implement-and-review.md`,
`prompts/perform-review-loop.md`) rely on the `code_review` tool, which is
provided by this repo's own `extensions/code-review`, so no external install is
needed for those, but they will not work in non-pi harnesses.

## Contents

```text
.
├── extensions/                   # pi extensions
├── themes/                       # pi themes
├── prompts/                      # reusable prompt templates (pi specific format)
└── skills/                       # agent skills (agent skills spec - https://agentskills.io/specification)
```

## How to use this repository

### If you use pi

This repository is a pi package (see `package.json`), so the recommended way to
install it is pi's package manager. This pulls in all extensions, skills, and
prompts in one step and gives you a clean update path.

```bash
pi install git:github.com/Rahlir/clanker-stuff@v0.1.0    # global (~/.pi/agent)
pi install -l git:github.com/Rahlir/clanker-stuff@v0.1.0  # project-local (.pi/)
```

Replace `@v0.1.0` with the tag you want to pin to. Project-local installs are
written to `.pi/settings.json`, which you can commit so teammates get the same
tooling automatically on startup.

Update later with:

```bash
pi install git:github.com/Rahlir/clanker-stuff@<new-tag>  # move to a new tag
pi update --extensions                                    # reconcile pinned refs
```

Use `pi list` to see installed packages and `pi config` to enable or disable
individual extensions, skills, or prompts from this package.

Restart pi after installing, or run `/reload` in an existing pi session.

### If you use Claude Code, Codex, Amp, Droid, opencode, or a similar agent

The `prompts/` and `skills/` directories are mostly standard Markdown assets.
They should be straightforward to adapt for agents that support the agent
skills spec, reusable prompts, slash commands, or custom instructions.

Typical adaptation paths:

- copy or symlink `skills/*/SKILL.md` into your agent's skills directory, adjusting
  metadata if your agent uses a slightly different format;
- copy or symlink files from `prompts/` into your agent's prompt, command, or template
  directory;
- You might have to adapt tool names and command references where your agent
  differs from pi.

Some files mention pi-specific concepts such as `/reload`, extension loading,
or the `code_review` tool. Treat those as pi integration details, not as core
parts of the workflows.

## Configuration and secrets

See each component's own README / SKILL.md for the exact setup steps.

## Updating

If you installed the pi package, pin to a new tag with
`pi install git:github.com/Rahlir/clanker-stuff@<new-tag>` and run
`pi update --extensions` to reconcile the checkout, then reload your agent.

If you installed with symlinks or copies, pull updates in this repository
(re-copy) and reload your agent if needed.

## Notes

- This is a personal setup, so some assumptions reflect my workflow and tools.
- The Markdown prompts and skills are intended to be edited. Fork them, rename
  them, remove irrelevant constraints, or adjust their metadata for your
  agent's skill/prompt format.
