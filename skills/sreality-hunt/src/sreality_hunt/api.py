"""HTTP client for sreality.cz + payload helpers.

Three concerns in one module:

  * `SrealityClient` - polite HTTP client with throttling and retries.
  * URL building (`build_listing_url`) and query building
    (`build_search_params`) - translation between our SavedSearch and the
    sreality URL/API conventions.
  * Storage normalization (`slim_detail`, `snapshot_hash`) - the boundary
    between the API response and what we persist in the snapshots table.

If this module grows beyond ~500 lines, split storage normalization into a
serialization.py.
"""

import hashlib
import json
import logging
import re
import threading
import time
from collections.abc import Iterable, Iterator
from typing import Any

import httpx

from . import codebooks
from .models import ListingDetail, ListingSummary, ListResponse, Locality, SavedSearch

# Module-level logger; the CLI configures handlers.
log = logging.getLogger("sreality_hunt.api")


# ============================================================================
# Constants
# ============================================================================

API_BASE = "https://www.sreality.cz/api/v1"
PUBLIC_BASE = "https://www.sreality.cz/detail"

# sreality's v1 API is fronted by Envoy and rejects some non-browser clients;
# a realistic desktop UA is the safe default.
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)

# Only the detail endpoint (`/estates/<numeric-id>`) maps a 404/410 to
# "listing gone". The search endpoint (`/estates/search`) must not.
_DETAIL_PATH_RE = re.compile(r"^/estates/\d+$")

# Polite defaults; can be overridden per client instance.
DEFAULT_RATE_LIMIT_RPS = 1.0
DEFAULT_TIMEOUT_S = 20.0
DEFAULT_MAX_RETRIES = 4
DEFAULT_LIST_PAGE_SIZE = 60


# ============================================================================
# Throttling
# ============================================================================


class _Throttle:
    """Single-instance rate limiter. Thread-safe in case the CLI ever
    parallelizes evaluate calls during digest pass 2."""

    def __init__(self, rps: float) -> None:
        self._min_interval = 1.0 / rps if rps > 0 else 0.0
        self._lock = threading.Lock()
        self._last_at: float = 0.0

    def wait(self) -> None:
        if self._min_interval <= 0:
            return
        with self._lock:
            now = time.monotonic()
            delta = now - self._last_at
            if delta < self._min_interval:
                time.sleep(self._min_interval - delta)
            self._last_at = time.monotonic()


# ============================================================================
# Errors
# ============================================================================


class SrealityError(Exception):
    """Base class for client errors."""


class ListingNotFound(SrealityError):
    """Detail endpoint returned 404 - listing removed or never existed."""


class RateLimited(SrealityError):
    """API returned 429 after all retries exhausted."""


class UpstreamUnavailable(SrealityError):
    """API returned 5xx after all retries exhausted."""


# ============================================================================
# Client
# ============================================================================


