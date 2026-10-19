# SonarQube Skill

Lets an agent read what SonarQube reports for the repo it works in (quality
gates, issues, coverage gaps, rule guidance) and fix it. A single
zero-dependency Node helper (`scripts/sonar.mjs`) talks to the SonarQube web
API.

The helper maps every finding from the code Sonar analyzed onto your local
checkout: it diffs Sonar's copy of each file against the local file and
verifies the flagged line by its hash. The agent can therefore fix issues
even on a branch that has moved on since the last analysis.

## What it does

| Command | Purpose |
|---|---|
| `me` | Check the config, then auth, edition and version of each instance |
| `projects` | Mapped projects with main-branch gate and last analysis |
| `gate` | Quality gate per project, failing conditions first |
| `summary` | Issue counts by severity, quality, project, and top rules |
| `issues` | Issues grouped by file, with filters (rule, severity, quality, status, file) |
| `plan` | Worklist for fixing: issues by rule and file, mapped onto local lines, with code, secondary locations, and the rule's guidance |
| `issue KEY\|URL` | One issue in full; accepts a pasted Sonar issue URL |
| `rule KEY` | A rule's full description, all framework variants |
| `coverage` | Coverage on new code per project, then files with exact uncovered lines and partly covered branches |
| `comment`, `transition` | Comment on an issue, accept it, or mark it false positive (dry run unless `--confirm`) |

By default every command looks at the current branch's MR analysis, falling
back to the branch's own analysis and then to `main`. `--mr N`, `--branch NAME`
and `--main` override that. Run `scripts/sonar.mjs --help` for every flag.

## Prerequisites

- Node.js 21 or newer, and git.
- SonarQube Server 10.4 or newer (10.8+ for the BLOCKER and INFO severities),
  or any Community Build. Older servers lack the issue status fields the
  helper relies on, so the commands that list issues stop with an error there.
  MR (pull request) analysis on Community Build needs the
  [community branch plugin](https://github.com/mc1arke/sonarqube-community-branch-plugin);
  without it only `main` is available.
- A SonarQube **User token** for each instance. Project and global analysis
  tokens can only submit scans and get `401` on every read.

## Setup

**1. Create a token** in SonarQube under My Account -> Security -> Generate
Tokens, type *User Token*, and export it in your shell profile
(`~/.profile` / `~/.zprofile`). Restart pi so it sees the variable.

```bash
export SONARQUBE_CORP_TOKEN="squ_..."
```

**2. Write the config** at `~/.config/pi-clanker/sonarqube.json` (honors
`$XDG_CONFIG_HOME`; `$SONARQUBE_CONFIG` overrides the path). Start from the
template:

```bash
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/pi-clanker"
cp assets/sonarqube.example.json "${XDG_CONFIG_HOME:-$HOME/.config}/pi-clanker/sonarqube.json"
```

```json
{
  "instances": {
    "corp": { "url": "https://sonarqube.example.com", "tokenEnv": "SONARQUBE_CORP_TOKEN" }
  },
  "repos": [
    {
      "remote": "gitlab.example.com/team/monorepo",
      "instance": "corp",
      "projects": [
        { "key": "team.SONAR.service-c", "prefix": "services/service-c" },
        { "key": "team.SONAR.frontend", "prefix": "apps/frontend" }
      ]
    }
  ]
}
```

`tokenEnv` is the *name* of the variable holding the token; the token itself
never goes in this file. `prefix` is the directory Sonar's file paths are
relative to: `""`, or the service directory when the scanner sets
`sonar.projectBaseDir`.

The field rules, how to find project keys and prefixes in a repo's CI config,
and a check that the prefixes are right are in
[references/setup.md](references/setup.md). It is written for the agent, so you
can also ask the agent to map a repo for you.

If an instance uses a corporate CA, also export
`NODE_EXTRA_CA_CERTS=/path/to/ca.pem`.

**3. Verify**, from inside a mapped checkout, using the path where the skill is
installed:

```bash
<skill dir>/scripts/sonar.mjs me
<skill dir>/scripts/sonar.mjs projects
```

## Safety

- **Tokens** are read only from the environment. They are never printed, and
  they are redacted from any error message that might echo them.
- **Writes** are limited to commenting, accepting and marking false positive.
  They are dry runs unless `--confirm` is passed, and `SKILL.md` tells the
  agent to pass it only after you approve the exact change. The comment (your
  reason) is posted before the status changes, so the reason is on record even
  if the transition fails.
- **Security findings** cannot be accepted or marked false positive through
  the helper; a person decides those in the Sonar UI.
- **Credentials**: the helper withholds code from files with credential issues
  returned by Sonar (also checked on `main` and the MR's target branch).
  Security hotspots and unreported secrets are outside this check.

## Limitations

- Security hotspots are not covered. Hotspot rules are being converted to
  ordinary security issues, which the helper handles, but existing hotspots
  can remain after an upgrade.
- Sonar re-analyzes only in CI, so a fix shows up after the next pipeline.
- Exact uncovered lines come from `api/sources/lines`, an internal endpoint the
  Sonar UI uses. If it changes, `coverage` falls back to per-file counts and
  says so.
- Text output over 200 lines is written to a private file in a per-user
  temporary directory, and only its head is printed. `--json` output is never
  cut.

## Example prompts

- "Is the quality gate green for this MR?"
- "What does Sonar say about this branch? Fix the new issues."
- "Fix all `python:S8415` issues on main in the management service."
- "The coverage gate fails, which lines need tests?"
- "Here's a Sonar issue: <URL>. What's the right fix?"
- "This one is a false positive, mark it as such and reference PROJ-1234."

## Files

- `SKILL.md`: agent-facing instructions and workflows.
- `scripts/sonar.mjs`: the CLI.
- `scripts/lib/`: config, HTTP client, scope resolution, issue search, line
  mapping, rule rendering, coverage, and the write policy.
- `references/setup.md`: setup and repo mapping, read by the agent when the
  setup check fails.
- `assets/sonarqube.example.json`: config template.
