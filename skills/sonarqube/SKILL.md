---
name: sonarqube
description: Read SonarQube quality gates, issues, coverage gaps and rule guidance for the current repo, mapped onto local files, and fix what Sonar flags. Use when the user mentions SonarQube or Sonar, a quality gate, a Sonar issue, a rule key such as python:S3776, coverage on new code, or pastes a SonarQube issue URL. Can also comment on issues and accept them or mark them false positive, only after the user approves.
compatibility: Requires Node.js 21+ and git. Works with SonarQube Server 10.4+ (10.8+ for the BLOCKER and INFO severities) and any Community Build (MR analysis on Community Build needs the community branch plugin). Needs a SonarQube user token per instance and a JSON config mapping repos to Sonar projects.
---

# SonarQube

Use this skill to find out what SonarQube reports for the repo you are working
in and to fix it. Everything goes through `scripts/sonar.mjs`. It maps every
issue from the code Sonar analyzed onto the local files, so line numbers in
`plan`, `issue` and `coverage` refer to the checkout in front of you.

**Run the script from inside the repo checkout**, with the absolute path to the
script. The current directory decides which repo, branch and MR the command
looks at. Do not `cd` into the skill directory.

## Required setup

**Run this check first:**

```bash
scripts/sonar.mjs me
```

You are ready when a `repo ... -> <instance>` line names the current repo and
that instance shows `ok`. Other instances do not matter for this repo: one
that fails (often because it needs a VPN) is not a reason to stop. To check a
single instance, run `scripts/sonar.mjs me --instance NAME`. If the current
repo's instance fails, the repo is not mapped, the config is missing, or any
command says the repo is not in the config, read
[references/setup.md](references/setup.md) and follow it. The user sets up tokens
themselves: never print, export or ask for a token value.

## Scope

By default a command looks at the current branch's MR analysis, else the
branch's own analysis, else `main`. The first output line names the scope and
why it was chosen. Override with `--mr N`, `--branch NAME` or `--main`.
`--repo NAME` works from outside a checkout; `--project A,B` narrows to some of
the repo's Sonar projects.

Sonar only re-analyzes in CI. After you fix something, the issue stays open
until the next pipeline analyzes the pushed code. When an MR or branch scope
was detected from the checkout, a `note:` under the scope line warns if the
checkout has commits or local changes newer than the analysis.

## Task patterns

### 1. "What does Sonar say?"

```bash
scripts/sonar.mjs gate      # pass/fail per project, failing conditions first
scripts/sonar.mjs summary   # counts by severity, project, and top rules
```

When a project fails on new issues or on coverage, `gate` adds a `->` line
with the command that lists them.

### 2. Fix issues

```bash
scripts/sonar.mjs plan                        # MR scope: everything new in the MR
scripts/sonar.mjs plan --main --rule python:S8415
```

`plan` groups issues by rule, prints the rule's guidance once, then every
location with a code excerpt and its secondary locations. On `main` it needs
`--rule`: fix one rule per pass, so the change stays reviewable. Do not fix
issues outside the task's scope (for example unrelated rules while working on
an MR) unless the user asks.

While iterating, re-run with `--guidance=off` to skip the guidance you already
read. After fixing, run the repo's own checks and tests, then tell the user the
issues will close after the next CI analysis.

Each location carries a status. Act on it:

| Status | Meaning | What to do |
|---|---|---|
| `exact` | Same line as analyzed, content verified | Fix it there |
| `moved from Ln` | Code shifted; the line was found and verified | Fix it at the new line |
| `changed since the analysis` | The flagged line was edited locally | Re-read the file; it may already be fixed |
| `stale` | Mapped, but the content no longer matches | Re-read the file before editing |
| `unverified` | Sonar's copy of the file was unavailable; best guess | Check the line before editing |
| `file missing locally` | The file is not in this checkout | Check out the right branch, or ask |
| `file-level` | The issue concerns the whole file | Read the message; fix the file as a whole |
| `as analyzed; no local checkout` | Run from outside the repo | Re-run inside the checkout before editing |
| `historical` | The issue is already fixed | Nothing to do |

### 3. One issue, or a pasted Sonar URL

```bash
scripts/sonar.mjs issue 'https://sonar.example.com/project/issues?id=team%3Aapi&open=AY...'
scripts/sonar.mjs issue AY3RO-PaL0Eep8PPRk7k
```

Shows status, location with code, secondary locations, comments, history, the
transitions Sonar allows, and the rule guidance. When the right fix is not
obvious, discuss it with the user before editing.