class SrealityClient:
    """Polite HTTP client for the sreality.cz read-only API.

    Always use as a context manager (or call `.close()`) so the underlying
    httpx connection pool is released.
    """

    def __init__(
        self,
        *,
        rate_limit_rps: float = DEFAULT_RATE_LIMIT_RPS,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        max_retries: int = DEFAULT_MAX_RETRIES,
        user_agent: str = DEFAULT_USER_AGENT,
    ) -> None:
        self._throttle = _Throttle(rate_limit_rps)
        self._max_retries = max_retries
        self._client = httpx.Client(
            base_url=API_BASE,
            timeout=timeout_s,
            headers={"User-Agent": user_agent, "Accept": "application/json"},
            follow_redirects=False,
        )

    def __enter__(self) -> "SrealityClient":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        self._client.close()

    # --- Public requests ---------------------------------------------------

    def list_estates(self, params: dict[str, str | int]) -> ListResponse:
        """One page of listing summaries. Caller drives pagination."""
        payload = self._get_json("/estates/search", params=params)
        return ListResponse.parse_api(payload)

    def get_detail(self, hash_id: int) -> ListingDetail:
        """Full detail payload for one listing. Raises `ListingNotFound` on 404."""
        return ListingDetail.model_validate(self.get_detail_raw(hash_id))

    def get_detail_raw(self, hash_id: int) -> dict[str, Any]:
        """Return the unwrapped `result` object (used by slim_detail).

        The v1 detail endpoint wraps the listing in `{result, status_code,
        status_message}`; callers only ever want `result`.
        """
        payload = self._get_json(f"/estates/{hash_id}", params={})
        result = payload.get("result")
        if not isinstance(result, dict):
            raise SrealityError(
                f"detail response for {hash_id} missing `result` object"
            )
        return result

    def iter_search(
        self,
        params: dict[str, str | int],
        *,
        max_listings: int,
        page_size: int = DEFAULT_LIST_PAGE_SIZE,
    ) -> Iterator[ListingSummary]:
        """Walk pages of `list_estates`, yielding up to `max_listings`.

        Caller-supplied params are merged with `limit`/`offset` pagination;
        the caller should not set those themselves.
        """
        offset = 0
        emitted = 0
        while emitted < max_listings:
            limit = min(page_size, max_listings - emitted)
            q = {**params, "limit": limit, "offset": offset}
            resp = self.list_estates(q)
            if not resp.results:
                return
            for est in resp.results:
                yield est
                emitted += 1
                if emitted >= max_listings:
                    return
            offset += len(resp.results)
            # Stop if we've walked the whole result set.
            if offset >= resp.total:
                return

    # --- Internals ---------------------------------------------------------

    def _get_json(self, path: str, *, params: dict[str, str | int]) -> dict[str, Any]:
        # Track the last failure mode across retries so we can surface the
        # right exception type after exhausting attempts. Only one of
        # `last_exc` / `last_status` is meaningful (whichever the final
        # attempt produced).
        last_exc: Exception | None = None
        last_status: int | None = None
        for attempt in range(self._max_retries + 1):
            self._throttle.wait()
            try:
                r = self._client.get(path, params=params)
            except httpx.HTTPError as e:
                last_exc = e
                last_status = None
                # Don't sleep on the final attempt - we're about to raise.
                if attempt >= self._max_retries:
                    break
                backoff = _backoff_seconds(attempt)
                log.warning("transport error on %s (attempt %d): %s; sleeping %.1fs",
                            path, attempt + 1, e, backoff)
                time.sleep(backoff)
                continue

            if r.status_code == 200:
                return r.json()
            # 404 = never existed; 410 = removed since first seen. Both mean
            # "detail is unfetchable"; the caller (digest, evaluate) should
            # skip or mark the snapshot inactive rather than abort.
            if r.status_code in (404, 410) and _DETAIL_PATH_RE.match(path):
                raise ListingNotFound(
                    f"sreality returned {r.status_code} for {path}"
                )
            if r.status_code in (429, 500, 502, 503, 504):
                last_status = r.status_code
                last_exc = None
                if attempt >= self._max_retries:
                    break
                backoff = _retry_after(r) or _backoff_seconds(attempt)
                log.warning("retryable %d on %s (attempt %d); sleeping %.1fs",
                            r.status_code, path, attempt + 1, backoff)
                time.sleep(backoff)
                continue
            # Non-retryable
            raise SrealityError(
                f"sreality returned {r.status_code} for {path}: {r.text[:200]}"
            )

        # Retries exhausted. Pick the right exception based on the final
        # attempt's failure mode.
        attempts = self._max_retries + 1
        if last_status == 429:
            raise RateLimited(
                f"sreality returned 429 after {attempts} attempts for {path}"
            )
        if last_status is not None:
            raise UpstreamUnavailable(
                f"sreality returned {last_status} after {attempts} attempts for {path}"
            )
        # Transport-level failure (no HTTP response). `last_exc` is set by
        # construction: if every attempt either succeeded or hit an HTTP
        # status path above, we wouldn't have left the loop without
        # returning or raising.
        assert last_exc is not None
        raise SrealityError(f"transport failure after retries: {last_exc}") from last_exc


def _backoff_seconds(attempt: int) -> float:
    # 1, 2, 4, 8, ... capped at 30s
    return min(30.0, 2.0**attempt)


# Cap absurd Retry-After values to avoid hanging a digest for hours on a
# misconfigured upstream. 60s is generous; the caller can still hit it
# repeatedly via retries if the server really means it.
_RETRY_AFTER_CAP_S = 60.0


def _retry_after(r: httpx.Response) -> float | None:
    """Honor a Retry-After header if present and a sane numeric value.

    Only the seconds form is accepted (HTTP-date form is ignored). Negative
    or non-numeric values fall back to exponential backoff. Values above
    `_RETRY_AFTER_CAP_S` are clamped down.
    """
    val = r.headers.get("Retry-After")
    if not val:
        return None
    try:
        secs = float(val)
    except ValueError:
        return None
    if secs <= 0:
        return None
    return min(secs, _RETRY_AFTER_CAP_S)


# ============================================================================
# URL building
# ============================================================================


