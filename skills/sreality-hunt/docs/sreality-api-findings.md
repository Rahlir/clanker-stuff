# Sreality API findings

Notes from probing `https://www.sreality.cz/api/...` on 2026-05-17. The API is
undocumented; everything here was learned by inspection. Update this doc when
you discover new fields, params, or codebook values.

## Endpoints

### List

```
GET https://www.sreality.cz/api/cs/v2/estates?<params>
```

Response shape:

```json
{
  "result_size": 4608,         // total matching count
  "page": 1,
  "per_page": 20,
  "_embedded": {
    "estates": [ ... ],
    "is_saved": false,
    "not_precise_location_count": 0
  },
  "_links": { ... },
  "locality": "...",           // human title of the result set
  "filterLabels": [ ... ]
}
```

Pagination: `page=1..N`, `per_page=1..N` (probably capped, 100 worked fine).
Pages do not overlap.

### Detail

```
GET https://www.sreality.cz/api/cs/v2/estates/<hash_id>
```

Returns a much larger object (typically 50-150 KB).

## Query parameters

| param | type | example | notes |
|---|---|---|---|
| `category_main_cb` | int (required) | 1 | 1=byt, 2=dum, 3=pozemek, 4=komercni, 5=ostatni |
| `category_type_cb` | int (required) | 1 | 1=prodej, 2=pronajem, 3=drazba |
| `category_sub_cb` | int (multi via `\|`) | `6\|7\|8` | disposition / house subtype (see codebooks) |
| `locality_region_id` | int | 10 | 10=Praha; multi via `\|` |
| `locality_district_id` | int (multi via `\|`) | `5001\|5002` | finer than region |
| `czk_price_summary_order2` | `MIN\|MAX` | `8000000\|13000000` | CZK price range |
| `usable_area` | `MIN\|MAX` | `70\|999` | m² range. Use a big upper bound (e.g. 9999) for "no max" |
| `floor_number` | `MIN\|MAX` | `2\|6` | floor range (apartments) |
| `room_count_cb` | int | | |
| `building_type_cb` | int | 1 | 1=cihla, 2=panel, 3=ostatni, ... |
| `building_condition_cb` | int | | |
| `ownership_cb` | int | 1 | 1=osobni, 2=druzstevni, 3=statni, 4=jine |
| `furnished_cb` | int | | 1=ano, 2=castecne, 3=ne |
| `energy_efficiency_rating_cb` | int | | 1=A ... 7=G |
| `balcony` | 1 | | presence filter |
| `terrace` | 1 | | |
| `loggia` | 1 | | |
| `cellar` | 1 | | |
| `garage` | 1 | | |
| `parking_lots` | int | | |
| `elevator_cb` | int | 1 | |
| `low_energy` | 1 | | |
| `easy_access` | 1 | | |
| `per_page` | int | 60 | |
| `page` | int | 1 | |
| `sort` | int | 0 | 0=default (topped first then "relevant"), 1=price asc, 2=price desc, 3=area or alt price. No clean "newest first" found - rely on DB de-dup to detect new listings instead. |
| `tms` | int (ms) | timestamp | cache-buster, optional |

Multi-value: separate with `|` (URL-encoded `%7C`).

## Per-listing fields (list response)

```
hash_id           int         primary id, used in detail endpoint and URL
name              string      title, e.g. "Prodej bytu 4+kk 78 m²"
price             int         CZK, raw integer. 0 or 1 means "cena v RK" / nedefinováno
locality          string      display address, e.g. "Husovo náměstí, Klatovy - Klatovy III"
gps.lat / gps.lon float
seo.category_main_cb / category_sub_cb / category_type_cb / locality   slug components for URL
labels / labelsAll / labelsReleased  string[] - Czech amenity/area labels
advert_images_count   int
_links.images[].href  preview thumbnails (400x300)
_links.image_middle2  single primary preview
new               bool        "marked as new" flag (rarely true)
is_topped / is_topped_today   paid promotion
exclusively_at_rk int         exclusive listing flag
is_auction        bool
has_video / has_panorama / has_floor_plan / has_matterport_url
```

## Per-listing fields (detail response)

Top-level:

