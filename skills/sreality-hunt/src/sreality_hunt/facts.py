"""Deterministic fact extraction and must-have evaluation.

Three layers, in order of dependency:

  1. `extract_facts(detail, summary=None) -> Facts`
     Pulls a structured `Facts` object out of a `ListingDetail`. Owns
     codebook translation, floor parsing, price/m² derivation, and image
     counting. No I/O, no LLM.

  2. `evaluate_must_haves(facts, must_haves) -> list[CheckResult]`
     Runs every user-defined `must_have` check against the facts. The check
     dispatch table at the bottom of the file is the spec of which checks
     exist; if you add a new check name in `models._CHECK_SPECS`, you must
     add an evaluator here too.

  3. `classify_results(results) -> (tier, failed_names)`
     Aggregates the per-check results into a single tier
     ('match' | 'near-miss' | 'fail'). Drives digest bucketing.

Two semantic decisions worth knowing about:

  * Tri-state amenity ints (0=no info, 1=yes, 2=uncertain) are collapsed
    to bool via `_is_yes(v) = v >= 1`. "Uncertain" counts as "present"
    because in practice it means the listing acknowledged the feature.

  * Missing data fails *presence* checks (`balcony: true`) but passes
    *exclusion* checks (`building_type_not: [panel]`). The reasoning: if
    a listing didn't say it has a balcony, it probably doesn't have one
    worth mentioning; but if a listing didn't say it's panel, you can't
    conclude it is.
"""

import logging
import re
from collections.abc import Callable
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

from . import codebooks
from .api import build_listing_url
from .models import ListingDetail, ListingSummary, MustHave

log = logging.getLogger("sreality_hunt.facts")

# ============================================================================
# Tri-state interpretation
# ============================================================================


def _is_yes(v: int) -> bool:
    """Collapse a tri-state amenity int (0=no info, 1=yes, 2=uncertain) to bool."""
    return v >= 1


# ============================================================================
# Floor parsing
# ============================================================================
#
# The Czech `items[] -> Podlaží` field has many formats:
#   "3. podlaží z celkem 5"        -> (3, 5)
#   "1. podlaží"                   -> (1, None)
#   "Přízemí" / "Přízemí (...)"    -> (0, None)
#   "Suterén"                      -> (-1, None)
#   "Mezonet"                      -> (None, None)  - can't reduce to a single floor
#
# `parse_floor` is exported so the renderer can format the original Czech
# string but consumers needing a numeric comparison go through us.


# The trailing dot after the number and the whitespace between the number and
# the unit are both optional - real listings have all of "3. NP", "3 NP",
# "3NP", "3.podlaží".
_FLOOR_RE = re.compile(
    r"(\d+)\.?\s*(?:podlaží|np|patro)"
    r"(?:\s*z\s*celkem\s*(\d+))?",
    re.IGNORECASE,
)


def parse_floor(value: str | None) -> tuple[int | None, int | None]:
    if not value:
        return None, None
    s = value.lower().strip()
    if "přízem" in s or "prizem" in s:
        return 0, None
    if "suter" in s:  # "Suterén"
        return -1, None
    m = _FLOOR_RE.search(s)
    if m:
        return int(m.group(1)), (int(m.group(2)) if m.group(2) else None)
    return None, None


# ============================================================================
# Item lookup
# ============================================================================


def _find_item(items: list[dict[str, Any]], name: str) -> Any:
    """Return `value` of the first items[] entry with matching `name`."""
    for it in items:
        if it.get("name") == name:
            return it.get("value")
    return None


def _extract_image_urls(embedded: dict[str, Any]) -> list[str]:
    """Extract preview-size image URLs from a detail's `_embedded.images`.

    Handles both the raw API form (`img._links.view.href`) and the
    `api.slim_detail` form (`img.view`). The slim form is what the
    snapshots table stores; the raw form is what `SrealityClient.get_detail`
    returns. Listings without a usable URL are silently skipped.
    """
    urls: list[str] = []
    for img in embedded.get("images") or []:
        # Slim form (post-`slim_detail`)
        view = img.get("view")
        if isinstance(view, str) and view:
            urls.append(view)
            continue
        # Raw form
        links = img.get("_links") or {}
        raw_view = links.get("view") or {}
        href = raw_view.get("href") if isinstance(raw_view, dict) else None
        if isinstance(href, str) and href:
            urls.append(href)
    return urls


