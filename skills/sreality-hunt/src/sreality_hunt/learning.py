"""Learning loop: mark / history / distill commands + few-shot builder.

Four entry points:

  * `run_mark` - records a reaction (liked/rejected/saved/visited) on a
    listing, optionally with a note and a search context hint.

  * `run_history` - browses recent reactions, optionally filtered by
    search or reaction kind.

  * `run_distill` - two-mode command for the long-term learning loop:
        * Read mode (default): emits structured data the LLM uses to
          summarize patterns from past reactions into prose.
        * Apply mode (`--apply <file>` or `--apply -` for stdin): writes
          the prose into the saved-search YAML's `learned_preferences:`
          field via `SavedSearch.dump`.

  * `build_fewshot_examples` - helper called by the CLI dispatcher when
    invoking digest / evaluate. Joins reactions x seen x latest snapshot
    and returns `FewShotExample` rows for the LLM's few-shot context.

Reactions are joined to a search via the `seen` table, not via
`reactions.search_name`. This matches `db.recent_reactions_for_search`:
marking a listing without a search context still contributes to few-shot
for any search where that listing has been surfaced.
"""

import logging
import sqlite3
import sys
from pathlib import Path

from . import db
from .models import SavedSearch, search_path
from .render import FewShotExample, fmt_czk

log = logging.getLogger("sreality_hunt.learning")


# ============================================================================
# mark
# ============================================================================


def run_mark(
    *,
    db_conn: sqlite3.Connection,
    hash_id: int,
    reaction: str,
    note: str | None = None,
    search_name: str | None = None,
) -> str:
    """Record a reaction. Returns confirmation markdown for the CLI to print.

    `db.insert_reaction` does the value validation; we just surface a nice
    confirmation message. The `reactions.hash_id` column has no FK by
    design, so this works even when the user marks a listing that has
    never been evaluated.
    """
    db.insert_reaction(
        db_conn,
        hash_id=hash_id,
        reaction=reaction,
        note=note,
        search_name=search_name,
    )

    snap = db.get_latest_snapshot(db_conn, hash_id)
    listing = db.get_listing(db_conn, hash_id)

    where = f" in search `{search_name}`" if search_name else ""
    lines = [f"Marked listing {hash_id} as **{reaction.upper()}**{where}."]
    if snap is not None:
        if snap["title"]:
            lines.append(f"  - Title: {snap['title']}")
        if snap["price_czk"] and snap["price_czk"] >= 100_000:
            lines.append(f"  - Price: {fmt_czk(snap['price_czk'])}")
        if listing is not None and listing["url"]:
            lines.append(f"  - Link: {listing['url']}")
    else:
        lines.append(
            "  - _(listing not in DB; run `evaluate "
            f"{hash_id}` to fetch its detail)_"
        )
    if note:
        lines.append(f"  - Note: \"{note}\"")
    return "\n".join(lines) + "\n"


# ============================================================================
# history
# ============================================================================


def run_history(
    *,
    db_conn: sqlite3.Connection,
    search_name: str | None = None,
    reaction_filter: str | None = None,
    limit: int = 20,
) -> str:
    """List recent reactions joined with their latest snapshot for context."""
    if reaction_filter is not None and reaction_filter not in db.VALID_REACTIONS:
        raise ValueError(
            f"invalid reaction {reaction_filter!r}; "
            f"expected one of {db.VALID_REACTIONS}"
        )
    # SQLite treats `LIMIT -1` as "no limit"; clamp so a negative value
    # can't accidentally disable pagination via a stray CLI flag.
    limit = max(1, limit)

    # `--search` scopes reactions via the `seen` table - matching what
    # distill / build_fewshot_examples do. Filtering on `reactions.search_name`
    # would diverge from that scoping: a reaction recorded without `--search`
    # would inform distill/few-shot for searches where the listing was
    # surfaced, but be absent from `history --search`, contradicting the
    # counts shown by `search list`.
    join_parts: list[str] = []
    where_parts: list[str] = []
    params: list[object] = []
    if search_name:
        join_parts.append(
            "JOIN seen sn ON sn.hash_id = r.hash_id AND sn.search_name = ?"
        )
        params.append(search_name)
    if reaction_filter:
        where_parts.append("r.reaction = ?")
        params.append(reaction_filter)
    join_clause = ("\n        " + "\n        ".join(join_parts)) if join_parts else ""
    where_clause = (" WHERE " + " AND ".join(where_parts)) if where_parts else ""

    # Most-recent snapshot per listing via a correlated subquery on max(id).
    # `id` is autoincrement so ordering by it == ordering by fetched_at for
    # this use, and `MAX(id)` plays nicely with the existing
    # idx_snapshots_hash_fetched index.
    rows = db_conn.execute(
        f"""
        SELECT r.id, r.hash_id, r.reaction, r.reacted_at, r.note, r.search_name,
               snap.title, snap.price_czk, snap.usable_area, snap.locality_display
        FROM reactions r{join_clause}
        LEFT JOIN snapshots snap ON snap.id = (
            SELECT MAX(id) FROM snapshots WHERE hash_id = r.hash_id
        )
        {where_clause}
        ORDER BY r.reacted_at DESC
        LIMIT ?
        """,
        [*params, limit],
    ).fetchall()

    total = db_conn.execute(
        f"SELECT COUNT(*) FROM reactions r{join_clause}{where_clause}", params,
    ).fetchone()[0]

    return _render_history(
        rows=rows, total=total,
        search_name=search_name, reaction_filter=reaction_filter,
    )