def build_locality_slug(loc: Locality) -> str:
    """Build the locality slug segment of a public detail URL.

    The v1 API has no single pre-built locality slug (the v2 `seo.locality`
    is gone), so we assemble one from the locality's seo components. The
    exact value barely matters: sreality.cz 301-redirects any slug to the
    canonical URL for the hash_id, so this only needs to be non-empty and
    reasonable. Falls back to "x" when no component is available.
    """
    # Prefer citypart over quarter: for Prague the quarter_seo_name repeats the
    # city ("praha-zbraslav"), while citypart ("zbraslav") yields the canonical
    # "praha-zbraslav-lesaku" slug.
    area = loc.citypart_seo_name or loc.quarter_seo_name
    parts: list[str] = []
    for seg in (loc.city_seo_name, area, loc.street_seo_name or loc.ward_seo_name):
        if seg and seg not in parts:
            parts.append(seg)
    return "-".join(parts) if parts else "x"


def build_listing_url(
    *,
    category_type_cb: int,
    category_main_cb: int,
    category_sub_cb: int,
    locality_slug: str,
    hash_id: int,
) -> str:
    """Construct the public detail URL.

    Pattern: /detail/<type>/<main>/<sub>/<locality-slug>/<hash_id>. sreality.cz
    301-redirects a wrong locality slug to canonical, so the slug only needs to
    be plausible. Unknown category codes degrade to a numeric slug.
    """
    type_slug = codebooks.slug_or_numeric(
        codebooks.CATEGORY_TYPE, category_type_cb, "category_type_cb",
    )
    main_slug = codebooks.slug_or_numeric(
        codebooks.CATEGORY_MAIN, category_main_cb, "category_main_cb",
    )
    sub_slug = codebooks.slug_or_numeric(
        _sub_table_for_main(category_main_cb), category_sub_cb,
        f"category_sub_cb (main={category_main_cb})",
    )
    return f"{PUBLIC_BASE}/{type_slug}/{main_slug}/{sub_slug}/{locality_slug}/{hash_id}"


def _sub_table_for_main(category_main_cb: int) -> dict[int, tuple[str, str]]:
    if category_main_cb == 1:
        return codebooks.APT_DISPOSITION
    if category_main_cb == 2:
        return codebooks.HOUSE_TYPE
    # land/commercial/other not supported yet
    return {}


# ============================================================================
# Query building from SavedSearch
# ============================================================================


def build_search_params(search: SavedSearch) -> list[dict[str, str | int]]:
    """Translate `SavedSearch.filters` into one API param dict per category.

    `category: [apt, house]` produces two queries; the caller paginates each
    and unions results in memory.

    Hard-severity must-haves are also pushed to the API where the API has a
    matching filter; soft ones are post-fetch only (handled in facts.py).
    """
    filters = search.filters
    common: dict[str, str | int] = {
        "category_type_cb": codebooks.CATEGORY_TYPE_BY_NAME[filters.transaction],
    }

    # Newest-first so a capped digest walks the most recent listings. The v1
    # API supports this; v2 never did (we used to rely solely on DB dedup).
    common["sort"] = "-date"

    if filters.location.district_ids:
        common["locality_district_id"] = _comma_join(filters.location.district_ids)
    if filters.location.region_ids:
        common["locality_region_id"] = _comma_join(filters.location.region_ids)

    # v1 uses `<field>_from` / `<field>_to` for ranges (pipe ranges are gone).
    if filters.price_min:
        common["price_from"] = filters.price_min
    if filters.price_max:
        common["price_to"] = filters.price_max

    if filters.area_min:
        common["usable_area_from"] = filters.area_min
    if filters.area_max:
        common["usable_area_to"] = filters.area_max

    # Push hard must-haves to the API where possible (cheap pre-filter).
    common.update(_hard_must_haves_to_params(search))

    queries: list[dict[str, str | int]] = []
    for cat_name in filters.category:
        q = dict(common)
        q["category_main_cb"] = codebooks.CATEGORY_MAIN_BY_NAME[cat_name]
        if cat_name == "apt" and filters.apt_dispositions:
            q["category_sub_cb"] = _comma_join(
                codebooks.APT_DISPOSITION_BY_NAME[d] for d in filters.apt_dispositions
            )
        elif cat_name == "house" and filters.house_types:
            q["category_sub_cb"] = _comma_join(
                codebooks.HOUSE_TYPE_BY_NAME[t] for t in filters.house_types
            )
        queries.append(q)
    return queries


# Subset of must-have checks the API has a native filter for. Soft variants
# of the same checks are not pushed (we still want near-miss listings to be
# fetched and surfaced). v1 param names drop the `_cb` suffix these had in v2.
_HARD_MUST_HAVE_API_KEYS: dict[str, str] = {
    "balcony":  "balcony",
    "terrace":  "terrace",
    "loggia":   "loggia",
    "cellar":   "cellar",
    "garage":   "garage",
    "parking":  "parking_lots",
    "elevator": "elevator",
}


