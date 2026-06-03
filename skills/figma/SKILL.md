---
name: figma
description: Query Figma files via REST API. Use when the user pastes a figma.com URL or mentions Figma files, frames, nodes, components, variables, or design-system tokens (colors, spacing, typography).
---

# Figma

Use this skill to pull design context from Figma into implementation work. The common case is grounding code in the design — comparing implementation against a wireframe, applying the correct brand colors and spacing, or checking how a component should look. Less commonly, the user asks for a specific data lookup like "what value is the variable X". Either way, the user supplies a figma.com URL; fetch what's needed via `{baseDir}/figma.mjs` and apply it. All operations are read-only.

## Required setup

**Run this check first:**

```bash
test -n "$FIGMA_TOKEN" && {baseDir}/figma.mjs me
```

- If both succeed, the token is valid and the helper works.
- If `FIGMA_TOKEN` is unset, stop and tell the user to add it to `~/.profile` or `~/.zprofile`. Personal access token from https://www.figma.com/settings → Security. Scopes: `files:read`, plus `file_variables:read` for Enterprise design tokens.
- Do not export the token or edit shell profiles yourself.

## Before any operation

1. **Find or ask for a reference.** Look for a `figma.com/file/...` or `figma.com/design/...` URL in the user's message or the conversation.
   - URL present → parse and use directly. The helper extracts the file key and, if present, the `node-id` (URL form `12-345` becomes API form `12:345`).
   - No URL → ask the user for a file URL. Do not guess keys or ids; there is no API for finding files by name.
2. **Identify the intent.** Match to a task pattern below before running anything. If ambiguous, run `info` first to orient, or ask the user.
3. **Avoid redundant fetches.** If you already have the JSON from a previous call in the same turn, answer from it instead of refetching.

## Task patterns

### 1. Orient in a file

**Triggers:** "what's in this file", "show me the pages", "give me an overview", URL with no `node-id=`

**Command:**
```bash
{baseDir}/figma.mjs info <url|key>
```

Returns file metadata and the page list with child counts. Use as the entry point when you have the file key but do not yet know which page or frame to drill into.

### 2. Inspect a specific frame, layer, or component

**Triggers:** URL containing `node-id=`, "this frame", "this layer", "what's inside <name>"

**Commands:**
```bash
{baseDir}/figma.mjs node <url> [--depth N]
{baseDir}/figma.mjs node <key> <id[,id,...]> [--depth N]
```

Default depth is 2 (node + children + grandchildren). Raise `--depth` rather than chaining calls when going deeper.

### 3. Read design tokens

**Triggers:** "design tokens", "system colors", "spacing scale", "typography tokens", "what variables are defined"

**Command:**
```bash
{baseDir}/figma.mjs vars <url|key> [--collection NAME]
```

Returns variables grouped by collection and mode. If the response is empty (the file has no variables defined), fall back to `styles` (see task 4) for the legacy pre-variables system. A `403` is a different case: token or plan is missing `file_variables:read`; see Errors below.

### 4. List components or styles

**Triggers:** "what components exist", "component list", "what styles are defined", "design-system inventory"

**Commands:**
```bash
{baseDir}/figma.mjs components <url|key>   # named components + component sets
{baseDir}/figma.mjs styles     <url|key>   # color, text, effect, grid styles
```

For internals of a specific component, follow up with `node <key> <component-node-id>`.

### 5. Render a frame visually

**Triggers:** "show me", "what does it look like", "render this", "preview"

**Steps:**
1. Render and download:
   ```bash
   {baseDir}/figma.mjs image <url> [--format png|svg|pdf] [--scale 1|2|3]
   ```
2. The script prints the saved path under `/tmp/pi-figma-skill/`.
3. Use the `read` tool on that path to view the image.

Default is PNG at scale 1. Use SVG for vector assets you intend to reuse, PNG `--scale 2` for high-detail visual review.

### 6. Drill from file to page to frame

When the user asks about a region you have not seen yet:

1. `info <url>` to list pages.
2. `node <key> <page-id>` to list the page's top-level frames.
3. `node <key> <frame-id> --depth 3` to inspect the frame.

Reuse the parsed `<key>` across steps; do not re-extract it from the URL each time.

## Disambiguation

- **"Design system colors / spacing / typography"** → `vars` first (modern), `styles` second (legacy).
- **"Component X"** → metadata: `components`. Internal structure: `node <key> <component-id>`. Picture: `image`.
- **"Show me X"** → visual frame: `image`. Data (tokens, components, structure): the matching data command.
- **URL with no clear intent** → `info`, then ask the user what they want from it.

## Output handling

- Markdown output is hard-capped at ~200 lines. For full payloads (`jq`, programmatic use), add `--json`.
- Hidden variables (`hiddenFromPublishing`) are returned and tagged `(hidden)` so you can mention or filter them as needed.
- Summarize before dumping. Do not paste 200 lines of variable tables when the user asked for one color value.

## Errors that mean "stop"

- `403` on `vars` → token lacks `file_variables:read` (Enterprise feature). Tell the user; do not retry the same call.
- `404` on `node` → wrong id or wrong file key. Recheck the URL parse; do not guess at id variants.
- `401` → token is invalid or expired. Tell the user to regenerate; do not retry.
- `FIGMA_TOKEN env var not set` → setup incomplete. Point at the Setup section; do not export it yourself.

## NEVER

- **NEVER write to Figma.** This skill is read-only by design. Do not compose REST calls outside `figma.mjs`.
- **NEVER guess a file key or node id.** Parse from URLs or ask the user.
- **NEVER export `FIGMA_TOKEN` or edit the user's shell profile** without explicit permission.
- **NEVER refetch data already in scope** for the current turn.
- **NEVER use this skill for codegen** (frame → React/Tailwind/etc). Tell the user to use Figma Dev Mode's built-in "copy as code".

## Out of scope

Codegen, canvas writes, cross-file search, file discovery by name (no such API exists), comments, Code Connect mappings. Use Figma desktop or Dev Mode for those.