def _codebook_name(
    table: dict[int, tuple[str, str]], code: int, what: str,
) -> str:
    """Resolve a code to its display name; warn and fall back if unknown.

    Used for `category_main` and `category_type`. Sreality has added new
    category codes in the past; we'd rather emit
    `unknown_category_main_99` (the `what` argument minus any `_cb`
    suffix, plus the numeric code) and a log warning than crash the whole
    digest with a `KeyError`.
    """
    entry = table.get(code)
    if entry is not None:
        return entry[1]
    log.warning("unknown %s=%d; using fallback name", what, code)
    return f"unknown_{what.removesuffix('_cb')}_{code}"



# ============================================================================
# Facts
# ============================================================================


# Below this CZK threshold, treat the price as "Cena v RK" (hidden).
PRICE_HIDDEN_THRESHOLD = 100_000


class Facts(BaseModel):
    """Deterministic facts extracted from a `ListingDetail`.

    All optional-in-the-API fields are `Optional` here; consumers decide
    what to do with missing values (see module docstring).
    """
    model_config = ConfigDict(extra="forbid")

    # --- Identity / link ---
    hash_id: int
    url: str
    title: str
    locality_display: str
    lat: float | None = None
    lon: float | None = None

    # --- Category (codes + codebook names; both are needed downstream) ---
    category_main_cb: int       # 1=apt, 2=house, ... (used by API queries)
    category_sub_cb: int        # disposition / house subtype code
    category_type_cb: int       # 1=sale, 2=rent, 3=auction
    category_main: str          # "apt" | "house" | ...
    category_type: str          # "sale" | "rent" | "auction"
    sub_slug: str               # "3+1" / "rodinny" / ...

    # --- Money ---
    price_czk: int              # raw from API; can be 0/1 for "Cena v RK"
    price_hidden: bool
    price_per_m2: int | None    # None if hidden or area unknown

    # --- Size / structure ---
    usable_area: int | None
    floor_n: int | None
    total_floors: int | None
    floor_display: str | None   # the raw Czech string from items[] Podlaží

    # --- Categorical attributes (codebook names; None if absent) ---
    ownership: str | None
    building_type: str | None
    building_condition: str | None
    energy_class: str | None    # "A" .. "G"
    furnished: str              # "unknown" | "true" | "partial" | "false"

    # --- Amenities (tri-state collapsed) ---
    balcony: bool
    terrace: bool
    loggia: bool
    cellar: bool
    garage: bool
    elevator: bool
    low_energy: bool
    easy_access: bool
    basin: bool
    parking_lots: int

    # --- Description / media ---
    image_count: int
    image_urls: list[str] = []  # preview-size (~749x562); see _extract_image_urls
    description: str
    description_length: int
    aktualizace: str | None     # "Dnes" / "3 dny" / "8.4.2025"
    labels: list[str] = []      # from list-endpoint summary; empty otherwise

    # --- Locality (for comparable pricing later) ---
    locality_region_id: int | None
    locality_district_id: int | None


