"""Digest command body - Pass 1 of the digest workflow.

`run_digest(search, db_conn, client, ...)` walks the saved-search API
queries, classifies each candidate, persists snapshots + seen state, and
returns a single markdown document for the agent to consume.

The agent (Pass 2) reads that markdown, picks promising IDs, and calls
`evaluate <id> --from-snapshot` per pick. Pass 3 is the agent composing the
final user-facing reply.

Three output buckets:

  * **Re-surfaced** - previously seen + material change since last surface
    (price delta >= 5%, or hidden<->revealed). Full evaluation packet per
    listing.

  * **New candidates** - never seen before in this search, tier in
    {match, near-miss}. Compact rows; agent picks which to deep-dive.

  * **Filtered out** - never seen before, tier == fail. Count + breakdown.

Plus a silent "already seen, unchanged" count for transparency.

Cost optimization: the cheap pre-check compares each summary's price to
the last surfaced snapshot's price *without* fetching detail. Listings
that haven't moved are skipped before the expensive detail call. After
the first run, steady-state digests cost ~1 detail fetch per genuinely
new or changed listing.
"""

import logging
import sqlite3
from dataclasses import dataclass

from pydantic import BaseModel, ConfigDict

from . import db
from .api import (
    ListingNotFound,
    SrealityClient,
    SrealityError,
    build_search_params,
)
from .evaluate import fetch_and_persist_detail
from .facts import (
    CheckResult,
    Facts,
    Tier,
    classify_results,
    evaluate_must_haves,
    extract_facts,
)
from .models import SavedSearch
from .pricing import ComparablePricingProvider, PriceContext
from .render import (
    FewShotExample,
    render_compact_row,
    render_evaluation_packet,
    render_filtered_summary,
    render_inputs_appendix,
)

log = logging.getLogger("sreality_hunt.digest")


# Re-surface threshold. Matches the agreed-upon "price change >= 5%" rule.
MATERIAL_PRICE_DELTA = 0.05

# Same threshold used in facts.py and pricing.py for "hidden" prices.
# Imported again here only because we need to detect hidden<->revealed
# transitions; importing the constant from facts keeps the meaning in sync.
from .facts import PRICE_HIDDEN_THRESHOLD  # noqa: E402

# ============================================================================
# Output types
# ============================================================================


class DigestCounts(BaseModel):
    """Aggregate counts written to digest_runs and surfaced in the output."""
    model_config = ConfigDict(extra="forbid")

    candidates_seen: int = 0       # total listings inspected from API
    new_match: int = 0             # first surface this search, tier=match
    new_near_miss: int = 0         # first surface this search, tier=near-miss
    new_fail: int = 0              # first surface this search, tier=fail
    resurfaced: int = 0            # previously seen + material change
    skipped_unchanged: int = 0     # previously seen + nothing material changed
    fetch_errors: int = 0          # detail fetches that failed (transport/5xx)
    listings_gone: int = 0         # 404/410 between list and detail (race)
    cap_reached: bool = False      # max_listings was hit


@dataclass(slots=True)
class _ProcessedEntry:
    """Internal carrier for a listing we're going to surface.

    Bundles everything the renderer needs so the rendering pass doesn't
    have to re-derive facts from raw detail.
    """
    facts: Facts
    results: list[CheckResult]
    tier: Tier
    failed: list[str]
    price_ctx: PriceContext
    change_flag: str | None       # None for new candidates, set for re-surfaced


# ============================================================================
# Public entry
# ============================================================================


