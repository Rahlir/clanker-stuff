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
#
# IMPORTANT: the `/api/v1` detail endpoint returns these as {name, value}
# objects whose integer `value` codes DIVERGE from the old `/api/cs/v2`
# codebooks. Verified divergences (probe 2026-06-13):
#   * building_type:      v1 2=Cihlová, 5=Panelová, 6=Skeletová, 7=Smíšená
#                         (v2 had 1=cihla, 2=panel, ...)
#   * building_condition: v1 6=Novostavba, 8=Před rekonstrukcí, 9=Po rekonstrukci
#                         (v2 had 2=novostavba, 6=pred_rekonstrukci, ...)
#   * furnished:          v1 1=Ano, 2=Ne, 3=Částečně (v2 had 2=partial, 3=false)
# category_sub_cb, ownership (1/2), and energy codes happen to be unchanged.
#
# Rather than chase shifting integer codes, the diverged enums are read by
# their canonical Czech `name` (which the API always sends). The integer-code
# dicts below are kept ONLY for the enums whose codes are verified stable and
# are still sent to the API as integers (category/type/sub, energy, ownership).

# `ownership.value` - codes 1/2 verified against v1; 3/4 best-effort (rare).
# Still used as an integer when pushing the `ownership` filter to the API.
OWNERSHIP: dict[int, str] = {
    1: "osobni",
    2: "druzstevni",
    3: "statni",
    4: "jine",
}

# `energy_efficiency_rating_cb.value` - codes 1..7 = A..G, verified unchanged
# between v2 and v1.
ENERGY_CLASS: dict[int, str] = {
    1: "A",
    2: "B",
    3: "C",
    4: "D",
    5: "E",
    6: "F",
    7: "G",
}

# Diverged enums, read by Czech display name. Maps the API's `name` string to
# the friendly identifier users write in YAML must-haves. Unknown names fall
# back to None in facts.py (categorical "unknown"). Keys cover every option in
# the sreality filter UI; extend if a new string is observed.
BUILDING_TYPE_BY_CZECH: dict[str, str] = {
    "Cihlová":     "cihla",
    "Panelová":    "panel",
    "Skeletová":   "skeletova",
    "Smíšená":     "smisena",
    "Montovaná":   "montovana",
    "Kamenná":     "kamenna",
    "Dřevostavba": "drevostavba",
    "Ostatní":     "ostatni",
}

BUILDING_CONDITION_BY_CZECH: dict[str, str] = {
    "Novostavba":        "novostavba",
    "Velmi dobrý":       "velmi_dobry",
    "Dobrý":             "dobry",
    "Ve výstavbě":       "ve_vystavbe",
    "Projekt":           "projekt",
    "V rekonstrukci":    "v_rekonstrukci",
    "Před rekonstrukcí": "pred_rekonstrukci",
    "Po rekonstrukci":   "po_rekonstrukci",
    "Špatný":            "spatny",
}

# `furnished.name` -> friendly. The friendly set matches the YAML enum used
# by the `furnished` must-have check ({true, partial, false}); value 0 / an
# unknown name maps to "unknown".
FURNISHED_BY_CZECH: dict[str, str] = {
    "Ano":      "true",
    "Ne":       "false",
    "Částečně": "partial",
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
# osobni=1 / druzstevni=2 verified for the `ownership` API filter push.
OWNERSHIP_BY_NAME: dict[str, int] = {v: k for k, v in OWNERSHIP.items()}
ENERGY_CLASS_BY_NAME: dict[str, int] = {v: k for k, v in ENERGY_CLASS.items()}


# --- Allowed YAML enums (for validation in models.py) -----------------------

APT_DISPOSITION_NAMES: frozenset[str] = frozenset(APT_DISPOSITION_BY_NAME)
HOUSE_TYPE_NAMES: frozenset[str] = frozenset(HOUSE_TYPE_BY_NAME)
OWNERSHIP_NAMES: frozenset[str] = frozenset(OWNERSHIP_BY_NAME)
BUILDING_TYPE_NAMES: frozenset[str] = frozenset(BUILDING_TYPE_BY_CZECH.values())
BUILDING_CONDITION_NAMES: frozenset[str] = frozenset(BUILDING_CONDITION_BY_CZECH.values())
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
