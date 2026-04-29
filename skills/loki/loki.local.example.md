# Loki Local Configuration (template)

Copy this file to `loki.local.md` (same directory) and fill in values for your
Loki deployment. `SKILL.md` reads `loki.local.md` to learn your profiles,
tenant id, service shortcuts, and log field conventions. Without it the skill
can still operate but the agent will have to ask you for addresses, services,
and labels every time.

`loki.local.md` is gitignored.

## Connection Profiles

List one row per Loki instance you query. The `Profile` name is what the agent
matches against user phrases like "prod" or "staging".

| Profile | Loki address | Default environment label |
|---------|--------------|---------------------------|
| `dev`   | `http://loki.dev.example.internal`   | `dev`     |
| `stage` | `http://loki.stage.example.internal` | `staging` |
| `prod`  | `http://loki.prod.example.internal`  | `prod`    |

**Org / tenant id:** `my-tenant` (omit if your Loki is single-tenant)

**Default profile when the user does not specify one:** `dev`

## Profile Detection From User Language

Map phrases users actually type to a profile name above.

- `prod`, `production`, `live` -> `prod`
- `stage`, `staging`, `pre-prod` -> `stage`
- `dev`, `local`, unspecified -> `dev`

## Environment Label Resolution

- If the user explicitly names an environment, use it verbatim.
- Otherwise use the profile's default label from the table above.
- Known environment values per profile:
  - `dev`: `dev`, `dev1`, `dev2`
  - `stage`: `staging`
  - `prod`: `prod`
- If a query returns no streams, run live label discovery first:
  ```bash
  logcli --addr="<LOKI_ADDR>" [--org-id=<ORG_ID>] labels --since=168h environment
  ```

## Service Shortcuts

Map friendly names to the actual `app` label values your services use.

| User says | `app` label value |
|-----------|-------------------|
| `api`     | `myapp-api`       |
| `worker`  | `myapp-worker`    |
| `web`, `frontend`, `ui` | `myapp-web` |
| `all`, `*` | Query without `app` filter |

## Available Labels

List the labels your Loki streams expose, e.g.:

- `app` - Service name
- `environment` - Deployment environment
- `namespace`, `pod`, `container` - Standard Kubernetes labels (if applicable)

## Log Structure (JSON)

If your services emit JSON logs, list the fields the agent should use with
`| json | <field>=...`:

| Field | Description |
|-------|-------------|
| `level` | `info`, `debug`, `warn`, `error`, `fatal` |
| `message` | Log message text |
| `trace_id` | Distributed trace ID |
| `request_id` | Request correlation ID |
| `path` | HTTP endpoint |
| `method` | HTTP method |

If your services emit plain text, drop this section and rely on `|=` text
filters in queries.

## Defaults

- Time range: `1h`
- Result limit: `50` lines
- Tail timeout: `30` seconds
