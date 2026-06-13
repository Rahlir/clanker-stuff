"""Codebook mappings for the Sreality API.

Every dict here is one direction: code -> (url_slug, display_name). Reverse
lookup helpers are at the bottom. See docs/sreality-api-findings.md for how
these values were derived and verified.

Update this module - not the API client - when you encounter a new sub
category or label string.
"""

import logging

log = logging.getLogger("sreality_hunt.codebooks")


# --- Top-level categories ---------------------------------------------------

# code -> (url_slug, canonical_name). The canonical_name is what users write
# in YAML and what we use as the reverse-lookup key; pick something short and
# unambiguous. Pretty display strings ("apartment", "sale") live in render.py.
CATEGORY_MAIN: dict[int, tuple[str, str]] = {
    1: ("byt",      "apt"),
    2: ("dum",      "house"),
    3: ("pozemek",  "land"),
    4: ("komercni", "commercial"),
    5: ("ostatni",  "other"),
}

CATEGORY_TYPE: dict[int, tuple[str, str]] = {
    1: ("prodej",   "sale"),
    2: ("pronajem", "rent"),
    3: ("drazba",   "auction"),
}

# --- Sub-categories ---------------------------------------------------------

# Apartment dispositions. Verified by probe 2026-05-17.
APT_DISPOSITION: dict[int, tuple[str, str]] = {
    2:  ("1+kk",     "1+kk"),
    3:  ("1+1",      "1+1"),
    4:  ("2+kk",     "2+kk"),
    5:  ("2+1",      "2+1"),
    6:  ("3+kk",     "3+kk"),
    7:  ("3+1",      "3+1"),
    8:  ("4+kk",     "4+kk"),
    9:  ("4+1",      "4+1"),
    10: ("5+kk",     "5+kk"),
    11: ("5+1",      "5+1"),
    12: ("6-a-vice", "6+"),
    16: ("atypicky", "atypical"),
}

# House types. Verified for codes 33/37/39/43/44/54; others (47=heritage)
# inferred from the sreality web UI but not yet observed in probes.
HOUSE_TYPE: dict[int, tuple[str, str]] = {
    33: ("chata",               "cottage"),
    37: ("rodinny",             "family"),
    39: ("vila",                "villa"),
    43: ("chalupa",             "chalet"),
    44: ("zemedelska-usedlost", "agricultural"),
    47: ("pamatka",             "heritage"),
    54: ("vicegeneracni-dum",   "multigenerational"),
}

# --- Detail-only enums ------------------------------------------------------

# `recommendations_data.ownership` and `codeItems.ownership`
OWNERSHIP: dict[int, str] = {
    1: "osobni",
    2: "druzstevni",
    3: "statni",
    4: "jine",
}

# `recommendations_data.building_type`. Values 1, 2 confirmed in probes;
# others inferred from sreality web UI.
BUILDING_TYPE: dict[int, str] = {
    1: "cihla",
    2: "panel",
    3: "ostatni",
    4: "montovana",
    5: "skeletova",
    6: "kamenna",
    7: "smisena",
    8: "drevostavba",
    9: "nezadano",
}

# `recommendations_data.building_condition`. Empirical mapping; codes 7 and 9
# both appeared as "Po rekonstrukci" in the wild. For display use the Czech
# string from `items[]` Stav objektu; this map is for filtering only.
BUILDING_CONDITION: dict[int, str] = {
    1:  "ve_vystavbe",
    2:  "novostavba",
    3:  "velmi_dobry",
    4:  "dobry",
    5:  "v_rekonstrukci",
    6:  "pred_rekonstrukci",
    7:  "po_rekonstrukci",
    8:  "spatny",
    9:  "po_rekonstrukci",
    10: "projekt",
}

# `recommendations_data.energy_efficiency_rating_cb`
ENERGY_CLASS: dict[int, str] = {
    1: "A",
    2: "B",
    3: "C",
    4: "D",
    5: "E",
    6: "F",
    7: "G",
}

# `recommendations_data.furnished`
FURNISHED: dict[int, str] = {
    0: "unknown",
    1: "true",
    2: "partial",
    3: "false",
}

# --- Reverse lookups --------------------------------------------------------
# YAML uses the friendly names ("apt", "house", "3+kk", "family", "sale",
# "osobni", "cihla", "A"); the API and codebooks above use integer codes.
# These helpers translate one direction. The forward direction is just a dict
# lookup, no helper needed.


def _reverse_main(table: dict[int, tuple[str, str]]) -> dict[str, int]:
    """Build {display_name: code} from a (slug, display) table."""
    return {display: code for code, (_slug, display) in table.items()}


CATEGORY_MAIN_BY_NAME: dict[str, int] = _reverse_main(CATEGORY_MAIN)
CATEGORY_TYPE_BY_NAME: dict[str, int] = _reverse_main(CATEGORY_TYPE)
APT_DISPOSITION_BY_NAME: dict[str, int] = _reverse_main(APT_DISPOSITION)
HOUSE_TYPE_BY_NAME: dict[str, int] = _reverse_main(HOUSE_TYPE)
OWNERSHIP_BY_NAME: dict[str, int] = {v: k for k, v in OWNERSHIP.items()}
# building_condition has duplicate values (7 and 9 both po_rekonstrukci);
# the reverse pick is whichever appears last (9), which is what we want when
# filtering since 9 was the value seen in the wild for the test listing.
BUILDING_CONDITION_BY_NAME: dict[str, int] = {v: k for k, v in BUILDING_CONDITION.items()}
BUILDING_TYPE_BY_NAME: dict[str, int] = {v: k for k, v in BUILDING_TYPE.items()}
ENERGY_CLASS_BY_NAME: dict[str, int] = {v: k for k, v in ENERGY_CLASS.items()}


# --- Allowed YAML enums (for validation in models.py) -----------------------

APT_DISPOSITION_NAMES: frozenset[str] = frozenset(APT_DISPOSITION_BY_NAME)
HOUSE_TYPE_NAMES: frozenset[str] = frozenset(HOUSE_TYPE_BY_NAME)
OWNERSHIP_NAMES: frozenset[str] = frozenset(OWNERSHIP_BY_NAME)
BUILDING_TYPE_NAMES: frozenset[str] = frozenset(BUILDING_TYPE_BY_NAME)
BUILDING_CONDITION_NAMES: frozenset[str] = frozenset(BUILDING_CONDITION_BY_NAME)
ENERGY_CLASS_NAMES: frozenset[str] = frozenset(ENERGY_CLASS_BY_NAME)


# --- Shared lookup helper ---------------------------------------------------


def slug_or_numeric(
    table: dict[int, tuple[str, str]], code: int, what: str,
) -> str:
    """Resolve a code to its URL slug; warn and fall back to the numeric code.

    Used by URL builders (api.build_listing_url) and fact extraction
    (facts.extract_facts) for sub-category slugs. Numeric fallback is the
    correct shape for a URL even when the code is unknown - the page may
    still resolve via locality-slug routing.
    """
    entry = table.get(code)
    if entry is not None:
        return entry[0]
    log.warning("unknown %s=%d; using numeric slug", what, code)
    return str(code)
