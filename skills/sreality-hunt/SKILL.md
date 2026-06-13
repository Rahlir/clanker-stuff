---
name: sreality-hunt
description: Apartment and house hunting on sreality.cz. Maintains saved searches, fetches new and changed listings, evaluates individual listings (URL paste or hash id), records the user's reactions, and distills patterns into learned preferences. Use when the user mentions sreality, real estate listings, apartment / house hunting, "byt" or "dům", or pastes a sreality.cz URL.
---

# Sreality Hunt

CLI-driven apartment / house hunting on sreality.cz. The CLI is non-LLM:
it fetches data, runs deterministic must-have checks, computes price
percentiles, and produces structured markdown. The qualitative judgment
(grading, red flags, recommendations) is **your** job - this skill exists
to give you the data to reason over.

Two key paths to remember (relative to this skill's directory):

  * **Binary**: `.venv/bin/sreality-hunt`
  * **Example YAML** (filter / must-have / preference syntax): `examples/search.example.yaml`

Everything else (saved searches, DB) lives under XDG defaults.

## First-run check

Before running any command, verify the venv exists. If it doesn't, tell the
user to run this from the skill's directory:

```bash
uv sync && .venv/bin/sreality-hunt db init
```

Do not run setup on the user's behalf unless they explicitly ask. The
`db init` is idempotent.

Also check whether the user has any saved searches at all:

```bash
.venv/bin/sreality-hunt search list
```

If the output is `No saved searches in ...`, and the user's intent
requires a search (digest, search-scoped evaluate, etc.), jump to
**Workflow 0** before doing anything else.

## Division of responsibilities

| Layer | Owns |
|---|---|
| CLI (deterministic) | API fetches + persistence, must-have checks, tier classification (`match` / `near-miss` / `fail`), price percentile, snapshot dedup, change detection (≥5% price delta), `seen` tracking |
| You (qualitative) | Grade (A-F + numeric 0-100), red flags, qualitative analysis of description / photos / locality / soft preferences, next-action suggestions, conversational presentation |

The CLI **never** assigns a grade. You read its structured output (tier,
percentile, must-have results, facts, description, photos) plus the
INPUTS appendix (soft preferences + learned preferences + few-shot
reactions) and produce the grade. There is no "prelim grade" to adjust
or annotate around; you own grade end-to-end.

---

## Workflow 0: Setting up a saved search

**Triggers**:
  * `search list` returned `No saved searches in ...` and the user wants to
    start hunting
  * User explicitly asks ("help me set up a search", "create a search
for...")
  * Existing saved searches clearly don't fit the user's stated intent
    (e.g. they're hunting in a different city, different price range)

A saved search is a YAML file at
`~/.config/sreality-hunt/searches/<name>.yaml`. The schema is documented
(with comments) in `examples/search.example.yaml` - read this
first, it's the canonical reference for every filter, every must-have
check, and the soft-preferences format.

### Step 1: Interview the user

Gather enough information to fill in the YAML. Don't fire questions in
one batch - work through them naturally as conversation. The agreed
set:

  * **Categories**: apartment, house, or both? (`category: [apt]`,
    `[house]`, or `[apt, house]`)
  * **Transaction type**: sale, rent, or auction? Default `sale`.
  * **Location**: which city, which districts? You need integer IDs in
    the YAML; see "Location IDs" at the bottom.
  * **Budget**: max price in CZK (and min if relevant).
  * **Area**: min m² (and max if relevant).
  * **Dispositions** (apartments only): which sizes? (`1+kk`, `1+1`,
    `2+kk`, `2+1`, `3+kk`, `3+1`, `4+kk`, `4+1`, `5+kk`, `5+1`, `6+`,
    `atypical`)
  * **House types** (houses only): `family`, `villa`, `cottage`,
    `chalet`, `agricultural`, `multigenerational`, `heritage`
  * **Must-haves**: structured checks that filter / classify listings.
    See the example YAML for the full catalog (ownership, building_type
    / building_type_not, building_condition, balcony, terrace, cellar,
    elevator, parking, furnished, low_energy, easy_access, floor_min /
    floor_max / not_ground_floor, energy_class_max, images_min,
    description_min). Each has `severity: hard` (failure → `fail` tier,
    excluded from digest) or `severity: soft` (failure → `near-miss`
    tier, still surfaced with the failed check named).
  * **Soft preferences**: free-form prose. The qualitative stuff the
    must-haves can't capture - prefer parquet floors, avoid magistrály,
    south-facing living room, walking distance to Stromovka, etc. Ask
    the user open-endedly and capture it nearly verbatim.

For a first-time user, ask sparingly - 4-6 well-chosen questions, not
20. They can `search edit <name>` later.

### Step 2: Compose the YAML

Read `examples/search.example.yaml` for the canonical schema
and comments. Compose a fresh YAML based on the interview. **Don't**
edit the example file in place; **don't** copy its `family-house`
values. Use it strictly as a reference.

Write the YAML to `~/.config/sreality-hunt/searches/<name>.yaml`. Use
the `write` tool directly. The directory may not yet exist; create it
with `mkdir -p` or via the write tool if it auto-creates parents.

Double-quote strings that contain Czech diacritics or special chars.
Use YAML literal-block (`|`) for multi-line `preferences:`.

### Step 3: Validate

Before handing back to the user, confirm the YAML parses:

```bash
.venv/bin/sreality-hunt search validate <name>
```

Exit code 0 with `valid: N categories, M must-have checks, max_listings=K`
means you're good. Exit code 2 prints either `error: malformed YAML`
(syntax error - fix the indentation / brackets / quotes) or
`error: invalid configuration` (schema error - re-read the pydantic
output, fix the field that's wrong, re-validate).

### Step 4: Confirm and offer a digest

Show the user a 2-3 line summary of what you set up (e.g. "`my-praha`:
apt + house, Praha 1/2/3/7, ≤14M CZK, ≥70m², 5 must-haves including
no-panelák and elevator"), and offer to run the first digest.

Advise the user that the first digest tends to be slow because every
matching listing is genuinely new (no `seen` rows to cheap-pre-check
against), and that subsequent digests are much faster.

---

## Workflow 1: Digest (the bread-and-butter)

**Trigger phrases**: "what's new in my search", "run a digest", "any new
apartments?", "check `<search-name>`".

This is a **three-pass** workflow. Pass 1 is one CLI call; Pass 2 is
multiple CLI calls; Pass 3 is your composition.

### Pass 1: Run the digest

```bash
.venv/bin/sreality-hunt digest <search-name>
```

The output is structured markdown with these sections:

1. **Header + summary line**: candidates inspected, counts per bucket, cap-reached flag
2. **INPUTS appendix**: soft preferences, learned preferences, recent reactions for few-shot
3. **Re-surfaced** (full evaluation packets, with `change_flag` like `price-drop -8%`)
4. **New candidates** (compact rows sorted by tier then percentile)
5. **Filtered out** (count + breakdown by failed-check name)
6. **Already seen, unchanged** (silent skip count)

A "compact row" looks like:

```
 4159742028  Buchovcova, Praha 3 - Žižkov         3+kk     79m²   11.99M  151k/m²   pct= 7   near-miss(balcony)
```

Read the INPUTS appendix once before processing the rest - it tells you
the user's soft preferences and recent reaction patterns, which inform
your grading.

### Pass 2: Pick promising IDs and deep-evaluate

From the compact rows, pick **5-8 candidates** worth a deep look. Selection
heuristics, in priority order:

  1. **`tier=match` with low percentile** (high signal: meets all soft criteria AND cheap for cohort)
  2. **`near-miss` with low percentile and only 1-2 failed soft checks** (might be a bargain worth a closer look)
  3. **Avoid `near-miss` listings whose failures contradict strong dislikes** in soft preferences (e.g. user dislikes panel → skip `near-miss(building_type_not)`)

For each pick, call:

```bash
.venv/bin/sreality-hunt evaluate <listing-id> --search <search-name> --from-snapshot
```

`--from-snapshot` reuses the snapshot the digest just persisted, so it
skips the detail API call (much faster, no extra rate-limit use). Run
these in parallel via separate tool calls when possible.

Each evaluate output is a full evaluation packet (see "Composition" below).

### Pass 3: Compose the user-facing reply

Present a **bucketed digest** to the user. Suggested structure:

```markdown
## Family-house digest (47 candidates checked)

### Worth your time (3)
[Full per-listing card per evaluate output: grade you assigned, headline pros/cons, link]

### Worth a quick look (5)
[Compact lines from the digest's middle bucket, your one-line takeaway each]

### Skipped (32) and re-surfaced (3)
[Brief count + breakdown; offer to dig deeper if asked]
```

The "Worth your time" cards are where you compose the qualitative
analysis. Each card should include: your grade, a 1-2 sentence verdict,
key facts that mattered, red flags (anything contradicting soft prefs),
and 1-2 suggested next actions (`mark liked/rejected`, `open`, `compare`).

End with: "Want me to dig deeper into N? Or mark any as liked / rejected?"

---

## Workflow 2: Single-listing evaluate

**Trigger**: user pastes a sreality.cz URL, or asks "what about listing
12345" / "evaluate this one".

URL pattern: `https://www.sreality.cz/detail/<type>/<main>/<sub>/<locality>/<hash-id>`

The hash-id is the last path segment - a long integer. Extract it.

```bash
# With saved-search context (preferred when user has an active search)
.venv/bin/sreality-hunt evaluate <id> --search <name>

# Without search context (paste-URL mode, no must-haves)
.venv/bin/sreality-hunt evaluate <id>

# Fast facts only, no checks or pricing
.venv/bin/sreality-hunt fetch <id>
```

If unsure which saved search applies, list them first:

```bash
.venv/bin/sreality-hunt search list
```

Then ask the user which to use, or proceed without `--search` if none
obviously fits.

---

## Workflow 3: Record reactions on the user's behalf

**Trigger phrases**: "I like this one", "skip that", "let's save 4159742028
for later", "rejected", "we went to see it last week", "this one's a
no-go".

Run on the user's behalf:

```bash
.venv/bin/sreality-hunt mark <id> <liked|rejected|saved|visited> \
  --note "<short reason from chat>" --search <name>
```

Rules:

  * **Always include `--note`** if the user gave any reason at all (even
    a 3-word fragment). The note is what makes the few-shot useful later.
  * **Include `--search`** when the active conversation is clearly about
    a particular saved search.
  * **Confirm briefly** after marking: "Marked 4159742028 as liked
    (\"great light\")." Don't over-explain.
  * **Don't mark without explicit user intent**. "It looks nice" is a
    comment, not a like. "I like this one" is a like.

Reaction kinds (what they signal):

  * `liked` - user is interested, wants more like it
  * `rejected` - user is not interested, avoid more like it
  * `saved` - user wants to come back to it, doesn't yet have an opinion
  * `visited` - user has physically seen the property

---

## Workflow 4: Distill learned preferences

**Trigger phrases**: "summarize what I've liked", "update my preferences
based on my reactions", "what patterns am I picking".

This is a 3-step workflow:

### Step 1: Read the structured prompt

```bash
.venv/bin/sreality-hunt distill <search-name>
```

The output groups recent reactions by kind (LIKED / REJECTED / SAVED /
VISITED) with per-listing context (locality, area, price, tier-when-
surfaced, note). It also shows existing soft preferences and existing
learned preferences.

### Step 2: Compose distilled prose

Read the reactions and identify concrete patterns. Look for:

  * What LIKED listings have in common that the soft preferences don't
    already capture (e.g. specific streets, age, layout traits)
  * What REJECTED listings have in common (e.g. specific bad streets,
    construction types, agency boilerplate language)
  * Cases where the user liked something **despite** a soft-check failure
    (e.g. liked despite no elevator) - signals tolerance trade-offs
  * Cases where they rejected something that **passed** all must-haves -
    signals a missing criterion worth capturing

Write a short markdown summary - bullet points and brief paragraphs.
Specific patterns ("avoids listings on Veletržní") beat generic ones
("prefers quiet streets"). Don't restate what's already in soft prefs.

**Show the draft prose to the user** before applying. They might want
to edit or reject parts.

### Step 3: Apply

Once the user OKs:

```bash
echo '<the prose>' | .venv/bin/sreality-hunt distill <search-name> --apply -
```

Or write the prose to a temp file and pass `--apply <file>` (more
reliable for multi-line content with special characters).

`--apply` **overwrites** `learned_preferences:` in the YAML; the soft
`preferences:` block is left alone.

---

## The evaluation packet: what CLI gives you, what you add

The deterministic packet (from `evaluate` or each Re-surfaced block in
`digest`) has these sections:

| # | Section | Source |
|---|---|---|
| 1 | Header (title, price, locality, link) | CLI |
| 2 | **Grade (letter A-F + numeric 0-100 + 1-sentence verdict)** | **You** |
| 3 | Facts table (disposition, area, floor, ownership, building, condition, energy class, amenities, ...) | CLI |
| 4 | Must-have check results + tier + price context (percentile, cohort median) | CLI |
| 5 | **Qualitative analysis (description tone, photo impressions, locality vibe vs soft prefs)** | **You** |
| 6 | **Red flags (anything contradicting soft prefs or that should worry the user)** | **You** |
| 7 | **Next actions (`mark`, `open`, `compare`, follow-up questions)** | **You** |

When presenting to the user, you don't need to reproduce sections 1, 3,
4 verbatim - summarize what matters. Always include the link from
section 1 and your grade from section 2.

**Grade guidance**:

  * **A** - meets all hard + soft criteria, low percentile, description
    paints a coherent picture matching prefs. Recommend viewing.
  * **B** - solid match with minor compromises (one soft miss, or
    middle percentile). Worth seeing.
  * **C** - mixed signal: significant compromises but some real
    positives. Worth more research before viewing.
  * **D** - several misses, weak signal. Skip unless price is unusually
    low.
  * **F** - clear mismatch (panelák when user hates panel, dependent on
    soft prefs).

Don't be afraid of low grades. The point is filtering.

---

## Subcommand intent table

| Intent | Command |
|---|---|
| "find me apartments" / "help me set up a search" / no saved searches yet | **Workflow 0** (interview → compose YAML → `search validate <name>`) |
| "what's new in `family-house`?" | `digest family-house` |
| "evaluate this listing" + URL or id | `evaluate <id> --search <name>` |
| "evaluate this" + URL, no search context | `evaluate <id>` |
| "just give me the facts" | `fetch <id>` |
| "what listings have I reacted to?" | `history --search <name>` |
| "show liked listings" | `history --reaction liked` |
| "I like this one" | `mark <id> liked --note "..." --search <name>` |
| "summarize what I've liked / update my prefs" | `distill <search>` → compose → `--apply` |
| "compare these listings" | `compare <id> <id> ... --search <name> --from-snapshot` |
| "open in browser" | `open <id>` |
| "list my searches" | `search list` |
| "set up a new search" | **Workflow 0** (compose YAML in chat) or tell the user to run `search new <name>` (opens $EDITOR for terminal-only) |
| "is my search valid?" | `search validate <name>` |
| (every command) | use `--from-snapshot` for evaluate/compare when reading data the digest just persisted |

---

## Exit codes (for error handling)

| Code | Meaning | What to do |
|---|---|---|
| 0 | success | proceed |
| 2 | user error (bad args, missing/invalid YAML, missing search, empty distill prose) | surface the stderr message to the user |
| 3 | listing not found (404/410) | tell user the listing was removed; don't retry |
| 4 | snapshot missing (`--from-snapshot` but no snapshot) | drop `--from-snapshot` and retry |
| 5 | sreality API failure | mention to user, suggest retrying in a minute |
| 130 | interrupt | leave it |

The CLI writes markdown to **stdout** and everything else (logs,
progress, errors, confirmations) to **stderr**. When invoking via tool
calls, both streams matter; the markdown stdout is what you read for
data, the stderr is what you surface on failure.

---

## DOs

  * **Always pass `--from-snapshot`** in evaluate/compare during Pass 2
    of a digest - the data is in the DB, refetching is wasted budget.
  * **Always pass `--search <name>`** when the conversation is about a
    specific saved search (gives must-haves, INPUTS appendix, and seen
    tracking).
  * **Show distilled prose to the user before `--apply`-ing it** - this
    overwrites their YAML.
  * **Use `mark` aggressively** - reactions are cheap, and the few-shot /
    distill loop benefits a lot from a few dozen marks per search.
  * **Prefer parallel evaluates** in Pass 2 (multiple tool calls in one
    block) - each is independent.

## DON'Ts

  * **Don't assign or display a CLI-side grade** - there isn't one. The
    tier (`match` / `near-miss` / `fail`) is for bucketing, not for
    user display.
  * **Don't run `digest` with a custom `--limit`** unless the user asks
    or the search's `max_listings` is clearly wrong - the per-search
    setting is what they configured.
  * **Don't mark on inference alone** - "this one looks interesting" is
    not "I like this one". Ask if uncertain.
  * **Don't run `distill --apply` without showing the draft** - it
    overwrites the YAML.
  * **Don't run two `digest` calls concurrently** against the same search
    - DB is single-writer.
  * **Don't translate Czech proper nouns** (street names, district names,
    listing titles) - they break links and lose info. English narration
    around Czech proper nouns is the right register.

---

## Further reading (when actually needed)

  * `examples/search.example.yaml` - full YAML syntax, every
    must-have check, every filter field. **Read this first when running
    Workflow 0** - it's the canonical schema reference.
  * `docs/sreality-api-findings.md` - sreality API specifics,
    codebook tables, URL patterns. Reference if a fetch fails in a
    weird way.
  * `README.md` - people-facing usage reference (the user's
    document, not yours).

---

## Location IDs

Saved searches reference districts/regions by integer ID, not name.
`filters.location.district_ids` and `filters.location.region_ids` both
take lists of these IDs.

### Prague (`region_id: 10`)

| District | ID |
|---|---|
| Praha 1 | 5001 |
| Praha 2 | 5002 |
| Praha 3 | 5003 |
| Praha 4 | 5004 |
| Praha 5 | 5005 |
| Praha 6 | 5006 |
| Praha 7 | 5007 |
| Praha 8 | 5008 |
| Praha 9 | 5009 |
| Praha 10 | 5010 |

### Other cities / regions

For anything outside Prague, two practical lookup methods:

  1. **Sample a real listing**: ask the user to share any sreality.cz
     URL of a listing in the area they want. Extract its hash-id, run
     `.venv/bin/sreality-hunt evaluate <id>` (no `--search`),
     and read `district X, sub Y` from the price-context line. That `X`
     is the `district_id` to put in `location.district_ids`.

  2. **Inspect sreality.cz directly**: visit https://www.sreality.cz,
     apply the filter for the desired city in the UI, and read the
     `locality_region_id=` and `locality_district_id=` parameters out
     of the resulting URL.

When unsure, prefer method 1 - it uses our own snapshot of how sreality
categorizes the listing, no manual URL parsing required.
