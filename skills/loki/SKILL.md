---
name: loki
description: Query and explore application logs using Loki and the logcli CLI. Use when searching logs, finding errors, tracing requests across services, tailing services live, or investigating production/staging issues.
---

# Loki Log Explorer

Query, search, analyze, and tail logs from any Loki instance using `logcli`.

## Required CLI

This skill only supports the `logcli` CLI (the official Loki client).

**Run this check first:**

```bash
which logcli
```

- If `logcli` is available, use the commands below.
- If `logcli` is not available, stop and tell the user the CLI is required.
- Do not install the CLI unless the user explicitly asks you to perform setup.

Setup reference (for the user, not the agent): https://grafana.com/docs/loki/latest/query/logcli/

## Local Configuration

Before answering any query, read the file `loki.local.md` from this skill's
directory (the directory containing this `SKILL.md`). It supplies:

- Connection profiles (name -> Loki address, default environment label)
- Org / tenant id, if the deployment is multi-tenant
- Default profile when the user does not specify one
- Service shortcuts (user-friendly name -> `app` label value)
- Known label values and JSON log field conventions
- Default time range, limit, and tail timeout

If `loki.local.md` does not exist:

1. Tell the user the local config is missing.
2. Point them at `loki.local.example.md` in the same directory as a template.
3. Ask them for the minimum needed to proceed (Loki address, tenant id if any,
   one or more service / label names) and continue with those values for the
   current session.

All concrete values in this file are placeholders. Resolve them from the local
config or from explicit user input.

## Base Command

```bash
logcli --addr="<LOKI_ADDR>" [--org-id=<ORG_ID>] <subcommand> ...
```

- `<LOKI_ADDR>` from the selected profile in `loki.local.md`.
- `--org-id=<ORG_ID>` only if the local config defines one.
- Tail commands must be wrapped in `timeout <SECONDS>` so they always exit.

## Profile and Environment Resolution

1. Detect the profile from user language using the mapping in `loki.local.md`.
2. If unspecified, use the default profile from `loki.local.md`.
3. Set `LOKI_ADDR` from that profile.
4. Resolve `<ENV_LABEL>`:
   - If the user explicitly names an environment, use it.
   - Otherwise use the profile's default environment label.
5. If a query returns no streams or labels look inconsistent, discover labels
   live before guessing:
   ```bash
   logcli --addr="<LOKI_ADDR>" [--org-id=<ORG_ID>] labels --since=168h environment
   ```

## Service Shortcut Resolution

When the user names a service, map it through the shortcut table in
`loki.local.md` to the actual `app` label value. If the user uses `all` or
`*`, omit the `app` filter from the LogQL selector.

## Task Instructions

Parse the user's natural language request and execute the appropriate `logcli`
command. The seven task patterns below cover the common cases.

### 1. Query Logs

**Triggers:** "show logs", "find logs", "search", "what happened"

**Steps:**
1. Extract: profile/environment intent, service name, time range, text
   patterns, log level, limit.
2. Resolve profile, env label, and `app` value via local config.
3. Build a LogQL query.
4. Execute and present results with analysis.

**Command template:**
```bash
logcli --addr="<LOKI_ADDR>" [--org-id=<ORG_ID>] query \
  --since=1h \
  --limit=50 \
  '{app="<SERVICE>",environment="<ENV_LABEL>"} | json | <filters>'
```

### 2. Find Errors

**Triggers:** "errors", "warnings", "what went wrong", "failures"

**Command:**
```bash
logcli --addr="<LOKI_ADDR>" [--org-id=<ORG_ID>] query \
  --since=1h \
  --limit=50 \
  '{app="<SERVICE>",environment="<ENV_LABEL>"} | json | level=~"error|warning|critical"'
```

**Analysis:** Count errors vs warnings, group by type, show timeline.

### 3. Trace Requests

**Triggers:** "trace", "follow", "debug request", mentions of `request_id` or `trace_id`

**Command:**
```bash
logcli --addr="<LOKI_ADDR>" [--org-id=<ORG_ID>] query \
  --since=6h \
  --limit=200 \
  '{environment="<ENV_LABEL>"} |= "<REQUEST_ID>"'
```

**Analysis:** Show chronological timeline across services, highlight errors.

### 4. Tail Logs (Real-time)

**Triggers:** "tail", "stream", "watch", "live"

**Command (always wrap in `timeout`):**
```bash
timeout 30 logcli --addr="<LOKI_ADDR>" [--org-id=<ORG_ID>] query \
  --tail \
  --delay-for=2 \
  '{app="<SERVICE>",environment="<ENV_LABEL>"}'
```

Default timeout: 30 seconds (or the value in `loki.local.md`). User can
override.

### 5. Service / Label Discovery

**Triggers:** "what services", "list", "available", "labels"

**Commands:**
```bash
# List services (values of the `app` label)
logcli --addr="<LOKI_ADDR>" [--org-id=<ORG_ID>] labels --since=720h app

# List environments
logcli --addr="<LOKI_ADDR>" [--org-id=<ORG_ID>] labels --since=720h environment

# List all labels
logcli --addr="<LOKI_ADDR>" [--org-id=<ORG_ID>] labels --since=720h
```

### 6. Log Statistics

**Triggers:** "how many", "count", "volume", "rate"

**Command:**
```bash
logcli --addr="<LOKI_ADDR>" [--org-id=<ORG_ID>] instant-query \
  'count_over_time({app="<SERVICE>",environment="<ENV_LABEL>"} | json | level="error" [1h])'
```

### 7. Export to File

**Triggers:** "export", "save", "download"

**Command:**
```bash
logcli --addr="<LOKI_ADDR>" [--org-id=<ORG_ID>] query \
  --since=1h \
  --limit=1000 \
  -o jsonl \
  '{app="<SERVICE>",environment="<ENV_LABEL>"}' > logs_<SERVICE>_$(date +%Y%m%d_%H%M%S).jsonl
```

## Time Range Parsing

| User says | `--since` value |
|-----------|-----------------|
| "last hour", "1h" | `1h` |
| "last 30 minutes", "30m" | `30m` |
| "last 3 hours", "3h" | `3h` |
| "today", "24h" | `24h` |
| "last 6 hours" | `6h` |

## Output Format

1. Show the selected profile, Loki address, and environment label.
2. Show the LogQL query executed (for transparency).
3. Show raw log output.
4. Provide analysis:
   - Summary of findings
   - Key events or patterns
   - Error / warning counts
   - Recommendations

## Examples

See [examples/queries.md](examples/queries.md) for common query patterns
written with placeholders and a fully resolved neutral example.
