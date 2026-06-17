"""SQLite schema, connection helpers, and migration runner for sreality-hunt.

The DB lives at $XDG_DATA_HOME/sreality-hunt/db.sqlite (default
~/.local/share/sreality-hunt/db.sqlite). Schema is documented in
docs/db-schema.md; the source of truth is `MIGRATIONS` below.

This module is intentionally narrow: connection + migrations + a handful of
generic CRUD helpers that the rest of the package uses. Module-specific
queries (digest scoring, learning loop, etc.) live in their own modules.

Python stdlib only - no third-party deps in this module.
"""

import datetime as _dt
import json
import os
import sqlite3
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1


# --- Path resolution ---------------------------------------------------------


def db_path() -> Path:
    """Return the canonical DB path, honoring $XDG_DATA_HOME."""
    base = Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share"))
    return base / "sreality-hunt" / "db.sqlite"


# --- Connection --------------------------------------------------------------


def connect(path: Path | None = None) -> sqlite3.Connection:
    """Open a connection. Creates parent dirs as needed.

    Caller is responsible for `init_schema(conn)` once before using the
    connection for real work. Use `connect_and_init()` if you don't care
    about controlling the timing.
    """
    p = path or db_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    # isolation_level=None -> autocommit; we manage transactions explicitly.
    conn = sqlite3.connect(p, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    return conn


def connect_and_init(path: Path | None = None) -> sqlite3.Connection:
    conn = connect(path)
    init_schema(conn)
    return conn


# --- Migrations --------------------------------------------------------------

# Each entry is the full DDL for migrating from version (index) to (index+1).
# v0 -> v1 is the initial schema.
MIGRATIONS: list[str] = [
    # v0 -> v1: initial schema
    """
    CREATE TABLE listings (
        hash_id              INTEGER PRIMARY KEY,
        category_main_cb     INTEGER NOT NULL,    -- 1=apt 2=house ...
        category_sub_cb      INTEGER NOT NULL,    -- disposition / house subtype
        category_type_cb     INTEGER NOT NULL,    -- 1=sale 2=rent 3=auction
        locality_slug        TEXT    NOT NULL,    -- assembled locality URL slug
        locality_region_id   INTEGER,             -- from detail.locality.region_id
        locality_district_id INTEGER,             -- from detail.locality.district_id
        url                  TEXT    NOT NULL,    -- public detail page URL
        first_seen_at        TEXT    NOT NULL,    -- ISO 8601 UTC
        last_seen_at         TEXT    NOT NULL     -- ISO 8601 UTC, updated each fetch
    );

    CREATE TABLE snapshots (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        hash_id          INTEGER NOT NULL REFERENCES listings(hash_id) ON DELETE CASCADE,
        fetched_at       TEXT    NOT NULL,        -- ISO 8601 UTC
        snapshot_hash    TEXT    NOT NULL,        -- sha256 of canonical normalized fields
        is_active        INTEGER NOT NULL DEFAULT 1,  -- 0 if listing was 404/removed
        price_czk        INTEGER,                 -- denormalized for query / percentile
        usable_area      INTEGER,                 -- denormalized for query / percentile
        title            TEXT,                    -- denormalized display
        locality_display TEXT,                    -- denormalized display
        raw_json         TEXT    NOT NULL         -- slim detail payload as JSON text
    );
    -- "latest snapshot per listing" is a very hot query
    CREATE INDEX idx_snapshots_hash_fetched
        ON snapshots(hash_id, fetched_at DESC);

    CREATE TABLE seen (
        search_name                 TEXT    NOT NULL,
        hash_id                     INTEGER NOT NULL REFERENCES listings(hash_id) ON DELETE CASCADE,
        first_surfaced_at           TEXT    NOT NULL,
        last_surfaced_at            TEXT    NOT NULL,
        last_surfaced_snapshot_id   INTEGER REFERENCES snapshots(id) ON DELETE SET NULL,
        last_surfaced_tier          TEXT    NOT NULL,   -- match | near-miss | fail
        last_surfaced_reason        TEXT,               -- e.g. "panel,no-balcony"
        PRIMARY KEY (search_name, hash_id)
    );
    CREATE INDEX idx_seen_search ON seen(search_name);

    CREATE TABLE reactions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        hash_id      INTEGER NOT NULL,           -- intentionally no FK: reactions
                                                 -- can outlive listing rows
        reaction     TEXT    NOT NULL,           -- liked | rejected | saved | visited
        reacted_at   TEXT    NOT NULL,           -- ISO 8601 UTC
        note         TEXT,
        search_name  TEXT                        -- search the user was in when marking
    );
    CREATE INDEX idx_reactions_hash ON reactions(hash_id);
    CREATE INDEX idx_reactions_recent ON reactions(reacted_at DESC);

    CREATE TABLE digest_runs (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        search_name      TEXT    NOT NULL,
        started_at       TEXT    NOT NULL,
        finished_at      TEXT,
        candidates_seen  INTEGER DEFAULT 0,      -- total listings inspected
        match_count      INTEGER DEFAULT 0,
        near_miss_count  INTEGER DEFAULT 0,
        fail_count       INTEGER DEFAULT 0,
        resurfaced_count INTEGER DEFAULT 0,
        error            TEXT
    );
    CREATE INDEX idx_digest_runs_search
        ON digest_runs(search_name, started_at DESC);

    -- `meta` is created by init_schema() before running any migration so the
    -- runner can read/write schema_version. Don't redeclare it here.
    """,
]


def init_schema(conn: sqlite3.Connection) -> int:
    """Apply any pending migrations. Returns the resulting schema version.

    Safe to call repeatedly; a no-op when already at the latest version.
    """
    # Bootstrap the meta table if this is a brand-new DB.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
    )
    row = conn.execute(
        "SELECT value FROM meta WHERE key = 'schema_version'"
    ).fetchone()
    current = int(row["value"]) if row else 0

    for target in range(current, len(MIGRATIONS)):
        ddl = MIGRATIONS[target]
        with conn:  # transaction
            conn.executescript(ddl)
            conn.execute(
                "INSERT INTO meta(key, value) VALUES('schema_version', ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (str(target + 1),),
            )

    return get_schema_version(conn)


