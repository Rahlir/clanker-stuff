"""Comparable-pricing percentile.

For a target listing, compute its price/m² percentile relative to other
listings in the same (district, main_cb, sub_cb, type_cb) cohort. The
result feeds section 4 of the evaluation packet (hard-fact scoring) and the
compact row of the digest's middle bucket.

Architecture:

  * `ComparablePricingProvider` caches per-bucket comparable lists for the
    lifetime of its instance (intended: one provider per digest run). The
    first lookup in a bucket triggers one API call; subsequent lookups in
    the same bucket are free.

  * Comparables are sourced from the list endpoint only (no per-listing
    detail fetches). `usable_area` is parsed from the summary's `name`
    field; listings whose area can't be parsed or whose price is hidden
    ("Cena v RK") are excluded.

  * No area-window filter in v1. The disposition code (e.g. 3+kk) already
    constrains area implicitly, and skipping the area filter lets one
    cached bucket serve every target in that (district, sub_cb).
"""

import logging
import re
from statistics import median as _median

from pydantic import BaseModel, ConfigDict

from .api import SrealityClient
from .facts import PRICE_HIDDEN_THRESHOLD, Facts

log = logging.getLogger("sreality_hunt.pricing")


# How many summaries to pull per (district, main, sub, type) bucket. 50 is a
# representative sample for most cohorts and fits in a single API page.
DEFAULT_MAX_COMPARABLES = 50


# ============================================================================
# Output models
# ============================================================================


class ComparableListing(BaseModel):
    """One comparable used in the percentile calculation."""
    model_config = ConfigDict(extra="forbid")

    hash_id: int
    price_czk: int
    usable_area: int
    price_per_m2: int


class PriceContext(BaseModel):
    """Result of a comparable-pricing lookup for one target listing.

    `percentile` is the percent of comparables whose price/m² is <= the
    target's. Lower is cheaper relative to the cohort. Returns `None` when
    the target's price is hidden or the comparable set is empty.
    """
    model_config = ConfigDict(extra="forbid")

    target_hash_id: int
    target_price_per_m2: int | None

    district_id: int | None
    category_main_cb: int
    category_sub_cb: int

    comparable_count: int
    median_price_per_m2: int | None
    percentile: int | None             # 0-100


# ============================================================================
# Helpers
# ============================================================================


# Matches a number with optional Czech thousands separator (regular space or
# non-breaking space) followed by "m²". A separator is only valid between
# exactly-3-digit groups - that's the distinguishing rule. Without it, a
# string like "1+1 28 m²" would parse as 128 (treating " " as a thousands
# separator between "1" and "28").
#
# Examples extracted from real listing summaries:
#   "Prodej bytu 4+kk 78 m²"                          -> 78
#   "Prodej bytu 1+1 28\xa0m²"                        -> 28
#   "Prodej rodinného domu 350 m², pozemek 922 m²"    -> 350 (first match)
#   "Prodej chalupy 1 549 m²"                         -> 1549
#   "Prodej bytu 12 345 m²"                          -> 12345
#
# Accepted limitations (none observed in the wild as of probing 2026-05-17):
#   * Only matches "m²" (Unicode U+00B2). ASCII "m2" / "m^2" variants would
#     be silently dropped from the comparable set.
#   * A 4+ digit area without a thousands separator ("1234 m²") would parse
#     wrong; sreality consistently uses the separator.
_AREA_FROM_NAME_RE = re.compile(r"(\d{1,3}(?:[\s\u00a0]\d{3})*)\s*m²")


def parse_area_from_name(name: str) -> int | None:
    """Extract usable area in m² from a listing summary `name`. None if absent."""
    m = _AREA_FROM_NAME_RE.search(name)
    if not m:
        return None
    digits = re.sub(r"[\s\u00a0]", "", m.group(1))
    try:
        n = int(digits)
    except ValueError:
        return None
    return n if n > 0 else None


def compute_percentile(target: int, comparables: list[int]) -> int | None:
    """Percent of `comparables` with value <= `target`. None if empty."""
    if not comparables:
        return None
    le_count = sum(1 for c in comparables if c <= target)
    return round(100 * le_count / len(comparables))


# ============================================================================
# Provider
# ============================================================================


