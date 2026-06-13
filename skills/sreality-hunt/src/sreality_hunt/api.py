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
import threading
import time
from collections.abc import Iterator
from typing import Any

import httpx

from . import codebooks
from .models import ListingDetail, ListingSummary, ListResponse, SavedSearch

# Module-level logger; the CLI configures handlers.
log = logging.getLogger("sreality_hunt.api")


# ============================================================================
# Constants
# ============================================================================

API_BASE = "https://www.sreality.cz/api/cs/v2"
PUBLIC_BASE = "https://www.sreality.cz/detail"

DEFAULT_USER_AGENT = "sreality-hunt/0.1 (+https://github.com/personal-use)"

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
        payload = self._get_json("/estates", params=params)
        return ListResponse.parse_api(payload)

    def get_detail(self, hash_id: int) -> ListingDetail:
        """Full detail payload for one listing. Raises `ListingNotFound` on 404."""
        payload = self._get_json(f"/estates/{hash_id}", params={})
        return ListingDetail.model_validate(payload)

    def get_detail_raw(self, hash_id: int) -> dict[str, Any]:
        """Same as `get_detail` but returns the raw dict (used by slim_detail)."""
        return self._get_json(f"/estates/{hash_id}", params={})

    def iter_search(
        self,
        params: dict[str, str | int],
        *,
        max_listings: int,
        page_size: int = DEFAULT_LIST_PAGE_SIZE,
    ) -> Iterator[ListingSummary]:
        """Walk pages of `list_estates`, yielding up to `max_listings`.

        Caller-supplied params are merged with pagination; the caller should
        not set `page` or `per_page` themselves.
        """
        page = 1
        emitted = 0
        while emitted < max_listings:
            q = {**params, "page": page, "per_page": min(page_size, max_listings - emitted)}
            resp = self.list_estates(q)
            if not resp.estates:
                return
            for est in resp.estates:
                yield est
                emitted += 1
                if emitted >= max_listings:
                    return
            # Stop if we've walked the whole result set.
            if page * resp.per_page >= resp.result_size:
                return
            page += 1

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
            if r.status_code in (404, 410) and path.startswith("/estates/"):
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


