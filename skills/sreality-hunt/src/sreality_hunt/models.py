"""Pydantic models for Sreality API responses and the saved-search YAML schema.

Two groups of models:

  * `ListingSummary`, `ListingDetail`, `RecommendationsData` - API responses.
    We intentionally model only the fields we actually use; everything else
    stays as `dict[str, Any]` inside the model (or is dropped during slimming
    in api.py).

  * `SavedSearch` and friends - the YAML schema users edit. These get strict
    validation so a malformed YAML produces a useful pydantic error.

Loading helpers (`SavedSearch.load`, `SavedSearch.dump`) live here too because
they're the natural home for "user-facing config object".
"""

import os
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from . import codebooks

# ============================================================================
# API response models
# ============================================================================


class GPS(BaseModel):
    """`gps` block on listing summary."""
    lat: float
    lon: float


class SeoSummary(BaseModel):
    """`seo` block on both summary and detail; carries URL slug components."""
    category_main_cb: int
    category_sub_cb: int
    category_type_cb: int
    locality: str  # URL slug, e.g. "klatovy-klatovy-iii-husovo-namesti"


class ListingSummary(BaseModel):
    """One entry from `_embedded.estates[]` in the list endpoint.

    Many fields are present in the API response but unused here; pydantic
    ignores them under the default `extra="ignore"` behavior.
    """
    model_config = ConfigDict(extra="ignore")

    hash_id: int
    name: str
    price: int                  # CZK; 0 or 1 = "Cena v RK" (hidden)
    locality: str               # display string, not the URL slug
    gps: GPS
    seo: SeoSummary
    labels: list[str] = []
    advert_images_count: int = 0
    new: bool = False
    is_topped: bool = False
    is_auction: bool = False


class NameValue(BaseModel):
    """Several detail fields use {name, value} pairs; modeled as one helper."""
    model_config = ConfigDict(extra="ignore")
    name: str
    value: str


class PriceCzk(BaseModel):
    """`price_czk` block. Can come back as `{}` for "Cena v RK" listings;
    we default `value_raw` to 0 so downstream code uses the existing
    `price_hidden` path instead of crashing on a missing field."""
    model_config = ConfigDict(extra="ignore")
    value_raw: int = 0
    value: str | None = None
    name: str | None = None
    unit: str | None = None