def run_digest(
    *,
    search: SavedSearch,
    db_conn: sqlite3.Connection,
    client: SrealityClient,
    pricing: ComparablePricingProvider | None = None,
    max_listings: int | None = None,
    fewshot_examples: list[FewShotExample] | None = None,
) -> tuple[str, DigestCounts]:
    """Run one digest pass for a saved search.

    Returns `(markdown, counts)`. The caller (CLI) writes the markdown
    wherever it wants (stdout by default); `counts` is also persisted in
    the `digest_runs` audit row before this function returns.

    Raises only on truly fatal errors (API completely unreachable, DB
    error). Per-listing failures are logged and counted, not raised.
    """
    pricing = pricing or ComparablePricingProvider(client)
    cap = max_listings if max_listings is not None else search.filters.max_listings
    fewshot = fewshot_examples or []

    counts = DigestCounts()
    seen_state = _load_seen_state(db_conn, search.name)
    run_id = db.start_digest_run(db_conn, search.name)

    new_processed: list[_ProcessedEntry] = []
    resurfaced: list[_ProcessedEntry] = []
    fail_reason_counts: dict[str, int] = {}

    try:
        processed_hash_ids: set[int] = set()
        for q in build_search_params(search):
            if counts.candidates_seen >= cap:
                break
            for summary in client.iter_search(
                q, max_listings=cap - counts.candidates_seen,
            ):
                if summary.hash_id in processed_hash_ids:
                    continue
                processed_hash_ids.add(summary.hash_id)
                counts.candidates_seen += 1

                entry = _process_listing(
                    summary=summary,
                    search=search,
                    seen_state=seen_state,
                    db_conn=db_conn,
                    client=client,
                    pricing=pricing,
                    counts=counts,
                    fail_reason_counts=fail_reason_counts,
                )
                if entry is None:
                    continue  # skipped, errored, or fail (already counted)
                if entry.change_flag is not None:
                    resurfaced.append(entry)
                else:
                    new_processed.append(entry)

        counts.cap_reached = counts.candidates_seen >= cap

    except Exception as e:
        # Surface what we have, then re-raise.
        db.finish_digest_run(
            db_conn, run_id,
            candidates_seen=counts.candidates_seen,
            match_count=counts.new_match,
            near_miss_count=counts.new_near_miss,
            fail_count=counts.new_fail,
            resurfaced_count=counts.resurfaced,
            error=f"{type(e).__name__}: {e}",
        )
        raise

    db.finish_digest_run(
        db_conn, run_id,
        candidates_seen=counts.candidates_seen,
        match_count=counts.new_match,
        near_miss_count=counts.new_near_miss,
        fail_count=counts.new_fail,
        resurfaced_count=counts.resurfaced,
    )

    new_processed.sort(key=_sort_key)
    resurfaced.sort(key=_sort_key)
    output = _render(
        search=search,
        counts=counts,
        resurfaced=resurfaced,
        new_processed=new_processed,
        fail_reason_counts=fail_reason_counts,
        fewshot=fewshot,
    )
    return output, counts


# ============================================================================
# Per-listing processing
# ============================================================================


def _process_listing(
    *,
    summary,
    search: SavedSearch,
    seen_state: dict[int, "_SeenState"],
    db_conn: sqlite3.Connection,
    client: SrealityClient,
    pricing: ComparablePricingProvider,
    counts: DigestCounts,
    fail_reason_counts: dict[str, int],
) -> _ProcessedEntry | None:
    """Process one summary. Returns a `_ProcessedEntry` if it should be
    surfaced, or None if it was skipped/errored/fails-tier (counted in
    `counts` / `fail_reason_counts` as a side effect)."""
    prior = seen_state.get(summary.hash_id)

    # Cheap pre-check: previously seen + summary price hasn't moved enough.
    if prior is not None and not _is_material_price_change(prior.last_price, summary.price):
        counts.skipped_unchanged += 1
        return None

    # Fetch + persist. Tolerate per-listing failures so a single bad
    # listing doesn't abort the whole digest.
    try:
        detail, snapshot_id = fetch_and_persist_detail(
            db_conn, client, summary.hash_id,
        )
    except ListingNotFound:
        log.info(
            "listing %d disappeared between list and detail (404/410); skipping",
            summary.hash_id,
        )
        counts.listings_gone += 1
        return None
    except SrealityError as e:
        log.warning("fetch error for listing %d: %s", summary.hash_id, e)
        counts.fetch_errors += 1
        return None

    facts = extract_facts(detail, summary=summary)
    results = evaluate_must_haves(facts, search.must_haves)
    tier, failed = classify_results(results)

    change_flag = (
        _build_change_flag(prior.last_price, facts.price_czk) if prior else None
    )

    # Update seen state in DB even for fails so the user gets the
    # "already seen, unchanged" silent-skip on the next run.
    db.upsert_seen(
        db_conn,
        search_name=search.name,
        hash_id=summary.hash_id,
        snapshot_id=snapshot_id,
        tier=tier,
        reason=",".join(failed) if failed else None,
    )

    # New fail tier: count + breakdown, but don't surface.
    if change_flag is None and tier == "fail":
        counts.new_fail += 1
        for reason in failed:
            fail_reason_counts[reason] = fail_reason_counts.get(reason, 0) + 1
        return None

    # Surfaced: re-surfaced or new {match, near-miss}. Compute pricing.
    price_ctx = pricing.context_for(facts)

    if change_flag is not None:
        counts.resurfaced += 1
    elif tier == "match":
        counts.new_match += 1
    else:
        counts.new_near_miss += 1

    return _ProcessedEntry(
        facts=facts,
        results=results,
        tier=tier,
        failed=failed,
        price_ctx=price_ctx,
        change_flag=change_flag,
    )


