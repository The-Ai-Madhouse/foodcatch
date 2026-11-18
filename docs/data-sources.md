# Data sources

What FoodCatch fetches, from where, under which limits, and what to keep in mind about the data.
Facts were verified against the live APIs in November 2026. Unofficial endpoints can change
without notice; when one does, the affected job fails with a schema error instead of storing data
it cannot validate (see the [runbook](runbook.md)).

| Source | Status | Key | Jobs | Throttle used |
|---|---|---|---|---|
| [Salling Group](#salling-group) | official developer API | yes (`SALLING_API_KEY`) | `salling-stores`, `salling-food-waste` | 4 req/s |
| [Tjek / eTilbudsavis](#tjek--etilbudsavis) | unofficial | no | `tjek-stores`, `tjek-offers` | 4 req/s |
| [Rema 1000](#rema-1000) | unofficial | no | `rema-products` | 4 req/s |
| [Open Food Facts](#open-food-facts) | official, open data (ODbL) | no | `off-enrich` | 1.5 req/s |
| [Nominatim](#nominatim-openstreetmap) | official public service | no | web app (address lookup) | 1 req/s, cached |

Common rules for every request (architecture §3):

* `User-Agent: foodcatch/<version> (+https://github.com/toke-dk/foodcatch)` identifies us.
* No personal data is ever sent. The user's address is only sent to Nominatim, from the locally
  running web app, and the result is cached.
* The shared HTTP client (`pipeline/src/foodcatch/http.py`) throttles per host, retries network
  errors, HTTP 429 and 5xx with exponential backoff and honours `Retry-After` (capped at 120 s).
* Every response is stored unchanged (gzip) in the raw store before it is parsed
  ([ADR 0002](decisions/0002-raw-first-pipeline.md)), so nothing has to be fetched twice.
* Development and tests use small recorded fixtures (`pipeline/tests/fixtures/`), never a crawl.

---

## Salling Group

Official API for Netto, føtex and Bilka. Base URL `https://api.sallinggroup.com`, header
`Authorization: Bearer <SALLING_API_KEY>` (developer account, see [setup](setup.md) §3). The key
is sent as a header only and never recorded in raw-object parameters or logs.

### Endpoints used

| Endpoint | Purpose |
|---|---|
| `GET /v2/stores?brand=netto\|foetex\|bilka&per_page=…&page=…` | stores: `id` (UUID), `name`, `brand`, `address{street, zip, city, country, extra}`, `coordinates` **`[lon, lat]`**, `hours[…]`, `attributes{…}` |
| `GET /v1/food-waste/{storeId}` | clearances of one store: `{store, clearances: [{offer, product}]}` |

Not used:

* `GET /v1/food-waste/?geo=lat,lon&radius=KM` (radius ≤ 100) and `?zip=NNNN`: return only the
  ~17 nearest stores, so the job iterates over all stores from `/v2/stores` instead.
* `GET /v1/leaflet-offers`: answers 403 for our key (its scope does not include production
  access). Netto's leaflet offers come from Tjek instead.

### Data caveats

* **Coordinates are `[longitude, latitude]`** (GeoJSON order), unlike most other sources.
* `hours` is large and unused. It is dropped after raw storage (architecture §4, volume control).
* In a clearance, **`offer.ean` is a clearance-label code, not the product's GTIN**. The real
  product EAN is **`product.ean`**; FoodCatch uses only that one.
* `offer`: `currency`, `discount`, `newPrice`, `originalPrice`, `percentDiscount`, `startTime`,
  `endTime`, `lastUpdate`, `stock`, `stockUnit`. `originalPrice` is the store's shelf price for
  that EAN. It is stored as an EAN-level reference price (`product_reference_price`) for every
  store, while full clearance listings are kept only for stores within `REGION_RADIUS_KM` of a
  `REGION_CENTERS` entry.
* `product.description` is an abbreviated, upper-case product name, so recognition is harder
  than for leaflet headings.
* `product.categories` (`{da, en}`) may be missing. Category paths can contain repeated
  segments (`"A>B>C>A>B>D"`); the leaf is the last segment.
* Rate limits are undocumented. We throttle to about 4 requests/s, honour 429 + `Retry-After`
  and retry 5xx with backoff. A food-waste run makes one request per Salling store (several
  hundred), twice a day.

---

## Tjek / eTilbudsavis

The backend of the eTilbudsavis leaflet app. **Unofficial**: no published terms for third-party
use, no key, no SLA. Base URL `https://squid-api.tjek.com/v2`. Only `/v2` endpoints are used; the
`/v4/rpc/*` endpoints require a Tjek API key, which we do not have.

### Endpoints used

| Endpoint | Purpose |
|---|---|
| `GET /dealers?country_id=DK&limit=100&offset=N` | dealer (chain) ids; only to look up ids for `chain.tjek_dealer_id` (no scheduled job) |
| `GET /stores?dealer_ids=ID&limit=100&offset=N` | stores: `id`, `dealer_id`, `name`, `street`, `city`, `zip_code`, `latitude`, `longitude`, `country` |
| `GET /catalogs?dealer_ids=ID&limit=24` | leaflets: `id`, `label`, `run_from`, `run_till` (ISO, `+0000`), `offer_count`, `page_count` |
| `GET /offers?catalog_ids=ID&limit=100&offset=N` | offers of one leaflet (fields below) |

Dealer ids: netto `9ba51`, rema1000 `11deC`, lidl `71c90`, foetex `bdf5A`, 365discount `DWZE1w`,
bilka `93f13`, loevbjerg `65caN`, superbrugsen `0b1e8`, kvickly `c1edq`, meny `267e1m`,
spar `88ddE`. They are seeded by the first migration.

### Data caveats

* **Pagination is capped**: the API refuses `offset + limit > 1000`. Stores are therefore
  fetched one dealer at a time (the largest chain has about 550 stores). If a single query ever
  reaches the cap, the job fails rather than silently truncating.
* `/catalogs` lists only currently published leaflets, **no history**. A day without collection
  is a day of offers lost for good, which is why the jobs are monitored. The job fetches
  catalogs that are current or start within 7 days, and skips catalogs whose label contains
  "Nonfood" (case-insensitive).
* Offer fields: `id`, `heading`, `description`, `pricing{price, pre_price, currency}`,
  `quantity{unit{symbol, si{symbol, factor}}, size{from, to}, pieces{from, to, min, max}}`,
  `run_from`, `run_till`, `dealer_id`, `catalog_id`, `catalog_page`, `store_id`.
  `category_ids` is always empty, so classification relies on the text.
* An offer's period can differ from its catalog's (e.g. a monthly offer inside a weekly leaflet).
  Listings use the offer's own `run_from`/`run_till`.
* **Unit prices** (PoC rule): the SI factor converts the size to kg, l or pieces (`pcs` → `stk`);
  `lo = size.from × factor × pieces.from`, `hi = size.to × factor × pieces.from`;
  `unit_price_min = price / hi`, `unit_price_max = price / lo`. Without a positive size range the
  unit price is unknown. Ranges like "18-20 x 33 cl" use `pieces.from` for both ends.
* **`pre_price` is almost always null.** The reference price is then parsed from
  "Normalpris 19,95" in the description, when present.
* Descriptions carry other information that is parsed conservatively:
  * purchase limits: "Max. 6 stk. pr. kunde pr. dag" → `max_per_customer = 6`
    (but "Pr. kg max. 61,25" is a unit price, not a limit);
  * membership prices: "Netto+", "+ PRIS 20:-", "Lidl Plus", "føtex plus", "Medlemspris",
    "Pris ikke-medlem 149,95", "Et medlemskab af Coop". When it is unclear whether the listed
    price needs a membership, the listing is marked `member_only`.

---

## Rema 1000

The product catalogue behind Rema 1000's web shop. **Unofficial**, no key.

### Endpoint used

`GET https://cphapp.rema1000.dk/api/v3/products?per_page=1000&page=N`; `meta.pagination.last_page`
gives the number of pages (about 3,956 products, so 4 requests per run).

### Data caveats

* Fields: `id`, `name`, `underline` (size and brand text), `labels`, `is_weight_item`, and
  `prices[]` with `price`, `is_campaign`, `is_advertised`, `starting_at`, `ending_at`,
  `compare_unit` (`"kg"`, `"ltr"`, `"stk."`, …), `compare_unit_price`, `max_quantity`,
  `price_over_max_quantity`, `deposit`.
* **No EAN.** Rema products are matched to other sources by recognition of name and size only.
* The non-campaign price is Rema's shelf price. It serves as a `regular` reference in deals.
  Rema is the only chain whose full shelf prices we have.
* `compare_unit` values need normalizing (`ltr` → `l`, `stk.` → `stk`).
* The catalogue has no store dimension; it is treated as Rema's national price list.

---

## Open Food Facts

Open, crowd-sourced product database. Official API, no key; data under the Open Database
License (ODbL), images under CC BY-SA.

### Endpoint used

`GET https://world.openfoodfacts.org/api/v2/product/{ean}.json?fields=product_name,brands,quantity,product_quantity,product_quantity_unit,nova_group,nutriscore_grade,categories_tags`

`status` is `1` when found and `0` when not.

### Data caveats

* Limit: **100 product reads per minute** per client. We throttle to 1.5 requests/s and only
  look up EANs without data (`product.off_checked_at` is null), so a normal day needs few
  requests.
* A `User-Agent` that identifies the application is required.
* Coverage of Danish private-label products is patchy, and `nova_group` / `nutriscore_grade`
  are often missing. Missing data is never treated as "healthy".
* ODbL requires attribution if derived data is ever published.

---

## Nominatim (OpenStreetMap)

Geocoding of the user's address in the web app (server side).

* `GET https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=dk&q=…`
* Usage policy: at most **1 request per second**, an identifying `User-Agent`, results must be
  cached, no bulk geocoding. FoodCatch geocodes only addresses the user types in and caches them.
* Results are © OpenStreetMap contributors (ODbL); show attribution where results are displayed.
* DAWA (the former Danish address API) has been shut down and answers HTTP 410.

---

## Legal note

FoodCatch is a personal, non-commercial project. Salling Group and Open Food Facts are used
through their official APIs and under their terms. **Tjek and Rema 1000 endpoints are
unofficial**: they are the backends of public apps and web shops, without published terms for
third-party use. Republishing their data could conflict with their terms and with the EU
*sui generis* database right (Directive 96/9/EC), which protects substantial extractions from
databases such as a leaflet or price catalogue.

Therefore ([ADR 0003](decisions/0003-local-only-web.md)):

* The source code is public, but the **web app is only run locally** by the owner. Nothing
  derived from Tjek or Rema data is published.
* Collection stays modest: one pass per day (stores weekly), throttled, identified by our
  User-Agent, and never more than the app or web shop itself would load.
* Before any public deployment, use of the data must be clarified with the sources (or the
  unofficial sources dropped). That decision will be recorded in a new ADR.

This note is not legal advice.
