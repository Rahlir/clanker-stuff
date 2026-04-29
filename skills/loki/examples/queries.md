# Example Loki Queries

All queries below use placeholders. Resolve them from `loki.local.md` (or from
explicit user input) before running:

- `<LOKI_ADDR>` ‑ Loki address from the selected profile
- `<ORG_ID>` ‑ tenant id, only if your deployment requires `--org-id`
- `<SERVICE>` ‑ value of the `app` label (e.g. resolved from a service shortcut)
- `<ENV_LABEL>` ‑ value of the `environment` label
- `<REQUEST_ID>` / `<TRACE_ID>` ‑ specific id you are tracing

A fully resolved example using neutral names is shown at the bottom.

## Basic Log Queries

### Show recent logs from a service
```bash
logcli --addr="<LOKI_ADDR>" [--org-id=<ORG_ID>] query \
  --since=1h \
  --limit=50 \
  '{app="<SERVICE>",environment="<ENV_LABEL>"}'
```

### Search for specific text
```bash
logcli --addr="<LOKI_ADDR>" [--org-id=<ORG_ID>] query \
  --since=1h \
  --limit=50 \
  '{app="<SERVICE>",environment="<ENV_LABEL>"} |= "some text"'
```

### Filter by log level
```bash
logcli --addr="<LOKI_ADDR>" [--org-id=<ORG_ID>] query \
  --since=1h \
  --limit=50 \
  '{app="<SERVICE>",environment="<ENV_LABEL>"} | json | level="error"'
```

## Error Finding

### Find all errors and warnings for one service
```bash
logcli --addr="<LOKI_ADDR>" [--org-id=<ORG_ID>] query \
  --since=1h \
  --limit=50 \
  '{app="<SERVICE>",environment="<ENV_LABEL>"} | json | level=~"error|warning|critical"'
```

### Find errors across all services
```bash
logcli --addr="<LOKI_ADDR>" [--org-id=<ORG_ID>] query \
  --since=1h \
  --limit=100 \
  '{environment="<ENV_LABEL>"} | json | level=~"error|warning|critical"'
```

## Request Tracing

### Trace by request_id
```bash
logcli --addr="<LOKI_ADDR>" [--org-id=<ORG_ID>] query \
  --since=6h \
  --limit=200 \
  '{environment="<ENV_LABEL>"} |= "<REQUEST_ID>"'
```

### Trace by trace_id (OpenTelemetry)
```bash
logcli --addr="<LOKI_ADDR>" [--org-id=<ORG_ID>] query \
  --since=6h \
  --limit=200 \
  '{environment="<ENV_LABEL>"} |= "<TRACE_ID>"'
```

## Live Tailing

### Tail a service with timeout
```bash
timeout 30 logcli --addr="<LOKI_ADDR>" [--org-id=<ORG_ID>] query \
  --tail \
  --delay-for=2 \
  '{app="<SERVICE>",environment="<ENV_LABEL>"}'
```

### Tail errors only
```bash
timeout 30 logcli --addr="<LOKI_ADDR>" [--org-id=<ORG_ID>] query \
  --tail \
  --delay-for=2 \
  '{app="<SERVICE>",environment="<ENV_LABEL>"} | json | level=~"error|warning"'
```

## Service / Label Discovery

### List available services
```bash
logcli --addr="<LOKI_ADDR>" [--org-id=<ORG_ID>] labels --since=720h app
```

### List available environments
```bash
logcli --addr="<LOKI_ADDR>" [--org-id=<ORG_ID>] labels --since=720h environment
```

### List all labels
```bash
logcli --addr="<LOKI_ADDR>" [--org-id=<ORG_ID>] labels --since=720h
```

## Statistics

### Count errors in last hour
```bash
logcli --addr="<LOKI_ADDR>" [--org-id=<ORG_ID>] instant-query \
  'count_over_time({app="<SERVICE>",environment="<ENV_LABEL>"} | json | level="error" [1h])'
```

### Log volume stats
```bash
logcli --addr="<LOKI_ADDR>" [--org-id=<ORG_ID>] stats \
  --since=1h \
  '{app="<SERVICE>",environment="<ENV_LABEL>"}'
```

## Export

### Export to JSONL file
```bash
logcli --addr="<LOKI_ADDR>" [--org-id=<ORG_ID>] query \
  --since=1h \
  --limit=1000 \
  -o jsonl \
  '{app="<SERVICE>",environment="<ENV_LABEL>"}' > logs_<SERVICE>.jsonl
```

### Export errors with timestamp
```bash
logcli --addr="<LOKI_ADDR>" [--org-id=<ORG_ID>] query \
  --since=1h \
  --limit=1000 \
  -o jsonl \
  '{app="<SERVICE>",environment="<ENV_LABEL>"} | json | level=~"error|warning"' \
  > errors_$(date +%Y%m%d_%H%M%S).jsonl
```

## Advanced Filters

These assume your logs are JSON and contain the named fields. Field names
depend on your application's logging convention; see `loki.local.md` for the
fields used in your deployment.

### Filter by API endpoint
```bash
logcli --addr="<LOKI_ADDR>" [--org-id=<ORG_ID>] query \
  --since=1h \
  --limit=50 \
  '{app="<SERVICE>",environment="<ENV_LABEL>"} | json | request_path="/v1/example/"'
```

### Filter by calling service
```bash
logcli --addr="<LOKI_ADDR>" [--org-id=<ORG_ID>] query \
  --since=1h \
  --limit=50 \
  '{app="<SERVICE>",environment="<ENV_LABEL>"} | json | api_caller="<CALLER_SERVICE>"'
```

### Exclude debug logs
```bash
logcli --addr="<LOKI_ADDR>" [--org-id=<ORG_ID>] query \
  --since=1h \
  --limit=50 \
  '{app="<SERVICE>",environment="<ENV_LABEL>"} | json | level!="debug"'
```

## Fully Resolved Example

Assuming `loki.local.md` defines:

- profile `staging` with address `http://loki.staging.example.internal` and
  default environment label `staging`
- tenant id `my-tenant`
- service shortcut `api` -> `myapp-api`

then "show me errors from the api in staging in the last 30 minutes" becomes:

```bash
logcli --addr="http://loki.staging.example.internal" --org-id=my-tenant query \
  --since=30m \
  --limit=50 \
  '{app="myapp-api",environment="staging"} | json | level=~"error|warning|critical"'
```

And tracing a specific request id across all staging services:

```bash
logcli --addr="http://loki.staging.example.internal" --org-id=my-tenant query \
  --since=6h \
  --limit=200 \
  '{environment="staging"} |= "00000000-0000-0000-0000-000000000000"'
```
