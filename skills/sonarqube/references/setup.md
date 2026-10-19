# Setting up the sonarqube skill

## What you may and may not do

- **Never handle a token value.** Do not print, export, write or ask for one.
  Check presence with `test -n "$VAR"` at most. The user exports tokens in
  their shell profile and restarts pi, because pi's environment is fixed at
  startup.
- **Edit the config only when the user asks you to.** It holds no secrets, so
  you may write it on request. Merge into the existing JSON and keep every
  other entry.
- **Do not change the user's environment**: no shell profile edits, no
  certificate installs, no VPN or proxy changes.

## Diagnose from `me`

| Output | Cause | What to do |
|---|---|---|
| `no config at <path>` | First use | Create the config with the user (see below) |
| `<path>:` followed by a list of problems | Invalid config | Fix each listed problem; unknown keys are usually typos (`prefx`) |
| `<VAR> is not set` | Token missing in pi's environment | User creates a token (see below), exports it, restarts pi |
| `<VAR> contains whitespace, control or non-ASCII characters` | Token pasted with a newline or quotes | User re-exports it cleanly |
| `401 ... it is a ... analysis token` | Wrong token type | User creates a **User token** instead |
| `401 ... expired or revoked?` | Token no longer valid | User creates a new User token |
| `MR analysis: no (Community Build analyzes main only)` | Community Build without the branch plugin | Only `--main` works; tell the user |
| `Is the VPN up?` | Instance unreachable | If it is the current repo's instance, the user connects to the network it needs; other instances can be ignored |
| `TLS certificate error` | Corporate CA | User exports `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` |
| `repo ... is not mapped` | This checkout is not in the config | Map it (see below) |

## Create a token (user)

In SonarQube: avatar -> My Account -> Security -> Generate Tokens, type
**User Token**. Analysis tokens (`sqa_`, `sqp_` prefixes) only submit scans
and fail every read with `401`. Then:

```bash
# in ~/.profile or ~/.zprofile, under the name the config's tokenEnv gives
export SONARQUBE_CORP_TOKEN="squ_..."
```

A User token carries all of the user's permissions in SonarQube.

## The config file

Location: `${XDG_CONFIG_HOME:-$HOME/.config}/pi-clanker/sonarqube.json`, or the
path in `$SONARQUBE_CONFIG`. Template: `assets/sonarqube.example.json`.

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
        { "key": "team:frontend", "prefix": "" }
      ]
    }
  ]
}
```

| Field | Rules |
|---|---|
| `instances.<name>.url` | Base URL, including a context path if the server has one (`https://host/sonar`) |
| `instances.<name>.tokenEnv` | Name of the env var holding the token. Convention: `SONARQUBE_<NAME>_TOKEN` |
| `repos[].remote` | The repo's git remote in any spelling (SSH, HTTPS, or bare `host/path`); matched against every remote of the checkout |
| `repos[].instance` | One of the instance names |
| `repos[].projects[].key` | Sonar project key, exactly as on the server |
| `repos[].projects[].prefix` | Required, may be `""`. The directory Sonar's file paths are relative to |

Every key inside an entry is required, and unknown keys are rejected. `repos`
itself may be left out at first: with only `instances` configured, the
unmapped-repo error already lists server projects (see step 3). The repo's
name for `--repo` is the last segment of `remote`.

## Map a repo

You can gather all the facts yourself:

1. **Remote**: `git remote -v`. Use `host/path` without `.git`.
2. **Instance**: the server the repo's CI sends analyses to. Look for
   `sonar.host.url` or `SONAR_HOST_URL` in the CI config. If the URL is not
   in the repo (often a CI variable set at group level), ask the user.
3. **Project keys**: run any command in the checkout, e.g.
   `scripts/sonar.mjs projects`. For an unmapped repo the error lists server
   projects whose name resembles the repo. Cross-check with the repo:

   ```bash
   rg -n 'sonar\.projectKey|SONAR_PROJECT_KEY' -g '*.yml' -g '*.yaml' -g '*.properties' -g 'pom.xml' -g '*.gradle*' .
   ```

   A monorepo usually has one Sonar project per service. Keys built from CI
   variables (`${CI_PROJECT_ROOT_NAMESPACE}.SONAR.x`) must be resolved
   against the server list, not guessed.
4. **Prefix**, per project: the value of `sonar.projectBaseDir` in the CI
   config or `sonar-project.properties`. It is often passed through a CI
   variable (`-Dsonar.projectBaseDir=${SERVICE_DIR}`); follow the variable to
   each service's value. No base dir means `""`, because paths are relative
   to the repo root. `sonar.sources` does not change the prefix: a project
   with `sonar.sources=services/api/src` and no base dir still has prefix
   `""`.

   ```bash
   rg -n 'projectBaseDir|sonar\.sources' -g '*.yml' -g '*.yaml' -g '*.properties' .
   ```
5. **Propose** the complete `repos` entry to the user, and write it if they
   ask.
6. **Verify**:

   ```bash
   scripts/sonar.mjs me         # repo ... -> <instance>, N projects
   scripts/sonar.mjs projects   # "not found on the server" means a wrong key
   root=$(git rev-parse --show-toplevel)
   for p in $(scripts/sonar.mjs projects --json | jq -r '.[0].projects[].name'); do
     if ! out=$(scripts/sonar.mjs issues --main --project "$p" --limit 3 --json); then
       echo "$p: request failed (error above), prefix not checked"; continue
     fi
     paths=$(printf '%s' "$out" | jq -r '.issues[].path // empty')
     if [ -z "$paths" ]; then echo "$p: no open issues on main, prefix not checked"; continue; fi
     printf '%s\n' "$paths" | while IFS= read -r path; do
       test -e "$root/$path" || echo "$p: missing $path"
     done
   done
   ```

   When every sampled path of a project is missing, its prefix is wrong:
   compare a path Sonar reports with the file's real location. A single
   missing path can also be a file deleted or renamed in this checkout, since
   the sample comes from `main`. A project without open issues cannot be
   checked this way; confirm its prefix from the CI config.