# ============================================================================
# Seen-state cache
# ============================================================================


@dataclass(slots=True)
class _SeenState:
    last_snapshot_id: int | None
    last_price: int | None  # from last surfaced snapshot; None if snapshot deleted


def _load_seen_state(
    db_conn: sqlite3.Connection, search_name: str,
) -> dict[int, _SeenState]:
    """Pre-load `seen` joined with last snapshot's price for the search.

    One query up front beats one per candidate. The result drives the
    cheap pre-check (skip if seen + summary.price hasn't moved >= 5%).
    """
    rows = db_conn.execute(
        """
        SELECT
            s.hash_id,
            s.last_surfaced_snapshot_id,
            snap.price_czk AS last_price
        FROM seen s
        LEFT JOIN snapshots snap ON snap.id = s.last_surfaced_snapshot_id
        WHERE s.search_name = ?
        """,
        (search_name,),
    ).fetchall()
    return {
        int(r["hash_id"]): _SeenState(
            last_snapshot_id=r["last_surfaced_snapshot_id"],
            last_price=r["last_price"],
        )
        for r in rows
    }


# ============================================================================
# Change detection
# ============================================================================


def _is_material_price_change(old_price: int | None, new_price: int) -> bool:
    """True if summary price differs from last snapshot's price enough to
    warrant a fresh detail fetch. Hidden<->revealed transitions always
    qualify."""
    if old_price is None:
        # No prior snapshot for this seen row (snapshot deleted / FK
        # nulled). Be safe and re-fetch.
        return True
    new_hidden = new_price < PRICE_HIDDEN_THRESHOLD
    old_hidden = old_price < PRICE_HIDDEN_THRESHOLD
    if new_hidden != old_hidden:
        return True
    if new_hidden and old_hidden:
        return False  # both hidden, nothing to compare
    # Delta is computed relative to the prior (baseline) price so the
    # detection threshold matches the display formula in
    # `_build_change_flag` ("price-drop -8%" is computed as
    # `(new - old) / old`). Using `max(old, new)` would make exactly-5%
    # increases come out to 4.76% and fail the threshold.
    delta = abs(new_price - old_price) / old_price
    return delta >= MATERIAL_PRICE_DELTA


def _build_change_flag(old_price: int | None, new_price: int) -> str:
    """Produce the change_flag string for a re-surfaced listing.

    Caller has already established that this *is* a material change via
    `_is_material_price_change`; this function only formats it.
    """
    if old_price is None:
        return "snapshot-restored"
    new_hidden = new_price < PRICE_HIDDEN_THRESHOLD
    old_hidden = old_price < PRICE_HIDDEN_THRESHOLD
    if new_hidden and not old_hidden:
        return "price-removed"
    if old_hidden and not new_hidden:
        return "price-revealed"
    if old_hidden and new_hidden:
        # Unreachable in practice: the caller only invokes this after
        # `_is_material_price_change`, which returns False for both-hidden.
        # Kept total so the return type stays `str`.
        return "price-changed"
    # Both prices visible.
    delta_pct = (new_price - old_price) / old_price * 100
    direction = "drop" if delta_pct < 0 else "up"
    sign = "" if delta_pct < 0 else "+"  # "-8%" is natural; "+5%" needs the sign
    return f"price-{direction} {sign}{delta_pct:.0f}%"


