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

One semantic decision worth knowing about:

  * Missing data fails *presence* checks (`balcony: true`) but passes
    *exclusion* checks (`building_type_not: [panel]`). The reasoning: if
    a listing didn't say it has a balcony, it probably doesn't have one
    worth mentioning; but if a listing didn't say it's panel, you can't
    conclude it is.

The v1 detail endpoint gives amenities as real bools, floors as plain ints,
and codebook fields as {name, value}; this module reads them directly (no
more Czech-string parsing or tri-state collapsing).
"""

import logging
from collections.abc import Callable
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

from . import codebooks
from .api import build_listing_url, build_locality_slug, image_view_url
from .models import AdvertImage, CodeItem, ListingDetail, ListingSummary, MustHave

log = logging.getLogger("sreality_hunt.facts")

# ============================================================================
# Floor display
# ============================================================================


def floor_display(floor_n: int | None, total_floors: int | None) -> str | None:
    """Czech-style floor label from the v1 numeric fields, for the facts table.

    0 -> "Přízemí", negative -> "Suterén", else "N. podlaží[ z celkem M]".
    Returns None when the floor is unknown (so the renderer omits the row).
    """
    if floor_n is None:
        return None
    if floor_n == 0:
        base = "Přízemí"
    elif floor_n < 0:
        base = "Suterén"
    else:
        base = f"{floor_n}. podlaží"
    return f"{base} z celkem {total_floors}" if total_floors else base


# ============================================================================
# Helpers
# ============================================================================


def _yes(item: CodeItem | None) -> bool:
    """True when a tri-state {name, value} field is explicitly "Ano" (value 1).

    Used for `elevator` / `easy_access`, which v1 sends as {name, value}
    (0=nezadáno, 1=Ano, 2=Ne) rather than bools.
    """
    return item is not None and item.value == 1


def _enum_name(item: CodeItem | None, table: dict[str, str]) -> str | None:
    """Map a {name, value} enum to its friendly identifier via a Czech-name
    table. The 0/placeholder option's name isn't in the table, so it maps to
    None naturally."""
    if item is None:
        return None
    return table.get(item.name)


def _image_urls(images: list[AdvertImage]) -> list[str]:
    """Fetchable https URLs for advert images, in gallery order. Skips blanks.

    Each URL carries the CDN transform query; see `api.image_view_url` for
    why (bare CDN URLs 401)."""
    urls: list[str] = []
    for img in images:
        url = image_view_url(img.url)
        if url:
            urls.append(url)
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
    image_urls: list[str] = []  # fetchable CDN URLs; see api.image_view_url
    description: str
    description_length: int
    since: str | None           # v1 `since` ISO date, first published (time-on-market)
    aktualizace: str | None     # v1 `edited` ISO date, e.g. "2026-06-12"
    labels: list[str] = []      # always empty (v1 search summary has no labels)

    # --- Locality (for comparable pricing later) ---
    locality_region_id: int | None
    locality_district_id: int | None


def extract_facts(
    detail: ListingDetail,
    summary: ListingSummary | None = None,
) -> Facts:
    # `summary` is currently unused (the v1 search summary carries no fields
    # the detail lacks); kept in the signature for call-site compatibility.
    _ = summary

    main_cb = detail.category_main_cb.value
    sub_cb = detail.category_sub_cb.value
    type_cb = detail.category_type_cb.value

    floor_n = detail.floor_number
    total_floors = detail.floors

    price = detail.price_czk
    price_hidden = price < PRICE_HIDDEN_THRESHOLD
    area = detail.usable_area
    # Prefer the API's precomputed price/m2; derive only as a fallback.
    if price_hidden:
        price_per_m2 = None
    elif detail.price_czk_m2:
        price_per_m2 = detail.price_czk_m2
    else:
        price_per_m2 = price // area if area else None

    if main_cb == 1:
        sub_slug = codebooks.slug_or_numeric(
            codebooks.APT_DISPOSITION, sub_cb, "category_sub_cb",
        )
    elif main_cb == 2:
        sub_slug = codebooks.slug_or_numeric(
            codebooks.HOUSE_TYPE, sub_cb, "category_sub_cb",
        )
    else:
        sub_slug = str(sub_cb)

    image_urls = _image_urls(detail.advert_images)

    return Facts(
        hash_id=detail.hash_id,
        url=build_listing_url(
            category_type_cb=type_cb,
            category_main_cb=main_cb,
            category_sub_cb=sub_cb,
            locality_slug=build_locality_slug(detail.locality),
            hash_id=detail.hash_id,
        ),
        title=detail.advert_name,
        locality_display=detail.locality.display(),
        lat=detail.locality.gps_lat,
        lon=detail.locality.gps_lon,

        category_main_cb=main_cb,
        category_sub_cb=sub_cb,
        category_type_cb=type_cb,
        category_main=_codebook_name(
            codebooks.CATEGORY_MAIN, main_cb, "category_main_cb",
        ),
        category_type=_codebook_name(
            codebooks.CATEGORY_TYPE, type_cb, "category_type_cb",
        ),
        sub_slug=sub_slug,

        price_czk=price,
        price_hidden=price_hidden,
        price_per_m2=price_per_m2,

        usable_area=area,
        floor_n=floor_n,
        total_floors=total_floors,
        floor_display=floor_display(floor_n, total_floors),

        # ownership / energy use stable integer codes; building_type,
        # building_condition, furnished diverged so are read by Czech name.
        ownership=(
            codebooks.OWNERSHIP.get(detail.ownership.value)
            if detail.ownership and detail.ownership.value else None
        ),
        building_type=_enum_name(detail.building_type, codebooks.BUILDING_TYPE_BY_CZECH),
        building_condition=_enum_name(
            detail.building_condition, codebooks.BUILDING_CONDITION_BY_CZECH
        ),
        energy_class=(
            codebooks.ENERGY_CLASS.get(detail.energy_efficiency_rating_cb.value)
            if detail.energy_efficiency_rating_cb else None
        ),
        furnished=_enum_name(detail.furnished, codebooks.FURNISHED_BY_CZECH) or "unknown",

        balcony=detail.balcony,
        terrace=detail.terrace,
        loggia=detail.loggia,
        cellar=detail.cellar,
        garage=detail.garage,
        elevator=_yes(detail.elevator),
        low_energy=detail.low_energy,
        easy_access=_yes(detail.easy_access),
        basin=detail.basin,
        parking_lots=detail.parking,

        image_count=len(image_urls),
        image_urls=image_urls,
        description=detail.advert_description,
        description_length=len(detail.advert_description),
        since=detail.since,
        aktualizace=detail.edited,
        labels=[],

        locality_region_id=detail.locality.region_id,
        locality_district_id=detail.locality.district_id,
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