def extract_facts(
    detail: ListingDetail,
    summary: ListingSummary | None = None,
) -> Facts:
    rd = detail.recommendations_data

    floor_display = _find_item(detail.items, "Podlaží")
    floor_n, total_floors = parse_floor(floor_display)

    price = detail.price_czk.value_raw
    price_hidden = price < PRICE_HIDDEN_THRESHOLD
    area = rd.usable_area
    price_per_m2 = None if (price_hidden or not area) else price // area

    # When category_main_cb is unknown we have no sub-table to consult.
    # Skip the lookup (and its warning) entirely - `_codebook_name` above
    # already warned about the unknown main code, so warning again here
    # would just create misleading noise blaming the sub code.
    if rd.category_main_cb == 1:
        sub_slug = codebooks.slug_or_numeric(
            codebooks.APT_DISPOSITION, rd.category_sub_cb, "category_sub_cb",
        )
    elif rd.category_main_cb == 2:
        sub_slug = codebooks.slug_or_numeric(
            codebooks.HOUSE_TYPE, rd.category_sub_cb, "category_sub_cb",
        )
    else:
        sub_slug = str(rd.category_sub_cb)

    image_urls = _extract_image_urls(detail.embedded)

    return Facts(
        hash_id=rd.hash_id,
        url=build_listing_url(
            category_type_cb=rd.category_type_cb,
            category_main_cb=rd.category_main_cb,
            category_sub_cb=rd.category_sub_cb,
            locality_slug=detail.seo.locality,
            hash_id=rd.hash_id,
        ),
        title=detail.name.value,
        locality_display=detail.locality.value,
        lat=detail.map.lat,
        lon=detail.map.lon,

        category_main_cb=rd.category_main_cb,
        category_sub_cb=rd.category_sub_cb,
        category_type_cb=rd.category_type_cb,
        category_main=_codebook_name(
            codebooks.CATEGORY_MAIN, rd.category_main_cb, "category_main_cb",
        ),
        category_type=_codebook_name(
            codebooks.CATEGORY_TYPE, rd.category_type_cb, "category_type_cb",
        ),
        sub_slug=sub_slug,

        price_czk=price,
        price_hidden=price_hidden,
        price_per_m2=price_per_m2,

        usable_area=area,
        floor_n=floor_n,
        total_floors=total_floors,
        floor_display=floor_display,

        ownership=codebooks.OWNERSHIP.get(rd.ownership) if rd.ownership else None,
        building_type=(
            codebooks.BUILDING_TYPE.get(rd.building_type) if rd.building_type else None
        ),
        building_condition=(
            codebooks.BUILDING_CONDITION.get(rd.building_condition)
            if rd.building_condition else None
        ),
        energy_class=(
            codebooks.ENERGY_CLASS.get(rd.energy_efficiency_rating_cb)
            if rd.energy_efficiency_rating_cb else None
        ),
        furnished=codebooks.FURNISHED.get(rd.furnished, "unknown"),

        balcony=_is_yes(rd.balcony),
        terrace=_is_yes(rd.terrace),
        loggia=_is_yes(rd.loggia),
        cellar=_is_yes(rd.cellar),
        garage=_is_yes(rd.garage),
        elevator=_is_yes(rd.elevator),
        low_energy=_is_yes(rd.low_energy),
        easy_access=_is_yes(rd.easy_access),
        basin=_is_yes(rd.basin),
        parking_lots=rd.parking_lots,

        image_count=len(image_urls),
        image_urls=image_urls,
        description=detail.text.value,
        description_length=len(detail.text.value),
        aktualizace=_find_item(detail.items, "Aktualizace"),
        labels=list(summary.labels) if summary else [],

        locality_region_id=rd.locality_region_id,
        locality_district_id=rd.locality_district_id,
    )


# ============================================================================
# Must-have evaluation
# ============================================================================


Tier = Literal["match", "near-miss", "fail"]


class CheckResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    check: str          # `MustHave.check`
    severity: str       # "hard" | "soft"
    passed: bool
    reason: str | None  # filled when failed; e.g. "elevator=no (wanted yes)"


# --- Per-check evaluators ---------------------------------------------------
# Each returns (passed, failure_reason). All take `(facts, value)` so the
# dispatch table can stay uniform; some evaluators ignore `value` (e.g.
# not_ground_floor always means "must be > 0" regardless of the YAML value).


def _bool_match(have: bool, want: bool, name: str) -> tuple[bool, str | None]:
    if have == want:
        return True, None
    return False, f"{name}={'yes' if have else 'no'} (wanted {'yes' if want else 'no'})"


def _check_amenity(attr: str) -> Callable[[Facts, bool], tuple[bool, str | None]]:
    """Build an evaluator that compares `facts.<attr>` to a desired bool."""
    def _fn(facts: Facts, want: bool) -> tuple[bool, str | None]:
        return _bool_match(getattr(facts, attr), want, attr)
    return _fn


def _check_parking(facts: Facts, want: bool) -> tuple[bool, str | None]:
    have = facts.parking_lots > 0
    if have == want:
        return True, None
    return False, f"parking_lots={facts.parking_lots} (wanted {'>0' if want else '0'})"


def _check_furnished(facts: Facts, want: str) -> tuple[bool, str | None]:
    if want == "any":
        ok = facts.furnished in {"true", "partial"}
        return ok, (None if ok else f"furnished={facts.furnished}")
    if facts.furnished == want:
        return True, None
    return False, f"furnished={facts.furnished} (wanted {want})"


def _check_ownership(facts: Facts, want: str) -> tuple[bool, str | None]:
    if facts.ownership == want:
        return True, None
    return False, f"ownership={facts.ownership or 'unknown'} (wanted {want})"


def _check_building_type(facts: Facts, allowed: list[str]) -> tuple[bool, str | None]:
    if facts.building_type is None:
        return False, "building_type=unknown"
    if facts.building_type in allowed:
        return True, None
    return False, f"building_type={facts.building_type} (allowed {allowed})"


def _check_building_type_not(facts: Facts, forbidden: list[str]) -> tuple[bool, str | None]:
    # Exclusion check: unknown passes (no evidence of forbidden type).
    if facts.building_type is None:
        return True, None
    if facts.building_type in forbidden:
        return False, f"building_type={facts.building_type} (forbidden)"
    return True, None


