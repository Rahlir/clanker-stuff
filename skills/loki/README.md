# Loki Skill

Natural language log exploration over a [Loki](https://grafana.com/oss/loki/)
instance using the [`logcli`](https://grafana.com/docs/loki/latest/query/logcli/)
client.

## What It Does

This skill lets an AI agent translate plain language requests like "show me
errors from the api in staging in the last 30 minutes" into the right `logcli`
invocation, run it, and summarize the results.

It covers:

- Querying logs with text, level, and field filters
- Finding errors and warnings
- Tracing a request across services by `request_id` or `trace_id`
- Live tailing with a timeout
- Discovering available services and labels
- Counting / aggregating log volume
- Exporting matched logs to a file

## Prerequisites

This skill requires the `logcli` CLI to already be installed and reachable on
`PATH`. The agent will not install or configure it on its own.

Suggested user-run setup:

```bash
# macOS
brew install logcli

# Linux: download a release binary from
# https://github.com/grafana/loki/releases
```

Verify:

```bash
which logcli
logcli --version
```

## Required Local Configuration

The `SKILL.md` file is intentionally generic. All deployment-specific values
(Loki addresses, tenant id, service names, environment labels, log field
conventions) live in a separate file in this directory:

```
skills/loki/
├── README.md
├── SKILL.md
├── loki.local.md           <- your deployment's config (gitignored)
├── loki.local.example.md   <- template, copy and edit
└── examples/queries.md
```

To set up:

1. Copy the template:
   ```bash
   cp skills/loki/loki.local.example.md skills/loki/loki.local.md
   ```
2. Edit `loki.local.md` with your Loki addresses, tenant id (if any), service
   shortcuts, and known label values.
3. The agent will read it automatically the next time you invoke the skill.

`loki.local.md` is listed in the repository's `.gitignore` so your private
hostnames and service names never get committed.

If `loki.local.md` is missing, the agent will tell you and ask for the minimum
information needed to answer the current question.

## Example Prompts

- "Show recent logs from the api in staging"
- "Find errors in prod in the last hour"
- "Trace request 00000000-0000-0000-0000-000000000000 across all services"
- "Tail the worker for 60 seconds"
- "What services are available in test?"
- "How many errors did the api throw in the last hour?"
- "Export warnings from prod to a file"

## Files

- `SKILL.md` ‑ generic, agent-facing instructions and command templates.
- `loki.local.md` ‑ your deployment's profiles, services, and conventions
  (gitignored).
- `loki.local.example.md` ‑ template for the local config.
- `examples/queries.md` ‑ reference query patterns with placeholders plus one
  fully resolved neutral example.