```
name.value           string         title
text.value           string         free-form description (Czech)
price_czk.value_raw  int            CZK price
items[]              array          structured property list (see below)
recommendations_data dict           machine-readable English-key dump (see below)
locality             {name,value,accuracy}    full address
map                  {lat,lon,zoom,type}
poi[]                array          nearby POIs with distance (mixed categories)
poi_transport, poi_grocery, poi_school_kindergarten, poi_doctors,
poi_leisure_time, poi_restaurant   aggregated POI summaries
seo                  slug components (same as list)
codeItems            dict with ownership, building_type_search, etc.
is_topped / is_topped_today   bool
meta_description     string         SEO description
_embedded.images[]   array          full image list, see below
_embedded.seller     dict           agency/owner contact (skip unless asked)
_links.self          {href:"/cs/v2/estates/<hash_id>", ...}
_links.similar_adverts, _links.local_search
```

### `items[]` (structured properties, Czech labels)

Each item is `{type, name, value, unit?, notes?, value_raw?, value_type?}`.
Types observed: `price_czk`, `string`, `area`, `boolean`, `count`, `set`, `edited`,
`energy_efficiency_rating`.

Example entries:
```
{type: "string",   name: "Stavba",       value: "Cihlová"}
{type: "string",   name: "Stav objektu", value: "Po rekonstrukci"}
{type: "string",   name: "Vlastnictví",  value: "Osobní"}
{type: "string",   name: "Podlaží",      value: "3. podlaží z celkem 5"}
{type: "area",     name: "Užitná plocha",unit: "m2", value: "78"}
{type: "boolean",  name: "Sklep",        value: true}
{type: "count",    name: "Parkování",    value: "1"}
{type: "set",      name: "Doprava",      value: [{name:"Doprava",value:"MHD"}, ...]}
{type: "edited",   name: "Aktualizace",  value: "Dnes", topped: true}
{type: "energy_efficiency_rating", value_type: "G", value: "..."}
```

Czech labels are good for the user-facing facts table; for programmatic checks
prefer `recommendations_data` (English keys, integer codes).

### `recommendations_data` (machine-readable goldmine)

```
hash_id                     int
category_main_cb            int     1=apt 2=house 3=land 4=commercial 5=other
category_sub_cb             int     disposition / house type (codebook below)
category_type_cb            int     1=sale 2=rent 3=auction
usable_area                 int     m²
room_count_cb               int     room-count code
ownership                   int     1=osobni 2=druzstevni 3=statni 4=jine
building_type               int     1=cihla 2=panel ...  (codebook below)
building_condition          int     codebook below
energy_efficiency_rating_cb int     1=A ... 7=G
balcony                     bool
terrace                     bool
loggia                      bool
cellar                      bool
garage                      bool
parking_lots                int
elevator                    bool
furnished                   int     0=no info, 1=ano, 2=castecne, 3=ne
low_energy                  bool
easy_access                 bool
basin                       bool    (pool)
object_type                 int
object_kind                 int
price_summary_czk           int
price_summary_unit_cb       int     unit code (per nemovitost / per měsíc / ...)
locality_country_id         int
locality_region_id          int
locality_district_id        int
locality_municipality_id    int
locality_quarter_id         int
locality_ward_id            int
locality_street_id          int
locality_gps_lat            float
locality_gps_lon            float
```

### `_embedded.images[]`

Each image:
```
id                  int
order               int
kind                int    2=normal photo, 4=other (floor plan?)
_links.view         749x562 (good for chat)
_links.self         1920x1080 (full)
_links.gallery      221x166 (thumb)
_links.dynamicDown  templated URL (use {width}/{height})
```

Watermarked variant available under `_links.dynamicUp`.

### `codeItems`

```
ownership                   int   1=osobni 2=druzstevni ...
building_type_search        int   coarser building type
something_more1/2/3         int[] amenity bitmask codes - meaning TBD
```

## Codebooks

### `category_main_cb`

| code | meaning | URL slug |
|---|---|---|
| 1 | byt | `byt` |
| 2 | dům | `dum` |
| 3 | pozemek | `pozemek` |
| 4 | komerční | `komercni` |
| 5 | ostatní | `ostatni` |

### `category_type_cb`

| code | meaning | URL slug |
|---|---|---|
| 1 | prodej | `prodej` |
| 2 | pronájem | `pronajem` |
| 3 | dražba | `drazba` |