def _hard_must_haves_to_params(search: SavedSearch) -> dict[str, str | int]:
    out: dict[str, str | int] = {}
    for mh in search.must_haves:
        if mh.severity != "hard":
            continue
        if mh.check in _HARD_MUST_HAVE_API_KEYS and mh.value is True:
            out[_HARD_MUST_HAVE_API_KEYS[mh.check]] = 1
        elif mh.check == "ownership" and isinstance(mh.value, str):
            # osobni=1 / druzstevni=2 verified for v1; statni/jine are
            # best-effort and re-checked post-fetch regardless.
            out["ownership"] = codebooks.OWNERSHIP_BY_NAME[mh.value]
        # building_type(_not), building_condition, energy_class_max, floor_*,
        # images_min, description_min: no clean 1:1 API filter we trust
        # (codes diverged / "max" semantics); let facts.py handle post-fetch.
    return out


def _comma_join(values: Iterable[Any]) -> str:
    """v1 multi-value encoding (e.g. `locality_district_id=5005,5006`).

    v2 used pipe-joining; v1 rejects that (HTTP 422/500).
    """
    return ",".join(str(v) for v in values)


# ============================================================================
# Storage normalization
# ============================================================================


# Fields of the flat `result` object we keep when persisting a snapshot.
# Everything else (premise, rus, user, videos, panorama_data,
# advert_images_all, POI distances, ...) is heavy or unused. This set must
# stay a superset of what `ListingDetail` reads so a stored snapshot re-parses.
_KEEP_DETAIL_FIELDS: frozenset[str] = frozenset({
    "hash_id", "advert_name", "advert_description",
    "category_main_cb", "category_sub_cb", "category_type_cb",
    "usable_area", "floor_number", "floors", "underground_floors",
    "ownership", "building_type", "building_condition",
    "energy_efficiency_rating_cb", "furnished", "elevator", "easy_access",
    "balcony", "terrace", "loggia", "cellar", "garage", "low_energy",
    "basin", "parking",
    "price_czk", "price_summary_czk", "price_czk_m2",
    "locality", "edited", "since", "exclusively_at_rk",
    # advert_images is kept but re-slimmed below (the verbatim copy from the
    # comprehension is overwritten with a trimmed per-image dict).
    "advert_images",
})

# Enforce the "superset of what ListingDetail reads" invariant at import time:
# a new ListingDetail field that isn't kept here would silently break snapshot
# round-trips (the stored slim JSON wouldn't re-parse).
_missing_keep = set(ListingDetail.model_fields) - _KEEP_DETAIL_FIELDS
assert not _missing_keep, (
    f"_KEEP_DETAIL_FIELDS is missing ListingDetail fields: {_missing_keep}"
)


def slim_detail(raw: dict[str, Any]) -> dict[str, Any]:
    """Strip heavy/optional fields from a detail `result` dict for storage.

    `raw` is the unwrapped `result` object (as returned by
    `SrealityClient.get_detail_raw`). Keeps everything needed to re-render an
    evaluation card, recompute facts/snapshot_hash, and show images, without
    the bulky agency/POI/video/panorama payloads.

    Returns a new dict; does not mutate the input.
    """
    out: dict[str, Any] = {k: v for k, v in raw.items() if k in _KEEP_DETAIL_FIELDS}

    # advert_images carries width/height/id/alt we don't need; keep just the
    # fields the AdvertImage model reads.
    slim_images: list[dict[str, Any]] = []
    for img in raw.get("advert_images") or []:
        slim_images.append({
            "url": img.get("url"),
            "kind": img.get("kind"),
            "order": img.get("order"),
        })
    out["advert_images"] = slim_images

    return out


def snapshot_hash(detail: ListingDetail) -> str:
    """Stable sha256 of normalized fields used to detect material changes.

    Cosmetic churn (POIs, promo flags, agency info, the daily `edited` date)
    is excluded so only material changes mint a new snapshot row.
    """
    norm = {
        "price": detail.price_czk,
        "area": detail.usable_area,
        "title": detail.advert_name,
        "locality": detail.locality.display(),
        "description": detail.advert_description,
        "floor": detail.floor_number,
        "floors": detail.floors,
        "building_condition": (
            detail.building_condition.name if detail.building_condition else None
        ),
        "ownership": detail.ownership.name if detail.ownership else None,
    }
    payload = json.dumps(norm, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