def get_schema_version(conn: sqlite3.Connection) -> int:
    row = conn.execute(
        "SELECT value FROM meta WHERE key = 'schema_version'"
    ).fetchone()
    return int(row["value"]) if row else 0


def _last_rowid(cur: sqlite3.Cursor) -> int:
    """Narrow `Cursor.lastrowid` (typed `int | None`) to `int`.

    SQLite only populates `lastrowid` after an INSERT into a rowid table - which
    is exactly what our INSERT helpers do. If it's ever None here, the schema
    or the call site is wrong; surface that loudly rather than masking it with
    `int(None)`.
    """
    rid = cur.lastrowid
    if rid is None:
        raise RuntimeError(
            "cursor.lastrowid is None after INSERT; likely called against a "
            "non-rowid table or after a non-INSERT statement"
        )
    return rid


# --- Time helpers ------------------------------------------------------------


def now_iso() -> str:
    """Single source of truth for timestamp format used in all *_at columns."""
    return _dt.datetime.now(_dt.UTC).isoformat(timespec="seconds")


# --- Listing helpers ---------------------------------------------------------


def upsert_listing(
    conn: sqlite3.Connection,
    *,
    hash_id: int,
    category_main_cb: int,
    category_sub_cb: int,
    category_type_cb: int,
    locality_slug: str,
    url: str,
    locality_region_id: int | None = None,
    locality_district_id: int | None = None,
) -> None:
    """Insert a listing if new, else bump last_seen_at and refresh location IDs.

    Categorical fields are immutable per listing - if the API ever returns a
    different value, we ignore it (the original wins).
    """
    ts = now_iso()
    conn.execute(
        """
        INSERT INTO listings (
            hash_id, category_main_cb, category_sub_cb, category_type_cb,
            locality_slug, locality_region_id, locality_district_id, url,
            first_seen_at, last_seen_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(hash_id) DO UPDATE SET
            last_seen_at = excluded.last_seen_at,
            locality_region_id = COALESCE(listings.locality_region_id, excluded.locality_region_id),
            locality_district_id = COALESCE(listings.locality_district_id, excluded.locality_district_id)
        """,
        (
            hash_id, category_main_cb, category_sub_cb, category_type_cb,
            locality_slug, locality_region_id, locality_district_id, url,
            ts, ts,
        ),
    )


def get_listing(conn: sqlite3.Connection, hash_id: int) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM listings WHERE hash_id = ?", (hash_id,)
    ).fetchone()


# --- Snapshot helpers --------------------------------------------------------