def _render_history(
    *,
    rows: list[sqlite3.Row],
    total: int,
    search_name: str | None,
    reaction_filter: str | None,
) -> str:
    if not rows and total == 0:
        if search_name or reaction_filter:
            return "_No reactions match the given filters._\n"
        return (
            "_No reactions recorded yet. Use `sreality-hunt mark <hash_id> "
            "<reaction>` to start._\n"
        )

    filter_bits: list[str] = []
    if search_name:
        filter_bits.append(f"search=`{search_name}`")
    if reaction_filter:
        filter_bits.append(f"reaction=`{reaction_filter}`")

    header = "# Reaction history"
    if filter_bits:
        header += f" ({', '.join(filter_bits)})"
    if total > len(rows):
        header += f"\n\n_Showing {len(rows)} most recent of {total}._"
    else:
        header += f"\n\n_{total} total._"

    lines = [header, ""]
    for r in rows:
        date = r["reacted_at"][:16].replace("T", " ")
        reaction = r["reaction"].upper()
        context = _build_listing_context_summary(r)
        sname_part = f"  _(via `{r['search_name']}`)_" if r["search_name"] else ""
        lines.append(f"- `{date}`  **{reaction}**  `{r['hash_id']}`{sname_part}")
        if context:
            lines.append(f"  - {context}")
        if r["note"]:
            lines.append(f"  - note: \"{r['note']}\"")

    return "\n".join(lines) + "\n"


# ============================================================================
# distill
# ============================================================================


def run_distill(
    *,
    db_conn: sqlite3.Connection,
    search: SavedSearch,
    max_per_reaction: int = 10,
    apply_from: str | None = None,
) -> str:
    """Two-mode entry point.

    With `apply_from=None`: emits the structured input for the LLM to
    summarize past reactions into prose. With `apply_from` set to a path
    (or `-` for stdin), reads the prose and writes it into the saved
    search's YAML at `learned_preferences:`, then returns a confirmation
    message.
    """
    if apply_from is not None:
        return _apply_distilled(search, apply_from)
    return _emit_distill_prompt(db_conn, search, max_per_reaction)


def _emit_distill_prompt(
    db_conn: sqlite3.Connection, search: SavedSearch, max_per_reaction: int,
) -> str:
    """Build the structured prompt the LLM will use to distill preferences."""
    rows_by_kind: dict[str, list[sqlite3.Row]] = {}
    for kind in db.VALID_REACTIONS:
        rows_by_kind[kind] = db_conn.execute(
            """
            SELECT r.id, r.hash_id, r.reaction, r.reacted_at, r.note,
                   snap.title, snap.price_czk, snap.usable_area, snap.locality_display,
                   sn.last_surfaced_tier, sn.last_surfaced_reason
            FROM reactions r
            JOIN seen sn ON sn.hash_id = r.hash_id AND sn.search_name = ?
            LEFT JOIN snapshots snap ON snap.id = (
                SELECT MAX(id) FROM snapshots WHERE hash_id = r.hash_id
            )
            WHERE r.reaction = ?
            ORDER BY r.reacted_at DESC
            LIMIT ?
            """,
            (search.name, kind, max_per_reaction),
        ).fetchall()

    total = sum(len(v) for v in rows_by_kind.values())

    lines = [
        f"# Distill preferences for search `{search.name}`",
        "",
        "## Existing soft preferences",
        "",
        search.preferences.strip() if search.preferences.strip() else "_(none configured)_",
        "",
        "## Existing learned preferences",
        "",
        (search.learned_preferences.strip() if search.learned_preferences.strip()
         else "_(none distilled yet)_"),
        "",
    ]

    if total == 0:
        lines.extend([
            "## No reactions found",
            "",
            f"_No reactions are recorded on listings ever surfaced in search "
            f"`{search.name}`. Use `sreality-hunt mark <hash_id> <reaction>` "
            "to record some first._",
            "",
        ])
        return "\n".join(lines)

    lines.append(f"## Reactions to draw patterns from ({total})")
    lines.append("")

    for kind in db.VALID_REACTIONS:
        rows = rows_by_kind[kind]
        if not rows:
            continue
        lines.append(f"### {kind.upper()} ({len(rows)})")
        lines.append("")
        for r in rows:
            ctx = _build_listing_context_summary(r)
            lines.append(f"- **{r['hash_id']}**  {ctx}")
            if r["title"]:
                lines.append(f"  - title: {r['title']}")
            if r["last_surfaced_tier"]:
                tier_str = r["last_surfaced_tier"]
                if r["last_surfaced_reason"]:
                    tier_str += f" ({r['last_surfaced_reason']})"
                lines.append(f"  - tier when surfaced: {tier_str}")
            if r["note"]:
                lines.append(f"  - note: \"{r['note']}\"")
        lines.append("")

    lines.extend([
        "## --- INSTRUCTIONS FOR DISTILLATION ---",
        "",
        "Read the reactions above and identify concrete patterns. Pay attention to",
        "what the LIKED listings share and what distinguishes them from the",
        "REJECTED ones. The tier info tells you which must-have checks the listing",
        "passed or failed when last surfaced - useful for spotting cases where the",
        "user liked something despite a soft-check failure, or rejected something",
        "that nominally matched.",
        "",
        "Summarize the patterns as Markdown bullet points. Focus on what's NOT",
        "already captured in the existing preferences. Specific patterns are more",
        "useful than generic statements (e.g. \"avoids listings on Veletržní\" is",
        "better than \"prefers quiet streets\").",
        "",
        "To save your distilled prose into `learned_preferences:` in the YAML, run:",
        "",
        f"  sreality-hunt distill {search.name} --apply <file>",
        "",
        "or pipe via stdin:",
        "",
        f"  echo '<prose>' | sreality-hunt distill {search.name} --apply -",
        "",
    ])

    return "\n".join(lines)