# Cache key shape; pulled out as a type alias to keep the dict declaration tidy.
_BucketKey = tuple[int, int, int, int]  # (district, main_cb, sub_cb, type_cb)


class ComparablePricingProvider:
    """In-memory comparable-pricing cache for one digest run.

    Excludes the target itself, listings with hidden prices, and listings
    whose summary `name` doesn't include a parseable area.

    Not safe for concurrent use from multiple threads (the cache is a plain
    dict). The agreed-upon digest workflow is sequential, so this is fine.
    """

    def __init__(
        self,
        client: SrealityClient,
        *,
        max_per_bucket: int = DEFAULT_MAX_COMPARABLES,
    ) -> None:
        self._client = client
        self._max_per_bucket = max_per_bucket
        self._cache: dict[_BucketKey, list[ComparableListing]] = {}

    def context_for(self, facts: Facts) -> PriceContext:
        """Compute a PriceContext for one target. Touches the network only on
        a cache miss for the target's (district, main, sub, type) bucket."""
        district_id = facts.locality_district_id
        main_cb = facts.category_main_cb
        sub_cb = facts.category_sub_cb
        type_cb = facts.category_type_cb
        target_per_m2 = facts.price_per_m2

        empty = PriceContext(
            target_hash_id=facts.hash_id,
            target_price_per_m2=target_per_m2,
            district_id=district_id,
            category_main_cb=main_cb,
            category_sub_cb=sub_cb,
            comparable_count=0,
            median_price_per_m2=None,
            percentile=None,
        )

        if district_id is None:
            log.debug(
                "no district_id on listing %d; skipping comparable pricing",
                facts.hash_id,
            )
            return empty

        bucket = self._get_or_fetch(district_id, main_cb, sub_cb, type_cb)
        comparables = [c for c in bucket if c.hash_id != facts.hash_id]

        if not comparables:
            return empty

        per_m2_list = [c.price_per_m2 for c in comparables]
        med = int(_median(per_m2_list))
        pct = compute_percentile(target_per_m2, per_m2_list) if target_per_m2 else None

        return PriceContext(
            target_hash_id=facts.hash_id,
            target_price_per_m2=target_per_m2,
            district_id=district_id,
            category_main_cb=main_cb,
            category_sub_cb=sub_cb,
            comparable_count=len(comparables),
            median_price_per_m2=med,
            percentile=pct,
        )

    def _get_or_fetch(
        self, district_id: int, main_cb: int, sub_cb: int, type_cb: int,
    ) -> list[ComparableListing]:
        key: _BucketKey = (district_id, main_cb, sub_cb, type_cb)
        cached = self._cache.get(key)
        if cached is not None:
            return cached
        comparables = self._fetch_bucket(district_id, main_cb, sub_cb, type_cb)
        self._cache[key] = comparables
        return comparables

    def _fetch_bucket(
        self, district_id: int, main_cb: int, sub_cb: int, type_cb: int,
    ) -> list[ComparableListing]:
        params: dict[str, str | int] = {
            "category_main_cb": main_cb,
            "category_sub_cb": sub_cb,
            "category_type_cb": type_cb,
            "locality_district_id": district_id,
        }
        comparables: list[ComparableListing] = []
        for summary in self._client.iter_search(
            params,
            max_listings=self._max_per_bucket,
            page_size=min(self._max_per_bucket, 60),
        ):
            if summary.price < PRICE_HIDDEN_THRESHOLD:
                continue
            area = parse_area_from_name(summary.name)
            if area is None:
                log.debug(
                    "couldn't parse area from name %r (hash_id=%d); excluding",
                    summary.name, summary.hash_id,
                )
                continue
            comparables.append(ComparableListing(
                hash_id=summary.hash_id,
                price_czk=summary.price,
                usable_area=area,
                price_per_m2=summary.price // area,
            ))
        log.debug(
            "fetched comparable bucket district=%d main=%d sub=%d type=%d: %d listings",
            district_id, main_cb, sub_cb, type_cb, len(comparables),
        )
        return comparables

    # --- Test/inspection helpers ------------------------------------------

    def cache_size(self) -> int:
        return len(self._cache)

    def cached_buckets(self) -> list[_BucketKey]:
        return list(self._cache.keys())