### `category_sub_cb` for apartments (main=1)

| code | disposition | URL slug |
|---|---|---|
| 2 | 1+kk | `1+kk` |
| 3 | 1+1 | `1+1` |
| 4 | 2+kk | `2+kk` |
| 5 | 2+1 | `2+1` |
| 6 | 3+kk | `3+kk` |
| 7 | 3+1 | `3+1` |
| 8 | 4+kk | `4+kk` |
| 9 | 4+1 | `4+1` |
| 10 | 5+kk | `5+kk` |
| 11 | 5+1 | `5+1` |
| 12 | 6 a více | `6-a-vice` |
| 16 | atypický | `atypicky` |

### `category_sub_cb` for houses (main=2)

| code | type | URL slug |
|---|---|---|
| 33 | chata | `chata` |
| 37 | rodinný dům | `rodinny` |
| 39 | vila | `vila` |
| 43 | chalupa | `chalupa` |
| 44 | zemědělská usedlost | `zemedelska-usedlost` |
| 47 | památka *(unverified)* | `pamatka` |
| 54 | vícegenerační dům | `vicegeneracni-dum` |

Additional house sub codes likely exist; check empirically when first seen.

### `ownership`

| code | meaning |
|---|---|
| 1 | osobní |
| 2 | družstevní |
| 3 | státní/obecní |
| 4 | jiné |

### `building_type`

| code | meaning |
|---|---|
| 1 | cihla |
| 2 | panel |
| 3 | ostatní |
| 4 | montovaná |
| 5 | skeletová |
| 6 | kamenná |
| 7 | smíšená |
| 8 | dřevostavba |
| 9 | nezadáno |

(values 1, 2 confirmed by sampling; others inferred from sreality web UI.)

### `building_condition`

Sample mapping (empirical):

| code | meaning |
|---|---|
| 2 | novostavba |
| 3 | velmi dobrý |
| 4 | dobrý |
| 5 | v rekonstrukci |
| 6 | před rekonstrukcí |
| 7 | po rekonstrukci (matched in probe) |
| 8 | špatný |
| 9 | po rekonstrukci? (also seen) - verify per listing using `items[].Stav objektu` |
| 10 | projekt |

Codes 7 vs 9 both appeared as "po rekonstrukci" in the wild; trust the
`items[]` Stav objektu string for display, use the code only for filtering.

### `energy_efficiency_rating_cb`

| code | class |
|---|---|
| 1 | A - mimořádně úsporná |
| 2 | B - velmi úsporná |
| 3 | C - úsporná |
| 4 | D - méně úsporná |
| 5 | E - nehospodárná |
| 6 | F - velmi nehospodárná |
| 7 | G - mimořádně nehospodárná |

## URL construction

User-facing detail page URL:

```
https://www.sreality.cz/detail/<type-slug>/<main-slug>/<sub-slug>/<locality-slug>/<hash_id>
```

All four slugs are required - a wrong slug returns 404, except `seo.locality`
is canonical so we always get it right from the API response.

Example:
```
https://www.sreality.cz/detail/prodej/byt/4+kk/klatovy-klatovy-iii-husovo-namesti/3500933964
```

## Practical observations

- **Default sort (`sort=0`) puts paid `is_topped` listings first.** Don't trust
  ordering as a recency signal. The intended "new listings since last digest"
  flow is: fetch matching listings, dedupe against the DB's `seen` table, treat
  any unseen `hash_id` as new.
- **`price` can be `0` or `1`** for listings with "Cena v RK" (price on request).
  Treat <100k CZK as "price hidden" and exclude from percentile math.
- **`is_topped: true`** doesn't mean the listing itself is notable, only that
  the agency paid for promotion. Useful as an input to the LLM (low weight) but
  not as a filter.
- **`new: true`** in the list response is rarely set; don't rely on it.
- **`items[]` "Aktualizace"** has values like "Dnes", "Včera", "3 dny",
  "8.4.2025". Useful for "stale listing" detection. There is no machine-readable
  `created_at` / `updated_at` ISO timestamp.
- **No authentication required** for any of the read endpoints used here.
- **Be polite**: throttle to ~1 req/s. The API has not 429'd in light probing,
  but a heavy digest could trip rate limits.