# ============================================================================
# Sorting
# ============================================================================


_TIER_PRIORITY: dict[Tier, int] = {"match": 0, "near-miss": 1, "fail": 2}


def _sort_key(entry: _ProcessedEntry) -> tuple[int, int, int]:
    """Sort: tier asc, then percentile asc (cheapest first), then hash_id."""
    pct = entry.price_ctx.percentile if entry.price_ctx.percentile is not None else 999
    return (_TIER_PRIORITY[entry.tier], pct, entry.facts.hash_id)


# ============================================================================
# Rendering
# ============================================================================


def _render(
    *,
    search: SavedSearch,
    counts: DigestCounts,
    resurfaced: list[_ProcessedEntry],
    new_processed: list[_ProcessedEntry],
    fail_reason_counts: dict[str, int],
    fewshot: list[FewShotExample],
) -> str:
    parts: list[str] = [
        f"# Digest: {search.name}",
        "",
        _render_summary_line(counts),
        "",
        render_inputs_appendix(
            soft_preferences=search.preferences,
            learned_preferences=search.learned_preferences,
            fewshot_examples=fewshot,
        ),
        "",
    ]

    if resurfaced:
        parts.append(f"## Re-surfaced ({len(resurfaced)})")
        parts.append("")
        for entry in resurfaced:
            parts.append(render_evaluation_packet(
                facts=entry.facts,
                results=entry.results,
                tier=entry.tier,
                failed_reasons=entry.failed,
                price_ctx=entry.price_ctx,
                image_urls=entry.facts.image_urls,
                change_flag=entry.change_flag,
            ))
            parts.append("")
            parts.append("---")
            parts.append("")

    if new_processed:
        parts.append(f"## New candidates ({len(new_processed)})")
        parts.append("")
        parts.append("```")
        for entry in new_processed:
            parts.append(render_compact_row(
                facts=entry.facts,
                tier=entry.tier,
                failed_reasons=entry.failed,
                ctx=entry.price_ctx,
                change_flag=None,
            ))
        parts.append("```")
        parts.append("")

    if fail_reason_counts:
        parts.append(f"## Filtered out ({counts.new_fail})")
        parts.append("")
        parts.append(render_filtered_summary(fail_reason_counts))
        parts.append("")

    if counts.skipped_unchanged:
        parts.append("## Already seen, unchanged")
        parts.append("")
        parts.append(
            f"_{counts.skipped_unchanged} listings already surfaced in prior "
            "digests with no material change._"
        )
        parts.append("")

    if not resurfaced and not new_processed and not fail_reason_counts:
        parts.append("_No new or changed listings since the last digest._")
        parts.append("")

    return "\n".join(parts).rstrip() + "\n"


def _render_summary_line(counts: DigestCounts) -> str:
    """One-line summary just below the digest header."""
    bits = [f"{counts.candidates_seen} candidates inspected"]
    if counts.new_match:
        bits.append(f"**{counts.new_match} new match**")
    if counts.new_near_miss:
        bits.append(f"{counts.new_near_miss} new near-miss")
    if counts.new_fail:
        bits.append(f"{counts.new_fail} new fail")
    if counts.resurfaced:
        bits.append(f"**{counts.resurfaced} re-surfaced**")
    if counts.skipped_unchanged:
        bits.append(f"{counts.skipped_unchanged} unchanged")
    if counts.listings_gone:
        bits.append(f"{counts.listings_gone} gone")
    if counts.fetch_errors:
        bits.append(f"{counts.fetch_errors} fetch errors")
    line = " | ".join(bits)
    if counts.cap_reached:
        # `cap_reached` only means `candidates_seen == cap`; it can't
        # distinguish "we truncated" from "the API returned exactly cap
        # listings". Phrase the note neutrally so it's accurate either way.
        line += (
            "\n\n_Inspected up to `filters.max_listings` candidates; raise "
            "this limit if you want to see more._"
        )
    return f"**Summary:** {line}"
