# DB schema

`~/.local/share/sreality-hunt/db.sqlite` (overridable via `$XDG_DATA_HOME`).
SQLite with WAL journaling and `foreign_keys = ON`. The executable source of
truth is [`src/sreality_hunt/db.py`](../src/sreality_hunt/db.py); this doc
explains the why.

## Tables at a glance

```
listings        one row per hash_id ever seen; immutable categorical metadata + URL
snapshots       one row per fetched detail payload; price/area history lives here
seen            one row per (search, listing); drives "new since last digest" + re-surface
reactions       user marks (liked / rejected / saved / visited) with optional notes
digest_runs     audit trail of each digest invocation
meta            schema_version (and any future global state)
```

## Why this split

### `listings` vs `snapshots`

A listing has two halves: stuff that never changes for a given `hash_id`
(category codes, locality slug, URL) and stuff that does change (price,
description, status). Splitting them keeps the immutable identity stable
across re-fetches and makes "current price" vs "price six weeks ago" a clean
two-row diff against `snapshots`.

`snapshots.raw_json` is the *slimmed* detail payload (POI lists, seller info,
similar adverts, watermarked image variants stripped) - enough to re-render an
evaluation card without re-fetching, but ~10x smaller than the raw API
response. Slimming happens in `api.py`/`models.py` before insert.

A snapshot is inserted only if its `snapshot_hash` (sha256 of canonical-JSON
of normalized facts: price, area, title, locality, key items, description)
differs from the latest snapshot for the same listing. Re-running a digest
five minutes later doesn't write five identical rows.

### `seen` is separate from `snapshots`

Seen is a (search × listing) relationship, not a per-listing one. The same
listing can be "new" in `family-house` and "already seen weeks ago" in
`investment-apartments`, because different searches have different filters.

`first_surfaced_at` is set once and preserved across re-surfaces.
`last_surfaced_*` are bumped each time the digest re-surfaces the listing
(e.g. price drop). The tier + reason are the values that drove the
*last* surface, so the next digest can decide whether the listing has changed
enough to re-surface again.

### `reactions` is global (with a search hint)

`reaction.hash_id` has no FK to `listings` on purpose: a user can mark a
listing they evaluated long ago, after we've pruned its `listings` row.
`reaction.search_name` records the search the user was in when marking, used
only as a hint - the canonical "which reactions matter for search X" query
joins via `seen` (see `recent_reactions_for_search()`).

This means: if a listing was never surfaced in search X but the user
explicitly marked it while in search X, it *won't* show up in X's few-shot.
That's intentional. The few-shot is "things you actually evaluated in this
search's context".

### `digest_runs` is for the audit trail, not control flow

We never read `digest_runs` to decide what to do next - the source of truth
for "have we seen this listing in this search" is `seen`. `digest_runs` is
for `history`, debugging, and answering "when did I last run the family-house
digest?".

## Index choices

| Index | Drives |
|---|---|
| `idx_snapshots_hash_fetched (hash_id, fetched_at DESC)` | "latest snapshot for listing X" - the hottest read |
| `idx_seen_search (search_name)` | "which listings has this search ever surfaced" - hot during digest |
| `idx_reactions_hash (hash_id)` | "all reactions on listing X" - used by evaluate |
| `idx_reactions_recent (reacted_at DESC)` | "recent reactions across the user" - used by distill |
| `idx_digest_runs_search (search_name, started_at DESC)` | "last digest run for search X" - used by history |

No index on `snapshots.locality_district_id` / `category_sub_cb` yet. The
comparable-pricing percentile is currently sourced from fresh API calls, not
from local snapshots. If we ever switch to local-corpus comparables, add
`(locality_district_id, category_sub_cb, is_active, usable_area)`.

## Migrations

`MIGRATIONS` is a list of DDL strings. `meta.schema_version` records the index
of the last applied migration; `init_schema(conn)` applies anything missing.
Each migration runs in a single transaction. To extend:

1. Append a new DDL string to `MIGRATIONS`
2. Bump `SCHEMA_VERSION` (used only as a sanity assertion target by callers)
3. Never edit an existing migration string after release

## Operational notes

- **Size**: ~50-150 KB per snapshot (before slimming); slimmed ~10-30 KB.
  Typical listing has 1-3 snapshots over its lifetime. A heavy user (5
  searches, 30 candidates per digest, daily for a year) might accumulate
  ~50 MB. A future `db prune` command will be able to age out snapshots
  older than N months, keeping only the first and last per listing.
- **Concurrency**: WAL mode + autocommit isolation_level lets concurrent
  reads happen during a long digest. The agent should still not run two
  digests against the same search in parallel.
- **Deletion**: dropping a saved-search YAML does not purge its `seen` /
  `digest_runs` rows. A future `search delete --purge` will.
- **No PII**: the DB contains only listing data (public) plus user reactions
  (a few words of free-text per listing). No keys, no API tokens.
