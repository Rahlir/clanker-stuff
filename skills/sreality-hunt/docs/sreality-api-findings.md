# Sreality API findings

Notes from probing `https://www.sreality.cz/api/...`. The API is undocumented;
everything here was learned by inspection. Update this doc when you discover new
fields, params, or codebook values.

> **2026-06-13 migration.** sreality retired the old `/api/cs/v2` API (it now
> 404s for every path) and replaced it with `/api/v1`, backing a Next.js
> frontend. This doc describes **v1**. The v2 notes are gone; if you need them,
> see git history. No authentication or cookies are required, but the Envoy
> front rejects some non-browser clients, so send a realistic desktop
> `User-Agent` (the client's default does this).

## Endpoints

### Search (list)

```
GET https://www.sreality.cz/api/v1/estates/search?<params>
```

Response shape:

```json
{
  "results": [ ... ],          // array of summary objects (see below)
  "pagination": {
    "limit": 100,              // page size actually applied
    "offset": 0,
    "total": 1061              // total matching count
  },
  "search_title": "Byty na prodej Praha 5",
  "meta_title": "...",
  "meta_description": "...",
  "status_code": 200,
  "status_message": "OK"
}
```

Pagination is **`limit` + `offset`** (the v2 `page` / `per_page` are gone).
Default `limit` is 100. Walk pages by incrementing `offset` until
`offset >= pagination.total`.

### Detail

```
GET https://www.sreality.cz/api/v1/estates/<hash_id>
```

Returns `{ "result": { ...flat listing... }, "status_code", "status_message" }`.
The listing is under **`result`** (a flat snake_case object). A missing /
removed listing returns HTTP **404** (the client maps 404/410 on a numeric
`/estates/<id>` path to `ListingNotFound`).

There is **no metadata / codebook endpoint** (`/api/v1/filter`, `/codebooks`,
... all 404).

## Query parameters

| param | type | example | notes |
|---|---|---|---|
| `category_main_cb` | int (required) | 1 | 1=byt, 2=dum, 3=pozemek, 4=komercni, 5=ostatni |
| `category_type_cb` | int (required) | 1 | 1=prodej, 2=pronajem, 3=drazba |
| `category_sub_cb` | int, comma-multi | `6,7` | disposition / house subtype (codebooks below) |
| `locality_region_id` | int, comma-multi | 10 | 10=Praha |
| `locality_district_id` | int, comma-multi | `5005,5006` | finer than region |
| `price_from` / `price_to` | int | `5000000` | CZK range (replaces v2 `czk_price_summary_order2`) |
| `usable_area_from` / `usable_area_to` | int | `70` | m² range |
| `balcony` / `terrace` / `loggia` / `cellar` / `garage` | 1 | | presence filter |
| `parking_lots` | 1 | | has parking |
| `elevator` | 1 | | has elevator (v2 used `elevator_cb`) |
| `ownership` | int | 1 | 1=osobni, 2=druzstevni (v2 used `ownership_cb`) |
| `building_type` | int | 2 | **v1 codes** (2=cihla, 5=panel, ...); see divergence note |
| `building_condition` | int | 6 | **v1 codes** (6=novostavba, ...) |
| `limit` / `offset` | int | `60` / `0` | pagination |
| `sort` | str | `-date` | **`-date` = newest first** (v2 had no clean recency sort) |

**Multi-value encoding is comma-separated** (`5005,5006`). The v2 pipe form
(`5005|5006`) now returns HTTP 422/500. Repeated params and `[]` brackets do
not work.

`sort=-date` is the big win over v2: a capped digest can walk the most recent
listings instead of relying solely on DB dedup.

## Per-listing fields (search `results[]`)

The v1 summary is **thin** - no area / floor / building / amenity detail (those
require a detail fetch).

```
hash_id            int
advert_name        string      title, e.g. "Prodej bytu 3+kk 84 m²"
category_main_cb   {name,value}
category_sub_cb    {name,value}
category_type_cb   {name,value}
price              float       CZK; 0/1 = "Cena v RK" (hidden)
price_czk          float       CZK
price_czk_m2       int         precomputed price/m² (used directly for pricing)
locality           object      flat locality block (see detail)
advert_images      string[]    protocol-relative preview URLs ("//d18-a.sdn.cz/...")
premise / premise_id / premise_logo   agency
poi_*_distance     int         distance in m to nearest bus/metro/shop/... (100000 = none)
```

## Per-listing fields (detail `result`)

Flat snake_case object. Modeled fields (we ignore the rest):

```
hash_id            int
advert_name        string      title
advert_description string      free-form description (Czech); may be null (shell listing)
category_main_cb / category_sub_cb / category_type_cb   {name, value}
usable_area        int
floor_number       int         the unit's floor (0=ground, may be negative)
floors             int         total floors in the building
underground_floors int
ownership          {name,value}   value 1=osobni 2=druzstevni (stable codes)
building_type      {name,value}   DIVERGED codes - read .name
building_condition {name,value}   DIVERGED codes - read .name
energy_efficiency_rating_cb  {name,value}   value 1..7 = A..G (stable), name "A - ..."
furnished          {name,value}   DIVERGED codes - read .name (Ano/Ne/Částečně)
elevator           {name,value}   0=nezadáno, 1=Ano, 2=Ne
easy_access        {name,value}   0/1/2 as above
balcony/terrace/loggia/cellar/garage/low_energy/basin   bool (occasionally null)
parking            int            count of parking spots (may be null)
price_czk / price_summary_czk     float CZK
price_czk_m2       int
locality           object         see below
advert_images      [{url, kind, order, width, height, id, alt}]   kind 2=photo, 4=floor plan
edited             string         ISO date, last update (replaces "Aktualizace: Dnes")
since              string         ISO date, first published
exclusively_at_rk  bool
```

### `locality` block (summary + detail)

```
city / citypart / quarter / street / district / region   display strings
city_seo_name / citypart_seo_name / quarter_seo_name / street_seo_name / ward_seo_name
region_id / district_id        ints (district_id drives comparable pricing)
gps_lat / gps_lon              floats
```

## Codebooks

`category_main_cb`, `category_type_cb`, `category_sub_cb` (apartments and
houses), and `energy_efficiency_rating_cb` (1..7 = A..G) are **unchanged** from
v2 - see `codebooks.py` for the full tables.

> **Code divergence.** v1 reassigned the integer codes for `building_type`,
> `building_condition`, and `furnished`. Because the API always sends the
> canonical Czech `name`, we read these enums by name (`*_BY_CZECH` in
> `codebooks.py`) rather than trusting the integer. `ownership` 1/2 and the
> energy 1..7 codes happen to be unchanged.

v1 codes observed by sampling (for the *filter* params, which take the int):

### `building_type` (v1)

| code | name | friendly |
|---|---|---|
| 2 | Cihlová | cihla |
| 5 | Panelová | panel |
| 6 | Skeletová | skeletova |
| 7 | Smíšená | smisena |

(Montovaná / Kamenná / Dřevostavba / Ostatní exist in the filter UI but their
v1 codes were not sampled; reading is by name so this only limits the filter
push.)

### `building_condition` (v1)

| code | name | friendly |
|---|---|---|
| 1 | Velmi dobrý | velmi_dobry |
| 2 | Dobrý | dobry |
| 4 | Ve výstavbě | ve_vystavbe |
| 5 | Projekt | projekt |
| 6 | Novostavba | novostavba |
| 8 | Před rekonstrukcí | pred_rekonstrukci |
| 9 | Po rekonstrukci | po_rekonstrukci |

### `furnished` (v1)

| code | name | friendly |
|---|---|---|
| 1 | Ano | true |
| 2 | Ne | false |
| 3 | Částečně | partial |

## URL construction

User-facing detail page URL:

```
https://www.sreality.cz/detail/<type-slug>/<main-slug>/<sub-slug>/<locality-slug>/<hash_id>
```

There is no single pre-built locality slug in v1 (the v2 `seo.locality` is
gone). We assemble one from `locality` seo components
(`city_seo_name` + `citypart_seo_name` + `street_seo_name`), e.g.
`praha-zbraslav-lesaku`. **The exact slug barely matters: sreality.cz
301-redirects any wrong slug to the canonical URL for the hash_id**, so the
slug only needs to be non-empty and plausible. (This is the opposite of v2,
where a wrong slug 404'd.)

## Practical observations

- **`sort=-date`** is the recency signal v2 lacked. Default ordering still
  surfaces promoted listings first.
- **Prices are floats** and can carry fractional cruft for foreign-currency
  listings (e.g. `price_czk: 15928030.0000002` for a EUR-priced Spain listing).
  Round to int on ingest.
- **Explicit nulls are common** where a field is unset (`parking: null`, null
  description, null bools). The models coerce these to the type's zero value;
  pydantic's field default only fires for *absent* keys, not present-but-null.
- **`price` can be `0` or `1`** for "Cena v RK" listings; treat <100k CZK as
  "price hidden" and exclude from percentile math.
- **No authentication required.** Be polite: throttle to ~1 req/s.