def build_listing_url(
    *,
    category_type_cb: int,
    category_main_cb: int,
    category_sub_cb: int,
    locality_slug: str,
    hash_id: int,
) -> str:
    """Construct the public detail URL.

    Pattern verified against live sreality.cz; all four slugs are required or
    we get a 404 (see docs/sreality-api-findings.md). Unknown category codes
    degrade to a numeric slug - the page may 404 but the URL is at least
    constructible and the failure mode is visible.
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

    if filters.location.district_ids:
        common["locality_district_id"] = _pipe_join(filters.location.district_ids)
    if filters.location.region_ids:
        common["locality_region_id"] = _pipe_join(filters.location.region_ids)

    if filters.price_min or filters.price_max:
        lo = filters.price_min
        hi = filters.price_max or 999_999_999
        common["czk_price_summary_order2"] = f"{lo}|{hi}"

    if filters.area_min or filters.area_max:
        lo = filters.area_min
        hi = filters.area_max or 9999
        common["usable_area"] = f"{lo}|{hi}"

    # Push hard must-haves to the API where possible (cheap pre-filter).
    common.update(_hard_must_haves_to_params(search))

    queries: list[dict[str, str | int]] = []
    for cat_name in filters.category:
        q = dict(common)
        q["category_main_cb"] = codebooks.CATEGORY_MAIN_BY_NAME[cat_name]
        if cat_name == "apt" and filters.apt_dispositions:
            q["category_sub_cb"] = _pipe_join(
                codebooks.APT_DISPOSITION_BY_NAME[d] for d in filters.apt_dispositions
            )
        elif cat_name == "house" and filters.house_types:
            q["category_sub_cb"] = _pipe_join(
                codebooks.HOUSE_TYPE_BY_NAME[t] for t in filters.house_types
            )
        queries.append(q)
    return queries


# Subset of must-have checks the API has a native filter for. Soft variants
# of the same checks are not pushed (we still want near-miss listings to be
# fetched and surfaced).
_HARD_MUST_HAVE_API_KEYS: dict[str, str] = {
    "balcony":  "balcony",
    "terrace":  "terrace",
    "loggia":   "loggia",
    "cellar":   "cellar",
    "garage":   "garage",
    "elevator": "elevator_cb",
}


def _hard_must_haves_to_params(search: SavedSearch) -> dict[str, str | int]:
    out: dict[str, str | int] = {}
    for mh in search.must_haves:
        if mh.severity != "hard":
            continue
        if mh.check in _HARD_MUST_HAVE_API_KEYS and mh.value is True:
            out[_HARD_MUST_HAVE_API_KEYS[mh.check]] = 1
        elif mh.check == "ownership" and isinstance(mh.value, str):
            out["ownership_cb"] = codebooks.OWNERSHIP_BY_NAME[mh.value]
        elif mh.check == "energy_class_max" and isinstance(mh.value, str):
            # API filter is exact match per class; "max" semantics is enforced
            # post-fetch. Skip pushing to API.
            continue
        # building_type, building_type_not, building_condition, floor_*,
        # images_min, description_min: no clean 1:1 API filter we trust;
        # let facts.py handle them post-fetch.
    return out


def _pipe_join(values: Any) -> str:
    return "|".join(str(v) for v in values)


# ============================================================================
# Storage normalization
# ============================================================================


# Top-level keys we keep when persisting a snapshot. Everything else is
# either redundant, heavy (POIs, seller, similar adverts), or session-specific
# (Retry-After style metadata).
_KEEP_TOP_LEVEL: frozenset[str] = frozenset({
    "name", "text", "price_czk", "items", "recommendations_data",
    "locality", "map", "codeItems", "seo", "meta_description",
    "is_topped", "is_topped_today",
})


def slim_detail(raw: dict[str, Any]) -> dict[str, Any]:
    """Strip heavy/optional sections from a detail response for storage.

    Keeps everything needed to:
      * re-render an evaluation card without re-fetching
      * recompute facts and snapshot_hash
      * extract images for the chat UI

    Drops: poi*, _embedded.seller, _embedded.calculator, _embedded.favourite,
    _embedded.note, _embedded.matterport_url, _links.

    Returns a new dict; does not mutate the input.
    """
    out: dict[str, Any] = {k: v for k, v in raw.items() if k in _KEEP_TOP_LEVEL}

    # _embedded is large mainly because of the seller block; we only need
    # the slimmed image list.
    emb = raw.get("_embedded") or {}
    slim_images: list[dict[str, Any]] = []
    for img in emb.get("images") or []:
        links = img.get("_links") or {}
        slim_images.append({
            "id": img.get("id"),
            "order": img.get("order"),
            "kind": img.get("kind"),
            "view": (links.get("view") or {}).get("href"),
            "full": (links.get("self") or {}).get("href"),
        })
    out["_embedded"] = {"images": slim_images}

    return out


# Fields that participate in change detection. A change in any of these
# triggers a new snapshot row; everything else (POIs, paid promo flags,
# seller info) is considered cosmetic for this purpose.
_HASH_FIELDS = (
    "price",
    "area",
    "title",
    "locality",
    "description",
    "items_signature",
    "building_condition",
    "ownership",
)


def snapshot_hash(detail: ListingDetail) -> str:
    """Stable sha256 of normalized fields used to detect material changes."""
    rd = detail.recommendations_data
    norm = {
        "price": detail.price_czk.value_raw,
        "area": rd.usable_area,
        "title": detail.name.value,
        "locality": detail.locality.value,
        "description": detail.text.value,
        # items[] is Czech-labeled and ordered; serialize a stable signature
        # of (name, value) pairs, skipping volatile entries like "Aktualizace".
        "items_signature": [
            (it.get("name"), _normalize_item_value(it.get("value")))
            for it in detail.items
            if it.get("type") != "edited"  # "Aktualizace: Dnes" changes daily
        ],
        "building_condition": rd.building_condition,
        "ownership": rd.ownership,
    }
    payload = json.dumps(norm, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _normalize_item_value(v: Any) -> Any:
    """Items contain lists, dicts, strings, bools. Make them comparable."""
    if isinstance(v, list):
        return sorted(json.dumps(x, sort_keys=True, ensure_ascii=False) for x in v)
    return v