class LocalityField(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str | None = None
    value: str
    accuracy: str | None = None  # "address", "street", "ward", ...


class MapField(BaseModel):
    model_config = ConfigDict(extra="ignore")
    lat: float
    lon: float
    zoom: int | None = None


class RecommendationsData(BaseModel):
    """Machine-readable English-keyed dump from the detail endpoint.

    Goldmine for filtering and scoring. Most fields are optional because
    sreality omits unknown values rather than emitting nulls.
    """
    model_config = ConfigDict(extra="ignore")

    hash_id: int
    category_main_cb: int
    category_sub_cb: int
    category_type_cb: int

    usable_area: int | None = None
    room_count_cb: int | None = None

    ownership: int | None = None
    building_type: int | None = None
    building_condition: int | None = None
    energy_efficiency_rating_cb: int | None = None

    # All of these are tri-state ints in the API: 0=no info, 1=yes,
    # 2=uncertain/partial. Don't coerce to bool here - facts.py decides what
    # "yes-ish" means per check.
    balcony: int = 0
    terrace: int = 0
    loggia: int = 0
    cellar: int = 0
    garage: int = 0
    parking_lots: int = 0
    elevator: int = 0
    furnished: int = 0
    low_energy: int = 0
    easy_access: int = 0
    basin: int = 0

    locality_region_id: int | None = None
    locality_district_id: int | None = None
    locality_municipality_id: int | None = None
    locality_quarter_id: int | None = None
    locality_ward_id: int | None = None
    locality_street_id: int | None = None
    locality_gps_lat: float | None = None
    locality_gps_lon: float | None = None

    price_summary_czk: int | None = None


class ListingDetail(BaseModel):
    """Detail endpoint response (`/api/cs/v2/estates/<hash_id>`).

    Heavy nested data (POIs, seller, similar adverts) is intentionally not
    modeled; we keep it as raw dicts (or strip it in `slim_detail`) since we
    only read it occasionally for display.
    """
    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    name: NameValue
    text: NameValue                       # text.value is the description
    price_czk: PriceCzk
    items: list[dict[str, Any]] = []      # Czech-labeled facts list
    recommendations_data: RecommendationsData
    locality: LocalityField
    map: MapField
    seo: SeoSummary
    code_items: dict[str, Any] = Field(default_factory=dict, alias="codeItems")
    embedded: dict[str, Any] = Field(default_factory=dict, alias="_embedded")

    # POI summaries: we keep these as dicts because we mostly forward them
    # to the LLM or to a future geo-enrichment step.
    poi: list[dict[str, Any]] = []
    poi_transport: dict[str, Any] | None = None
    poi_grocery: dict[str, Any] | None = None
    poi_school_kindergarten: dict[str, Any] | None = None
    poi_doctors: dict[str, Any] | None = None
    poi_leisure_time: dict[str, Any] | None = None
    poi_restaurant: dict[str, Any] | None = None

    is_topped: bool = False
    is_topped_today: bool = False
    meta_description: str | None = None


class ListResponse(BaseModel):
    """List endpoint response wrapper."""
    model_config = ConfigDict(extra="ignore")

    result_size: int
    page: int
    per_page: int
    estates: list[ListingSummary]

    @classmethod
    def parse_api(cls, payload: dict[str, Any]) -> "ListResponse":
        """Lift `_embedded.estates` onto the top-level `estates` field."""
        flat = dict(payload)
        flat["estates"] = (payload.get("_embedded") or {}).get("estates", [])
        return cls.model_validate(flat)


# ============================================================================
# Saved-search YAML schema
# ============================================================================
#
# Validation strategy:
#   * Use Literal[...] for closed enums where the value set is small/stable
#     (transaction, category).
#   * Use a custom field_validator against codebooks.*_NAMES for larger enums
#     (apt_dispositions, house_types, ownership, etc.), so codebooks.py is
#     the single source of truth.
#   * `MustHave` does per-check value validation in model_validator, since the
#     accepted value type depends on the check name.


class Location(BaseModel):
    model_config = ConfigDict(extra="forbid")
    region_ids: list[int] = []
    district_ids: list[int] = []

    @model_validator(mode="after")
    def _at_least_one(self) -> "Location":
        if not self.region_ids and not self.district_ids:
            raise ValueError(
                "location must specify at least one of region_ids or district_ids"
            )
        return self


class Filters(BaseModel):
    model_config = ConfigDict(extra="forbid")

    category: list[Literal["apt", "house"]] = ["apt"]
    transaction: Literal["sale", "rent", "auction"] = "sale"
    apt_dispositions: list[str] = []
    house_types: list[str] = []
    location: Location
    price_min: int = Field(0, ge=0)
    price_max: int = Field(0, ge=0)   # 0 = unbounded
    area_min: int = Field(0, ge=0)
    area_max: int = Field(0, ge=0)
    max_listings: int = Field(200, ge=1, le=2000)

    @field_validator("category")
    @classmethod
    def _category_nonempty(cls, v: list[str]) -> list[str]:
        if not v:
            raise ValueError("filters.category must include at least one of: apt, house")
        return v

    @field_validator("apt_dispositions")
    @classmethod
    def _validate_dispositions(cls, v: list[str]) -> list[str]:
        bad = [x for x in v if x not in codebooks.APT_DISPOSITION_NAMES]
        if bad:
            raise ValueError(
                f"unknown apt_dispositions: {bad}; "
                f"allowed: {sorted(codebooks.APT_DISPOSITION_NAMES)}"
            )
        return v

    @field_validator("house_types")
    @classmethod
    def _validate_house_types(cls, v: list[str]) -> list[str]:
        bad = [x for x in v if x not in codebooks.HOUSE_TYPE_NAMES]
        if bad:
            raise ValueError(
                f"unknown house_types: {bad}; "
                f"allowed: {sorted(codebooks.HOUSE_TYPE_NAMES)}"
            )
        return v

    @model_validator(mode="after")
    def _range_sanity(self) -> "Filters":
        if self.price_max and self.price_max < self.price_min:
            raise ValueError("filters.price_max < filters.price_min")
        if self.area_max and self.area_max < self.area_min:
            raise ValueError("filters.area_max < filters.area_min")
        if "apt" not in self.category and self.apt_dispositions:
            raise ValueError("apt_dispositions set but 'apt' not in category")
        if "house" not in self.category and self.house_types:
            raise ValueError("house_types set but 'house' not in category")
        return self


# Per-check value-type rules. (value_type, optional set of allowed strings).
# value_type is checked with isinstance; allowed_values is checked against
# the codebooks where applicable.
#
# Note: building_type and building_condition accept a list of allowed names;
# *_not variants accept a list of disallowed names.
_CHECK_SPECS: dict[str, dict[str, Any]] = {
    "balcony":            {"type": bool},
    "terrace":            {"type": bool},
    "loggia":             {"type": bool},
    "cellar":             {"type": bool},
    "garage":             {"type": bool},
    "parking":            {"type": bool},
    "elevator":           {"type": bool},
    "low_energy":         {"type": bool},
    "easy_access":        {"type": bool},
    # `not_ground_floor` is a flag check - include the entry to enable it.
    # Writing `value: false` makes no sense (the user would simply omit the
    # check), so we reject False at validation time rather than silently
    # ignoring it in the evaluator (the evaluator always enforces floor > 0).
    "not_ground_floor":   {"type": bool, "allowed": {True}},
    "furnished":          {"type": str, "allowed": {"true", "partial", "false", "any"}},
    "ownership":          {"type": str, "allowed_from": "OWNERSHIP_NAMES"},
    "building_type":      {"type": list, "item_type": str, "allowed_from": "BUILDING_TYPE_NAMES"},
    "building_type_not":  {"type": list, "item_type": str, "allowed_from": "BUILDING_TYPE_NAMES"},
    "building_condition": {"type": list, "item_type": str, "allowed_from": "BUILDING_CONDITION_NAMES"},
    "floor_min":          {"type": int, "ge": 0},
    "floor_max":          {"type": int, "ge": 0},
    "energy_class_max":   {"type": str, "allowed_from": "ENERGY_CLASS_NAMES"},
    "images_min":         {"type": int, "ge": 0},
    "description_min":    {"type": int, "ge": 0},
}


def _resolve_allowed(spec_key: str) -> frozenset[str]:
    """Resolve an `allowed_from` name to the actual frozenset in codebooks."""
    return getattr(codebooks, spec_key)


class MustHave(BaseModel):
    model_config = ConfigDict(extra="forbid")

    check: str
    value: Any
    severity: Literal["hard", "soft"] = "soft"

    @model_validator(mode="after")
    def _validate_value(self) -> "MustHave":
        spec = _CHECK_SPECS.get(self.check)
        if spec is None:
            raise ValueError(
                f"unknown must-have check {self.check!r}; "
                f"allowed: {sorted(_CHECK_SPECS)}"
            )

        expected_type = spec["type"]
        # bool is a subclass of int in Python; isinstance(True, int) is True.
        # Guard against that to avoid silently accepting True for floor_min etc.
        if expected_type is int and isinstance(self.value, bool):
            raise ValueError(f"{self.check!r} expects int, got bool")
        if not isinstance(self.value, expected_type):
            raise ValueError(
                f"{self.check!r} expects {expected_type.__name__}, "
                f"got {type(self.value).__name__}"
            )

        if expected_type is list:
            item_type = spec.get("item_type", object)
            for item in self.value:
                if not isinstance(item, item_type):
                    raise ValueError(
                        f"{self.check!r} list items must be {item_type.__name__}"
                    )

        if (lo := spec.get("ge")) is not None and self.value < lo:
            raise ValueError(f"{self.check!r} value must be >= {lo}")

        if (allowed := spec.get("allowed")) is not None and self.value not in allowed:
            raise ValueError(
                f"{self.check!r} value {self.value!r} not in {sorted(allowed)}"
            )

        if (allowed_key := spec.get("allowed_from")) is not None:
            allowed_set = _resolve_allowed(allowed_key)
            values = self.value if isinstance(self.value, list) else [self.value]
            bad = [v for v in values if v not in allowed_set]
            if bad:
                raise ValueError(
                    f"{self.check!r} value(s) {bad} not in {sorted(allowed_set)}"
                )

        return self


class SavedSearch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1)
    description: str = ""
    filters: Filters
    must_haves: list[MustHave] = []
    preferences: str = ""
    learned_preferences: str = ""

    # --- Loading & dumping --------------------------------------------------

    @classmethod
    def load(cls, path: str | os.PathLike[str]) -> "SavedSearch":
        p = Path(path)
        raw = yaml.safe_load(p.read_text()) or {}
        # Default `name` to the filename stem so the YAML can omit it.
        raw.setdefault("name", p.stem)
        return cls.model_validate(raw)

    def dump(self, path: str | os.PathLike[str]) -> None:
        Path(path).write_text(
            yaml.dump(
                self.model_dump(),
                Dumper=_LiteralBlockDumper,
                sort_keys=False,
                allow_unicode=True,
            )
        )