def _apply_distilled(search: SavedSearch, apply_from: str) -> str:
    """Read prose from path/stdin, overwrite `learned_preferences:` in YAML.

    Re-loads the YAML from disk before writing so that any concurrent edits
    the user made between the initial `distill` read and `--apply` are
    preserved. Only `learned_preferences:` is overwritten; everything else
    in the file is sourced from the on-disk copy at apply time, not from
    the `search` parameter (which may be stale by the time the agent
    composes the prose and invokes apply).

    The `search` parameter is still required because it identifies *which*
    saved-search file to update (`search.name` -> path).
    """
    if apply_from == "-":
        prose = sys.stdin.read()
        source = "stdin"
    else:
        prose = Path(apply_from).read_text(encoding="utf-8")
        source = apply_from

    prose = prose.strip()
    if not prose:
        raise ValueError(
            f"distilled prose from {source} is empty; refusing to overwrite "
            "learned_preferences with nothing"
        )

    path = search_path(search.name)
    current = SavedSearch.load(path)
    updated = current.model_copy(update={"learned_preferences": prose})
    updated.dump(path)
    return (
        f"Wrote {len(prose)} chars of distilled prose to "
        f"`learned_preferences` in {path} (source: {source}).\n"
    )


# ============================================================================
# Few-shot builder (called from CLI dispatcher into digest/evaluate)
# ============================================================================


def build_fewshot_examples(
    db_conn: sqlite3.Connection,
    search_name: str,
    *,
    limit_per_reaction: int = 5,
) -> list[FewShotExample]:
    """Build `FewShotExample` rows for the LLM context of digest/evaluate.

    Pulls up to `limit_per_reaction` recent reactions per reaction kind on
    listings ever surfaced in this search, joins with the latest snapshot
    for context. Skips reactions where no snapshot exists (no context to
    feed the LLM).
    """
    rows = db.recent_reactions_for_search(
        db_conn, search_name, limit_per_reaction=limit_per_reaction,
    )
    examples: list[FewShotExample] = []
    for r in rows:
        snap = db.get_latest_snapshot(db_conn, int(r["hash_id"]))
        if snap is None:
            continue
        summary = _build_listing_context_summary(snap)
        if not summary:
            # Bare row with no contextual fields - skip rather than emit
            # a useless FewShot example.
            continue
        examples.append(FewShotExample(
            hash_id=int(r["hash_id"]),
            reaction=r["reaction"],
            summary=summary,
            note=r["note"],
        ))
    return examples


# ============================================================================
# Internal helpers
# ============================================================================


def _build_listing_context_summary(row: sqlite3.Row) -> str:
    """Build a short context string like 'Praha 7 - Žižkov, 78m², 11.9M'.

    Robust to missing columns: queries that select only some of the
    title/price/area/locality fields still work.
    """
    keys = row.keys()
    parts: list[str] = []
    if "locality_display" in keys and row["locality_display"]:
        loc = row["locality_display"]
        # Most sreality locality strings start with "<street>, <city> - <ward>";
        # trim to ~40 chars for compact display.
        parts.append(loc[:40])
    if "usable_area" in keys and row["usable_area"]:
        parts.append(f"{row['usable_area']}m²")
    if "price_czk" in keys and row["price_czk"] and row["price_czk"] >= 100_000:
        parts.append(f"{row['price_czk'] / 1_000_000:.1f}M")
    return ", ".join(parts)