def insert_snapshot_if_changed(
    conn: sqlite3.Connection,
    *,
    hash_id: int,
    snapshot_hash: str,
    price_czk: int | None,
    usable_area: int | None,
    title: str | None,
    locality_display: str | None,
    raw_json: str,
    is_active: bool = True,
) -> tuple[int, bool]:
    """Insert a snapshot iff its hash differs from the latest one for this listing.

    Returns (snapshot_id, inserted) where inserted is True for a new row and
    False if the latest existing snapshot already had the same hash (in which
    case snapshot_id refers to the existing row).
    """
    latest = get_latest_snapshot(conn, hash_id)
    if latest is not None and latest["snapshot_hash"] == snapshot_hash:
        return int(latest["id"]), False

    ts = now_iso()
    cur = conn.execute(
        """
        INSERT INTO snapshots (
            hash_id, fetched_at, snapshot_hash, is_active,
            price_czk, usable_area, title, locality_display, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            hash_id, ts, snapshot_hash, 1 if is_active else 0,
            price_czk, usable_area, title, locality_display, raw_json,
        ),
    )
    return _last_rowid(cur), True


def get_latest_snapshot(
    conn: sqlite3.Connection, hash_id: int
) -> sqlite3.Row | None:
    return conn.execute(
        """
        SELECT * FROM snapshots
        WHERE hash_id = ?
        ORDER BY fetched_at DESC, id DESC
        LIMIT 1
        """,
        (hash_id,),
    ).fetchone()


def get_snapshot(conn: sqlite3.Connection, snapshot_id: int) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM snapshots WHERE id = ?", (snapshot_id,)
    ).fetchone()


# --- Seen helpers ------------------------------------------------------------


def upsert_seen(
    conn: sqlite3.Connection,
    *,
    search_name: str,
    hash_id: int,
    snapshot_id: int,
    tier: str,
    reason: str | None,
) -> None:
    """Mark (search, listing) as surfaced.

    On first surface: sets first_surfaced_at.
    On re-surface (e.g. price drop): bumps last_surfaced_* fields only.
    """
    ts = now_iso()
    conn.execute(
        """
        INSERT INTO seen (
            search_name, hash_id, first_surfaced_at, last_surfaced_at,
            last_surfaced_snapshot_id, last_surfaced_tier, last_surfaced_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(search_name, hash_id) DO UPDATE SET
            last_surfaced_at = excluded.last_surfaced_at,
            last_surfaced_snapshot_id = excluded.last_surfaced_snapshot_id,
            last_surfaced_tier = excluded.last_surfaced_tier,
            last_surfaced_reason = excluded.last_surfaced_reason
        """,
        (search_name, hash_id, ts, ts, snapshot_id, tier, reason),
    )


def get_seen(
    conn: sqlite3.Connection, search_name: str, hash_id: int
) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM seen WHERE search_name = ? AND hash_id = ?",
        (search_name, hash_id),
    ).fetchone()


def list_seen_hash_ids(conn: sqlite3.Connection, search_name: str) -> set[int]:
    rows = conn.execute(
        "SELECT hash_id FROM seen WHERE search_name = ?", (search_name,)
    ).fetchall()
    return {int(r["hash_id"]) for r in rows}


# --- Reaction helpers --------------------------------------------------------


VALID_REACTIONS = ("liked", "rejected", "saved", "visited")


def insert_reaction(
    conn: sqlite3.Connection,
    *,
    hash_id: int,
    reaction: str,
    note: str | None = None,
    search_name: str | None = None,
) -> int:
    if reaction not in VALID_REACTIONS:
        raise ValueError(
            f"invalid reaction {reaction!r}; expected one of {VALID_REACTIONS}"
        )
    cur = conn.execute(
        """
        INSERT INTO reactions (hash_id, reaction, reacted_at, note, search_name)
        VALUES (?, ?, ?, ?, ?)
        """,
        (hash_id, reaction, now_iso(), note, search_name),
    )
    return _last_rowid(cur)


def recent_reactions_for_search(
    conn: sqlite3.Connection,
    search_name: str,
    *,
    limit_per_reaction: int = 5,
) -> list[sqlite3.Row]:
    """Recent reactions on listings ever surfaced in this search.

    Returns up to `limit_per_reaction` per distinct reaction kind, ordered most
    recent first. Drives the few-shot block fed to the LLM evaluator.
    """
    rows: list[sqlite3.Row] = []
    for kind in VALID_REACTIONS:
        rows.extend(
            conn.execute(
                """
                SELECT r.*
                FROM reactions r
                JOIN seen s ON s.hash_id = r.hash_id AND s.search_name = ?
                WHERE r.reaction = ?
                ORDER BY r.reacted_at DESC
                LIMIT ?
                """,
                (search_name, kind, limit_per_reaction),
            ).fetchall()
        )
    return rows


# --- Digest run helpers ------------------------------------------------------


def start_digest_run(conn: sqlite3.Connection, search_name: str) -> int:
    cur = conn.execute(
        "INSERT INTO digest_runs (search_name, started_at) VALUES (?, ?)",
        (search_name, now_iso()),
    )
    return _last_rowid(cur)


def finish_digest_run(
    conn: sqlite3.Connection,
    run_id: int,
    *,
    candidates_seen: int = 0,
    match_count: int = 0,
    near_miss_count: int = 0,
    fail_count: int = 0,
    resurfaced_count: int = 0,
    error: str | None = None,
) -> None:
    conn.execute(
        """
        UPDATE digest_runs SET
            finished_at = ?,
            candidates_seen = ?,
            match_count = ?,
            near_miss_count = ?,
            fail_count = ?,
            resurfaced_count = ?,
            error = ?
        WHERE id = ?
        """,
        (
            now_iso(), candidates_seen, match_count, near_miss_count,
            fail_count, resurfaced_count, error, run_id,
        ),
    )


# --- Convenience: stable JSON for snapshot hashing ---------------------------


def canonical_json(obj: Any) -> str:
    """Stable JSON for hashing: sorted keys, no whitespace, unicode preserved."""
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