### 4. Coverage gate failed

```bash
scripts/sonar.mjs coverage              # coverage on new code: what the gate measures
scripts/sonar.mjs coverage --main --overall
```

Lists the files with the most uncovered lines, each with the exact uncovered
lines and partly covered branches (`L24 (1 of 2 covered)`). Write tests that
execute those lines, following the repo's existing test conventions.

### 5. Questions about a rule

```bash
scripts/sonar.mjs rule python:S7513 [--framework asyncio]
```

### 6. The user does not want to fix an issue

When the user decides an issue is a false positive or acceptable:

1. Draft the comment with the reason, plus the Jira key if there is follow-up
   work, and write it to a new file. Run `mktemp` on its own and note the path
   it prints, here `/tmp/tmp.Ab12Cd`. Each command runs in a fresh shell, so
   a variable such as `$REASON` would be gone by the time the user approves;
   always use the literal path.
2. Run the command **without** `--confirm` and show the user the dry run.
3. Only after the user approves that exact change, run the same command again
   with `--confirm`, reading the same, unchanged file. Then delete the file.

```bash
mktemp                                   # prints e.g. /tmp/tmp.Ab12Cd
cat > /tmp/tmp.Ab12Cd <<'EOF'
The `responses=` entry is generated by error_responses(); follow-up in PROJ-1234.
EOF
# To change the status (posts the reason as a comment first):
scripts/sonar.mjs transition <key|url> accept --comment-file /tmp/tmp.Ab12Cd   # or falsepositive
# Or, to only leave a comment:
scripts/sonar.mjs comment <key|url> --text-file /tmp/tmp.Ab12Cd
```

Run one of the two, never both: `transition` already posts the comment.
Always use the quoted heredoc and the `-file` forms: backticks and `$` in an
inline argument are expanded by the shell before the script sees them.

## Writing changes (gated)

Only `comment`, `accept` and `falsepositive` exist. Without `--confirm` they
print exactly what would be sent, including the Sonar user the write will be
attributed to, and send nothing. The script refuses, and you must not work
around it:

- **Security findings** (SECURITY impact, vulnerabilities): a human reviews
  them in the Sonar UI. Comments are allowed; status changes are not.
- **Transitions Sonar does not offer** for the issue in its current state.
- **Reasons shorter than 10 characters.**

## Credentials in code

For a file that holds a credential issue returned by Sonar, the script prints
`<code withheld: this file contains a credential finding; read it deliberately>`
instead of code. Security hotspots are not checked, including those retained
after an upgrade. This is not a general secret scanner: never quote a secret
from an excerpt just because the script printed it.

Read a withheld file only when the task is to fix that credential, and never
quote the secret in chat or in a Sonar comment. The fix is to load
the value from configuration or the environment; tell the user the secret has
to be rotated, because it stays in git history.

## Output handling

- Text output longer than 200 lines is written to a private temporary file
  and only the head is printed, followed by the file's path. Read the rest
  with `read` and an offset.
- `--json` returns the full data and is never cut. Use it with `jq` for fields
  the text omits.
- `issues` shows line numbers as analyzed. `plan`, `issue` and `coverage` show
  local line numbers.
- Summarize for the user. Do not paste a whole plan into the reply.

## Errors that mean "stop"

- `401` -> the token was rejected or is an analysis token. Tell the user; do
  not retry.
- `403` -> the user lacks permission on that project. Tell the user.
- `Is the VPN up?` -> the instance is unreachable. Tell the user.
- `answered with an unexpected page (an SSO proxy or login page?)` ->
  something between you and Sonar intercepted the request. Tell the user.
- `returned an unexpected response` or a Sonar error message on an otherwise
  successful request -> the server answered in a shape the script cannot
  trust. Tell the user; do not work around it.
- `issues come without an issueStatus field` -> the server is older than
  SonarQube 10.4. Tell the user; the skill cannot give correct results there.
- `503` -> Sonar is busy (often reindexing). Retry once after a minute, then
  tell the user.

## NEVER

- **NEVER print, echo or write a token**, including through `env`, `printenv`
  or `echo $VAR`. Check presence with `test -n "$VAR"` at most.
- **NEVER run `comment` or `transition` with `--confirm`** unless the user
  approved that exact change in this conversation.
- **NEVER try to dismiss a security finding**, and never work around a refusal.
- **NEVER quote withheld credential code** in chat, comments or commit messages.
- **NEVER edit code at a `changed`, `stale` or `unverified` location** without
  re-reading the file first.
