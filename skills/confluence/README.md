# Confluence Skill

Read-only access to a [Confluence](https://www.atlassian.com/software/confluence)
Server/Data Center wiki via its REST API, driven by the bundled
`scripts/confluence.mjs` helper.

## What It Does

Lets an AI agent pull wiki context into your work: reading design and
architecture pages, searching for documentation, navigating page trees, reading
comments, and downloading attached diagrams. Every operation is **read-only**.
The common case is pasting a page URL or asking "what does the wiki say about X".

## Prerequisites

- **Node.js 18+** on `PATH` (the helper uses the built-in `fetch`; no `npm install`).
- A Confluence **Server/DC** instance. Cloud (v2 API, different auth) is not supported.

## Setup

Set two environment variables in your shell profile (`~/.profile` / `~/.zprofile`):

```bash
export CONFLUENCE_URL="https://wiki.example.com"   # base URL of the instance
export CONFLUENCE_TOKEN="<personal access token>"  # bearer token
```

Create the token in Confluence under **profile picture → Settings → Personal
Access Tokens**. If your instance uses a corporate CA, also export
`NODE_EXTRA_CA_CERTS=/path/to/ca.pem`. The agent will never export these or edit
your profile for you.

Verify:

```bash
scripts/confluence.mjs me
```

## CLI Reference

Run from the skill directory. `<url|id>` accepts a bare page id or any Server/DC
URL form (`?pageId=`, `/display/SPACE/Title`, `/x/` tiny link, new-UI
`/pages/<id>`).

| Command | Purpose |
|---|---|
| `me` | Authenticated user / token check |
| `page <url\|id>` | Page metadata + body as markdown |
| `search <text> [--space KEY] [--type page\|blogpost] [--label X] [--limit N]` | Search by text |
| `search --cql 'CQL'` | Raw CQL escape hatch |
| `children <url\|id>` | Child pages (one level) |
| `spaces [--query X]` | List spaces |
| `comments <url\|id>` | Page comments, threads flattened |
| `attachments <url\|id>` | List attachments on a page |
| `attachment <url\|id> <filename>` | Download an attachment |

Add `--json` to any command for the raw API response instead of markdown.

Run `scripts/confluence.mjs --help` for the full inline reference.

## Notes

- Large page bodies and downloaded attachments are written to
  `/tmp/pi-confluence-skill/`; only the first ~200 lines of a body print inline.
- `401`/`403`/`404` mean stop: regenerate the token, request access, or recheck
  the URL rather than retrying.

## Example Prompts

- "Read this Confluence page: <url>"
- "Search the wiki for the voucher redemption design"
- "What's under the Architecture parent page?"
- "Show me the diagram attached to <url>"
- "Any comments on <url>?"

## Files

- `SKILL.md`: agent-facing instructions and task patterns.
- `scripts/confluence.mjs`: the read-only REST helper (Node.js, no dependencies).
