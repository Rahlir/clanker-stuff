# sreality-hunt

Apartment/house search assistant for [sreality.cz](https://www.sreality.cz).
Defines saved searches in YAML, fetches matching listings via the sreality
JSON API, scores them against your must-haves, and produces structured
markdown reports for use in a chat agent (or for reading directly).

The CLI doesn't itself call any LLM. Scoring, change detection, percentile
math, and persistence all happen deterministically; the agent layer
(if you use one) handles qualitative judgment on top.

## Setup

```bash
cd ~/.agents/skills/sreality-hunt
uv sync                 # creates .venv with all dependencies
.venv/bin/sreality-hunt db init
```

The `sreality-hunt` console script lives at `.venv/bin/sreality-hunt`;
add the venv's bin dir to your `$PATH` or use the full path.

## Where things live

| Kind | Default path | Override |
|---|---|---|
| Saved searches | `~/.config/sreality-hunt/searches/<name>.yaml` | `$XDG_CONFIG_HOME` |
| SQLite DB (snapshots, seen, reactions, digest runs) | `~/.local/share/sreality-hunt/db.sqlite` | `$XDG_DATA_HOME` |

## Quick start

```bash
# 1. Create your first saved search (opens $EDITOR)
sreality-hunt search new my-praha-search

# 2. Inspect what you wrote
sreality-hunt search show my-praha-search

# 3. Run a digest
sreality-hunt digest my-praha-search

# 4. Look at a specific listing in more depth
sreality-hunt evaluate 3500933964 --search my-praha-search

# 5. Record what you thought (the search context attaches it to the right few-shot pool)
sreality-hunt mark 3500933964 liked --note "great light, calm street" --search my-praha-search

# 6. After accumulating reactions, distill them into learned preferences
sreality-hunt distill my-praha-search                          # read mode: emits LLM prompt
echo "- Avoids busy streets..." | sreality-hunt distill my-praha-search --apply -
```

See [`examples/search.example.yaml`](examples/search.example.yaml) for the
saved-search format with all available filters, must-have checks, and
preference fields documented inline.

## Command reference

```
search list                                         enumerate saved searches with counts
search new <name> [--no-edit]                       create from the example template
search show <name>                                  print a search's YAML
search edit <name>                                  open a search in $EDITOR

digest <search> [--limit N]                         run a digest pass for a saved search
                                                    (returns markdown for re-surfaced
                                                    listings, new candidates, filtered)

evaluate <listing-id> [--search NAME] [--from-snapshot]
                                                    full evaluation packet for one listing
                                                    --search adds must-have checks + INPUTS
                                                    --from-snapshot avoids the detail refetch

fetch <listing-id> [--from-snapshot]                facts + photos + description only
                                                    (no checks, no pricing, no INPUTS)

images <listing-id> [--from-snapshot] [--limit N]   download photos to a temp dir and print
                                                    local paths (floor plans first); default 20

mark <listing-id> <liked|rejected|saved|visited>
     [--note TEXT] [--search NAME]                  record a reaction

history [--search NAME] [--reaction TYPE]
        [--limit N]                                 browse recent reactions

distill <search>                                    read mode: emit LLM prompt
distill <search> --apply FILE                       write mode: read prose from FILE
distill <search> --apply -                          write mode: read prose from stdin

compare <id> <id> ... [--search NAME]
                      [--from-snapshot]             concatenated evaluation packets

open <listing-id>                                   open the listing URL in browser

db init                                             create / migrate the schema
```

Global flags:

- `-v` / `--verbose` — bump log level (`-v` INFO, `-vv` DEBUG). Logs go to stderr.

## Output discipline

- **stdout** gets the markdown data (digest output, evaluation packets, history listings, distill prompts)
- **stderr** gets progress notes, confirmations, errors, log lines

So `sreality-hunt digest my-search > digest.md` saves only the data;
diagnostics still go to the terminal.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 2 | User error (bad args, missing/invalid YAML, missing search, empty distill prose) |
| 3 | Listing not found (404/410 from sreality) |
| 4 | Snapshot missing (`--from-snapshot` but nothing in DB) |
| 5 | sreality API failure (rate-limited, 5xx after retries, transport) |
| 130 | Keyboard interrupt |

## Typical workflow

1. **Set up one or more saved searches** for the kinds of properties you're
   actually hunting (`search new`). Each is independent — filters,
   must-haves, preferences, seen history, reactions.

2. **Run `digest <search>` periodically** (manually whenever you feel like
   checking). Read the output — it surfaces only listings that are new to
   that search since you last looked, plus any re-surfaced ones (price drops
   etc).

3. **For interesting candidates, run `evaluate <id> --search <name>
   --from-snapshot`** to see the full per-listing packet. From-snapshot
   reuses the snapshot the digest just persisted, so it's fast.

4. **Record reactions** with `mark`. The next digest's pricing/percentile
   computations are unaffected, but the distill command can later turn
   accumulated reactions into a `learned_preferences:` block in the YAML.

5. **Run `distill <search>` occasionally** to summarize patterns from your
   reactions. In read mode it emits a structured prompt for an LLM to
   consume; in apply mode it writes prose into the YAML.

## Further reading

- [`examples/search.example.yaml`](examples/search.example.yaml) — annotated
  saved-search template
- [`docs/sreality-api-findings.md`](docs/sreality-api-findings.md) —
  notes on the (undocumented) sreality JSON API, codebooks, URL patterns
- [`docs/db-schema.md`](docs/db-schema.md) — SQLite schema rationale and
  query patterns
- `SKILL.md` — agent-facing protocol (when to invoke each command, how to
  compose qualitative analysis around the deterministic packets)

## Notes

- The skill is polite to sreality: 1 request/second by default, with retries
  + exponential backoff on 429/5xx, and 4xx (other than 404/410) treated as
  hard errors. The default `max_listings: 200` cap in saved searches bounds
  the total fetches per digest.
- All snapshots are stored in slimmed form (~15% of the raw API response).
  Snapshot rows are only inserted when the normalized facts hash actually
  changes — running the same digest twice doesn't accumulate duplicates.
- The DB is single-writer by design. Don't run two digests concurrently
  against the same search.
