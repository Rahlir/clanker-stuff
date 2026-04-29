# clunker-stuff

My personal collection of AI-agent workflow assets: prompts, skills, and a pi
extensions that I use for day-to-day coding work.

This repository is not a packaged product or framework. It is meant to be
useful in two ways:

- **Directly**, if you use pi or another agent that can load prompts, skills,
  or custom instructions from files.
- **As reference material**, if you want to adapt the workflows, safety rules,
  review prompts, or planning templates to your own AI-agent setup.

Most of the prompts and skills are plain Markdown, so they are not inherently
tied to pi. The only pi-specific components are the extensions in `extensions/`.

Note that I also use other skills and extensions (like
[glab](https://gitlab.com/gitlab-org/ai/skills/-/blob/main/skills/glab/SKILL.md?ref_type=heads)
or [questionnaire](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/questionnaire.ts)),
but these are maintained by others and I re-use them "as is" or with only minor
modifications. Hence, I don't include them here.

## Contents

```text
.
├── extensions/
│   └── code-review/              # pi extension that adds a code_review tool
├── prompts/                      # reusable prompt templates
└── skills/                       # agent workflow instructions and references
    ├── big-feature-workflow/
    ├── jira/
    └── loki/
```

## How to use this repository

### If you use pi

You can install the parts you want into pi's agent configuration directory.

Symlink installation, useful if you want to pull updates later:

```bash
mkdir -p ~/.pi/agent/extensions ~/.pi/agent/prompts ~/.pi/agent/skills

ln -sfn "$PWD/extensions/code-review" ~/.pi/agent/extensions/code-review
ln -sfn "$PWD/prompts" ~/.pi/agent/prompts
ln -sfn "$PWD/skills/big-feature-workflow" ~/.pi/agent/skills/big-feature-workflow
ln -sfn "$PWD/skills/jira" ~/.pi/agent/skills/jira
ln -sfn "$PWD/skills/loki" ~/.pi/agent/skills/loki
```

Copy installation:

```bash
mkdir -p ~/.pi/agent/extensions ~/.pi/agent/prompts ~/.pi/agent/skills

cp -R extensions/code-review ~/.pi/agent/extensions/code-review
cp -R prompts/* ~/.pi/agent/prompts/
cp -R skills/big-feature-workflow ~/.pi/agent/skills/big-feature-workflow
cp -R skills/jira ~/.pi/agent/skills/jira
cp -R skills/loki ~/.pi/agent/skills/loki
```

The `loki` skill needs a small extra step: copy `skills/loki/loki.local.example.md`
to `skills/loki/loki.local.md` (or to the same path under your installed copy)
and fill in your Loki addresses, tenant id, and service names. See the [loki
skill README](skills/loki/README.md) for details.

Restart pi after installing, or run `/reload` in an existing pi session.

For project-local setup, copy or symlink the same directories under a project's
`.pi/` configuration directory instead of `~/.pi/agent/`.

### If you use Claude Code, Codex, Amp, Droid, opencode, or a similar agent

The `prompts/` and `skills/` directories are mostly standard Markdown assets.
They should be straightforward to adapt for agents that support the agent
skills spec, reusable prompts, slash commands, or custom instructions.

Typical adaptation paths:

- copy `skills/*/SKILL.md` into your agent's skills directory, adjusting
  metadata if your agent uses a slightly different format;
- copy files from `prompts/` into your agent's prompt, command, or template
  directory;
- reuse `skills/big-feature-workflow/templates/` as-is for plan/task/devlog
  artifacts;
- adapt tool names and command references where your agent differs from pi.

Some files mention pi-specific concepts such as `/reload`, extension loading,
or the `code_review` tool. Treat those as pi integration details, not as core
parts of the workflows.

## Components

### [`extensions/code-review/`](extensions/code-review/)

A pi-specific extension that adds a `code_review` tool. It runs a separate
reviewer subagent and reports findings by severity. See the [extension
README](extensions/code-review/README.md) for installation, configuration,
usage, and troubleshooting.

### [`prompts/`](prompts/)

Reusable prompt templates for debugging, suggestions, review, GitLab MR review,
implementation with review, and review-fix loops. They are plain Markdown and
should map cleanly to prompt or command systems in Claude Code, Codex, Amp,
Droid, opencode, and similar agents.

### [`skills/big-feature-workflow/`](skills/big-feature-workflow/)

A structured workflow for planning, implementing, and reviewing larger features
or refactors through persistent `docs/ai/` artifacts. See the [big feature
workflow README](skills/big-feature-workflow/README.md) for details.

### [`skills/jira/`](skills/jira/)

A Jira workflow skill built around the local `jira` CLI. See the [Jira skill
README](skills/jira/README.md) for requirements, examples, and safety rules.

### [`skills/loki/`](skills/loki/)

A Loki log exploration skill built around the `logcli` CLI. Translates plain
language requests into LogQL queries for searching, error hunting, request
tracing, live tailing, and exporting logs. Deployment specific values (Loki
addresses, tenant id, service names, label conventions) live in a gitignored
`loki.local.md` next to the skill, so the published skill stays generic. See
the [loki skill README](skills/loki/README.md) for setup.

## Updating

If you installed with symlinks, pull updates in this repository and reload your
agent if needed.

If you copied files, copy the updated directories into your agent configuration
again.

## Notes

- This is a personal setup, so some assumptions reflect my workflow and tools.
- The Markdown prompts and skills are intended to be edited. Fork them, rename
  them, remove irrelevant constraints, or adjust their metadata for your
  agent's skill/prompt format.
- The repository does not define a standalone application, package, or test
  suite.