def _check_building_condition(facts: Facts, allowed: list[str]) -> tuple[bool, str | None]:
    if facts.building_condition is None:
        return False, "building_condition=unknown"
    if facts.building_condition in allowed:
        return True, None
    return False, f"building_condition={facts.building_condition} (allowed {allowed})"


def _check_floor_min(facts: Facts, lo: int) -> tuple[bool, str | None]:
    if facts.floor_n is None:
        return False, "floor=unknown"
    if facts.floor_n >= lo:
        return True, None
    return False, f"floor={facts.floor_n} (wanted >= {lo})"


def _check_floor_max(facts: Facts, hi: int) -> tuple[bool, str | None]:
    if facts.floor_n is None:
        return False, "floor=unknown"
    if facts.floor_n <= hi:
        return True, None
    return False, f"floor={facts.floor_n} (wanted <= {hi})"


def _check_not_ground_floor(facts: Facts, _v: bool) -> tuple[bool, str | None]:
    # _v is always True by validation; included to match dispatch signature.
    if facts.floor_n is None:
        return False, "floor=unknown"
    if facts.floor_n > 0:
        return True, None
    return False, f"floor={facts.floor_n} (ground floor or below)"


_ENERGY_ORDER = "ABCDEFG"


def _check_energy_class_max(facts: Facts, max_class: str) -> tuple[bool, str | None]:
    if facts.energy_class is None:
        return False, "energy_class=unknown"
    if _ENERGY_ORDER.index(facts.energy_class) <= _ENERGY_ORDER.index(max_class):
        return True, None
    return False, f"energy_class={facts.energy_class} (wanted <= {max_class})"


def _check_images_min(facts: Facts, n: int) -> tuple[bool, str | None]:
    if facts.image_count >= n:
        return True, None
    return False, f"image_count={facts.image_count} (wanted >= {n})"


def _check_description_min(facts: Facts, n: int) -> tuple[bool, str | None]:
    if facts.description_length >= n:
        return True, None
    return False, f"description_length={facts.description_length} (wanted >= {n})"


# --- Dispatch table --------------------------------------------------------
# Keep this in sync with `models._CHECK_SPECS`. The set of keys here is what
# `evaluate_must_have` accepts; anything else raises.


_CheckFn = Callable[[Facts, Any], tuple[bool, str | None]]

_DISPATCH: dict[str, _CheckFn] = {
    "balcony":            _check_amenity("balcony"),
    "terrace":            _check_amenity("terrace"),
    "loggia":             _check_amenity("loggia"),
    "cellar":             _check_amenity("cellar"),
    "garage":             _check_amenity("garage"),
    "elevator":           _check_amenity("elevator"),
    "low_energy":         _check_amenity("low_energy"),
    "easy_access":        _check_amenity("easy_access"),
    "parking":            _check_parking,
    "furnished":          _check_furnished,
    "ownership":          _check_ownership,
    "building_type":      _check_building_type,
    "building_type_not":  _check_building_type_not,
    "building_condition": _check_building_condition,
    "floor_min":          _check_floor_min,
    "floor_max":          _check_floor_max,
    "not_ground_floor":   _check_not_ground_floor,
    "energy_class_max":   _check_energy_class_max,
    "images_min":         _check_images_min,
    "description_min":    _check_description_min,
}


def evaluate_must_have(facts: Facts, must_have: MustHave) -> CheckResult:
    fn = _DISPATCH.get(must_have.check)
    if fn is None:
        # models._CHECK_SPECS should have caught this at YAML load time.
        raise ValueError(f"no evaluator for check {must_have.check!r}")
    passed, reason = fn(facts, must_have.value)
    return CheckResult(
        check=must_have.check,
        severity=must_have.severity,
        passed=passed,
        reason=reason,
    )


def evaluate_must_haves(facts: Facts, must_haves: list[MustHave]) -> list[CheckResult]:
    return [evaluate_must_have(facts, mh) for mh in must_haves]


# ============================================================================
# Tier classification
# ============================================================================


def classify_results(results: list[CheckResult]) -> tuple[Tier, list[str]]:
    """Aggregate per-check results into a tier + list of failed check names.

    tier:
      'fail'      - any hard severity check failed
      'near-miss' - all hard passed, some soft failed
      'match'     - everything passed (or no checks were configured)
    """
    failed = [r for r in results if not r.passed]
    hard_failed = [r for r in failed if r.severity == "hard"]
    if hard_failed:
        return "fail", [r.check for r in hard_failed]
    if failed:
        return "near-miss", [r.check for r in failed]
    return "match", []
