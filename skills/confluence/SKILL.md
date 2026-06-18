---
name: confluence
description: Read Confluence Server/DC wiki content via REST API. Use when the user pastes a Confluence URL, mentions Confluence, "the wiki", wiki pages or spaces, or asks to pull design docs, architecture notes, or meeting notes from Confluence.
compatibility: Requires Node.js 18+ and a Confluence Server/DC instance with a Personal Access Token (CONFLUENCE_URL + CONFLUENCE_TOKEN). Cloud (v2 API) not supported.
---

# Confluence

Use this skill to pull wiki context into the current work: reading design and architecture pages, searching for documentation, navigating page trees, and downloading attached diagrams. All operations go through `scripts/confluence.mjs` and are **read-only**. The common case is the user pasting a page URL or asking "what does the wiki say about X".

## Required setup

**Run this check first:**

```bash
test -n "$CONFLUENCE_URL" && test -n "$CONFLUENCE_TOKEN" && scripts/confluence.mjs me
```

- If it succeeds, the token is valid and the helper works.
- If either env var is unset, stop and tell the user to add both to `~/.profile` or `~/.zprofile`:
  - `CONFLUENCE_URL` — base URL of the instance, e.g. `https://wiki.example.com`
  - `CONFLUENCE_TOKEN` — Personal Access Token, created in Confluence under profile picture → Settings → Personal Access Tokens
- Do not export the variables or edit shell profiles yourself.
- A TLS error mentioning `NODE_EXTRA_CA_CERTS` means the instance uses a corporate CA; tell the user to export `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` themselves.

## Page references

Every command that takes a page accepts a bare numeric page id or any Server/DC URL form — the helper resolves all of these itself, **never resolve them manually**:

- `.../pages/viewpage.action?pageId=123456`
- `.../display/SPACE/Page+Title`
- `.../x/AbCdE` (tiny link)
- `.../spaces/SPACE/pages/123456/Title`

No URL and no id → search by title first (`search "title words" --type page`), confirm the hit with the user if ambiguous. Do not guess page ids.

## Task patterns

### 1. Read a page

**Triggers:** pasted page URL, "what does the wiki page say", "read this page"

```bash
scripts/confluence.mjs page <url|id>
```

Prints metadata (space, version, labels, ancestor path) and the body converted to markdown. Bodies longer than ~200 lines are written in full to `/tmp/pi-confluence-skill/<id>.md` with the path printed — use the `read` tool with offset for the rest. Macro placeholders like `[macro: drawio]` or `[image: x.png]` mean the actual content is an attachment; see pattern 4.

### 2. Search

**Triggers:** "find the page about X", "search the wiki", "is there documentation on X"

```bash
scripts/confluence.mjs search "query text" [--space KEY] [--type page] [--label X] [--limit N]
scripts/confluence.mjs search --cql 'CQL expression'
```

The simple form builds `text ~ "query"` CQL ordered by last modified. Note `text ~` also matches attachment *content* (PDFs, spreadsheets); add `--type page` when only pages are wanted.

Raw CQL patterns for the escape hatch:

| Need | CQL |
|---|---|
| Title match | `title ~ "voucher" AND type = page` |
| Recently changed in space | `space = ARCH AND lastmodified > now("-4w") order by lastmodified desc` |
| By contributor | `contributor = jdoe AND type = page` |
| Under a parent page | `ancestor = 123456` |
| Label + text | `label = "adr" AND text ~ "kafka"` |

### 3. Navigate a page tree

**Triggers:** "what's under this page", "list the subpages", exploring a doc hierarchy

```bash
scripts/confluence.mjs children <url|id>     # one level
scripts/confluence.mjs spaces [--query X]    # find a space key
```

For deep trees, chain `children` calls on the ids returned, or use `search --cql 'ancestor = <id>'` to get all descendants at once.

### 4. View attached diagrams and files

**Triggers:** `[image: ...]` / `[macro: drawio]` placeholders in page output, "show me the diagram"

```bash
scripts/confluence.mjs attachments <url|id>            # list with type/size
scripts/confluence.mjs attachment <url|id> <filename>  # download to /tmp/pi-confluence-skill/
```

Downloaded images can be viewed with the `read` tool. Draw.io diagrams attach both the source (`<name>`) and a rendered `<name>.png` — download the PNG.

### 5. Read the discussion

**Triggers:** "any comments on this page", "what was the feedback"

```bash
scripts/confluence.mjs comments <url|id>
```

Threads are flattened; each comment shows author, timestamp, and id.

## Output handling

- All commands accept `--json` for the raw API payload (full pagination links, `jq` processing).
- List outputs are capped at ~200 lines; narrow the query rather than paging through a dump.
- Summarize for the user. Do not paste a whole wiki page into the reply when one section answers the question.

## Errors that mean "stop"

- `401` → token invalid or expired. Tell the user to regenerate a PAT; do not retry.
- `403` → no permission for that space/page. Tell the user; do not retry as-is.
- `404` on `page` → wrong id or no read access. Recheck the URL parse; do not guess id variants.
- `no page titled "..."` → display-URL title lookup failed (renamed page?). Fall back to `search`.
- Env var / TLS errors → setup incomplete, see Required setup. Do not fix the environment yourself.

## NEVER

- **NEVER write to Confluence.** This skill is read-only. Do not compose REST calls outside `confluence.mjs`, and do not POST/PUT even if the user's instance would allow it — write support is a planned, separate addition.
- **NEVER guess page ids or space keys.** Parse from URLs, search, or ask.
- **NEVER export `CONFLUENCE_TOKEN`/`CONFLUENCE_URL` or edit shell profiles** without explicit permission.
- **NEVER dump entire pages into the reply** when the user asked a specific question.
- **NEVER refetch a page already converted in the current turn** — large pages persist at `/tmp/pi-confluence-skill/<id>.md`.

## Out of scope

Creating or editing pages, comments, or attachments (planned for a later version); Confluence Cloud instances (v2 API, different auth); blogposts beyond what `search --type blogpost` returns; user/group administration.