# ============================================================================
# YAML serialization
# ============================================================================


class _LiteralBlockDumper(yaml.SafeDumper):
    """SafeDumper that emits multi-line strings as literal blocks.

    The default safe_dump uses the double-quoted-with-extra-blank-lines
    form for strings containing newlines, which is correct but unreadable.
    Literal-block (`|`) is far friendlier for the `preferences:` and
    `learned_preferences:` fields that humans (and the agent) actually
    read and edit.
    """


def _represent_str(dumper: yaml.SafeDumper, data: str) -> yaml.ScalarNode:
    if "\n" in data:
        # Strip trailing whitespace per line. This is intentionally lossy:
        # YAML's literal-block (`|`) style is sensitive to trailing spaces
        # (they round-trip into the loaded string and can cause subtle
        # mismatches), and the only fields that pass through this dumper as
        # multi-line strings are `preferences:` and `learned_preferences:` -
        # prose where trailing whitespace carries no meaning. If we ever add
        # a field where trailing whitespace is significant, switch that field
        # to a different scalar style or pre-encode it.
        cleaned = "\n".join(line.rstrip() for line in data.split("\n"))
        return dumper.represent_scalar("tag:yaml.org,2002:str", cleaned, style="|")
    return dumper.represent_scalar("tag:yaml.org,2002:str", data)


_LiteralBlockDumper.add_representer(str, _represent_str)


# ============================================================================
# Saved-search directory resolution
# ============================================================================


def searches_dir() -> Path:
    """`$XDG_CONFIG_HOME/sreality-hunt/searches/` (default ~/.config/...)."""
    base = Path(os.environ.get("XDG_CONFIG_HOME") or (Path.home() / ".config"))
    return base / "sreality-hunt" / "searches"


def search_path(name: str) -> Path:
    return searches_dir() / f"{name}.yaml"


def list_search_names() -> list[str]:
    d = searches_dir()
    if not d.exists():
        return []
    return sorted(p.stem for p in d.glob("*.yaml"))
