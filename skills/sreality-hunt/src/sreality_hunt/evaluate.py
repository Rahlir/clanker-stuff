"""Evaluate command body - single-listing deep dive.

`run_evaluate(...)` produces one evaluation packet (sections 1, 3, 4 +
photos + description, plus an INPUTS appendix when a search is provided).
The agent (chat-layer LLM) reads the packet and composes sections 2
(grade), 5 (qualitative analysis), 6 (red flags), 7 (next actions).

Two modes:

  * **Fresh fetch** (default) - hits the API for current detail, persists
    listing + snapshot, then classifies and renders.

  * **`--from-snapshot`** - reads the latest snapshot in the DB, skipping
    the detail fetch. Pricing context may still hit the API to populate
    its cache (or reuse a shared provider passed in by the caller).
    Raises `SnapshotMissing` if no snapshot exists for the listing.

`search` is optional. With no search:

  * No must-have checks run (tier is vacuously `match`)
  * No INPUTS appendix
  * No `seen` tracking (we don't know which search context applies)

With a search, the listing is marked as `seen` in the DB so a subsequent
digest doesn't re-surface it as "new". The latest snapshot ID is what
gets recorded, regardless of mode.
"""

import json
import logging
import sqlite3

from pydantic import ValidationError

from . import db
from .api import (
    SrealityClient,
    build_listing_url,
    build_locality_slug,
    slim_detail,
    snapshot_hash,
)
from .facts import classify_results, evaluate_must_haves, extract_facts
from .models import ListingDetail, SavedSearch
from .pricing import ComparablePricingProvider
from .render import (
    FewShotExample,
    render_evaluation_packet,
    render_inputs_appendix,
)

log = logging.getLogger("sreality_hunt.evaluate")


# ============================================================================
# Errors
# ============================================================================


class SnapshotMissing(Exception):
    """Raised when `--from-snapshot` is requested but no snapshot exists."""


# ============================================================================
# Public entry
# ============================================================================


def run_evaluate(
    *,
    hash_id: int,
    db_conn: sqlite3.Connection,
    client: SrealityClient,
    search: SavedSearch | None = None,
    pricing: ComparablePricingProvider | None = None,
    from_snapshot: bool = False,
    fewshot_examples: list[FewShotExample] | None = None,
) -> str:
    """Evaluate one listing. Returns the rendered markdown.

    The caller (CLI) writes the markdown wherever it wants. Side effects
    in fresh-fetch mode: writes a snapshot if changed, upserts the
    `listings` row, upserts `seen` (only when `search` is provided).
    """
    pricing = pricing or ComparablePricingProvider(client)

    if from_snapshot:
        detail, snapshot_id = _load_from_snapshot(db_conn, hash_id)
    else:
        detail, snapshot_id = fetch_and_persist_detail(db_conn, client, hash_id)

    facts = extract_facts(detail)
    must_haves = search.must_haves if search else []
    results = evaluate_must_haves(facts, must_haves)
    tier, failed = classify_results(results)
    price_ctx = pricing.context_for(facts)

    # Mark seen when we have a search context. The snapshot ID is the same
    # one we persisted (fresh) or loaded (from-snapshot); either way it's
    # the snapshot the user just looked at.
    if search is not None:
        db.upsert_seen(
            db_conn,
            search_name=search.name,
            hash_id=hash_id,
            snapshot_id=snapshot_id,
            tier=tier,
            reason=",".join(failed) if failed else None,
        )

    packet = render_evaluation_packet(
        facts=facts,
        results=results,
        tier=tier,
        failed_reasons=failed,
        price_ctx=price_ctx,
        image_urls=facts.image_urls,
        change_flag=None,
    )

    if search is None:
        return packet.rstrip() + "\n"

    appendix = render_inputs_appendix(
        soft_preferences=search.preferences,
        learned_preferences=search.learned_preferences,
        fewshot_examples=fewshot_examples or [],
    )
    return packet.rstrip() + "\n\n" + appendix.rstrip() + "\n"


# ============================================================================
# Fetch + persist (shared with digest.py)
# ============================================================================


def fetch_and_persist_detail(
    db_conn: sqlite3.Connection, client: SrealityClient, hash_id: int,
) -> tuple[ListingDetail, int]:
    """Fetch a listing's detail from the API and persist it to the DB.

    Single source of truth for the "fresh detail" persistence invariant
    used by both `evaluate` and `digest`. The returned `snapshot_id`
    refers to the row in `snapshots` corresponding to this detail (either
    a newly inserted row, or the latest existing row if the snapshot
    hash matched).

    Lets `api.ListingNotFound` and other `api.SrealityError` subclasses
    propagate so callers can decide whether to surface, skip, or abort.
    """
    raw = client.get_detail_raw(hash_id)   # unwrapped `result` object
    detail = ListingDetail.model_validate(raw)
    slim = slim_detail(raw)
    h = snapshot_hash(detail)
    loc = detail.locality
    slug = build_locality_slug(loc)

    url = build_listing_url(
        category_type_cb=detail.category_type_cb.value,
        category_main_cb=detail.category_main_cb.value,
        category_sub_cb=detail.category_sub_cb.value,
        locality_slug=slug,
        hash_id=hash_id,
    )
    db.upsert_listing(
        db_conn,
        hash_id=hash_id,
        category_main_cb=detail.category_main_cb.value,
        category_sub_cb=detail.category_sub_cb.value,
        category_type_cb=detail.category_type_cb.value,
        locality_slug=slug,
        locality_region_id=loc.region_id,
        locality_district_id=loc.district_id,
        url=url,
    )
    snapshot_id, _inserted = db.insert_snapshot_if_changed(
        db_conn,
        hash_id=hash_id,
        snapshot_hash=h,
        price_czk=detail.price_czk,
        usable_area=detail.usable_area,
        title=detail.advert_name,
        locality_display=loc.display(),
        raw_json=json.dumps(slim, ensure_ascii=False, separators=(",", ":")),
    )
    return detail, snapshot_id


# ============================================================================
# From-snapshot loader
# ============================================================================


def _load_from_snapshot(
    db_conn: sqlite3.Connection, hash_id: int,
) -> tuple[ListingDetail, int]:
    """Read the latest snapshot from DB and parse it as ListingDetail.

    The snapshot's `raw_json` is the slimmed form (`api.slim_detail`). The
    slim form drops POI lists and seller info but keeps every field
    `ListingDetail` declares (or marks optional), so model validation
    succeeds without code changes.
    """
    snap = db.get_latest_snapshot(db_conn, hash_id)
    if snap is None:
        raise SnapshotMissing(
            f"no snapshot in DB for listing {hash_id}; "
            f"run without --from-snapshot to fetch fresh"
        )
    raw = json.loads(snap["raw_json"])
    try:
        return ListingDetail.model_validate(raw), int(snap["id"])
    except ValidationError as e:
        # Most likely the snapshot predates the v1 schema migration; treat as
        # unusable so the caller re-fetches fresh instead of crashing. Logged
        # (not silent) so a genuine v1 parsing regression is still visible.
        # ValidationError.__str__ is a multi-line table; keep the log to one line.
        summary = str(e).splitlines()[0] if str(e) else repr(e)
        log.warning(
            "snapshot for %d failed to parse as ListingDetail (%s); "
            "treating as missing", hash_id, summary,
        )
        raise SnapshotMissing(
            f"snapshot for {hash_id} could not be reparsed "
            f"(likely pre-v1 schema); run without --from-snapshot to fetch fresh"
        ) from e
