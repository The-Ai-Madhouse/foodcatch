# FoodCatch – Architecture

FoodCatch finds healthy, minimally processed staple groceries that are **genuinely cheap**
near a given location: cheaper than the same product at nearby competitors, than reference
shelf prices, and than its own price history. Trustworthiness of every price claim is the
primary design goal.

This document is the contract between the parts of the system. Code must follow it; changes
to it are made deliberately (and recorded as an ADR in `docs/decisions/`).

## 1. Overview

```
            ┌──────────────────────── GitHub Actions (cron) ───────────────────────┐
            │  foodcatch collect <job>  →  raw store (B2)  →  ingest  →  classify   │
            │                                   →  compute deals  →  quality checks │
            └──────────────────────────────┬───────────────────────────────────────┘
                                           │ SQLAlchemy (owner role)
                                           ▼
                                  Neon Postgres  ── schema `public` (pipeline-owned tables)
                                           ▲       ── schema `api`    (read-only views = web contract)
                                           │ SQL (read-only role `web_readonly`)
                                  Next.js web app (runs locally for now)
```

* **pipeline/** – Python 3.12 package `foodcatch` (uv). Fetches, stores raw, normalizes,
  classifies, computes deals. All business logic about prices and product recognition lives here.
* **web/** – Next.js (App Router, TypeScript). Reads **only** from views in the `api` schema.
  Contains presentation logic and a small, pure, unit-tested function for location filtering of
  deal references (see §6). Never writes to the database.
* **Postgres** – Neon in production, `docker compose` Postgres 17 locally and in CI.
* **Raw store** – Backblaze B2 (S3-compatible) in production; local directory in development.

## 2. Repository layout

```
foodcatch/
├── README.md                  overview + quickstart
├── LICENSE                    MIT
├── docker-compose.yml         local Postgres 17
├── .env.example               every environment variable, documented
├── docs/
│   ├── architecture.md        this file
│   ├── setup.md               step-by-step: Neon, B2, GitHub secrets, healthchecks, Sentry
│   ├── data-sources.md        what each external API gives, limits, terms caveats
│   ├── runbook.md             operations: failures, reprocessing, migrations, restore, limits
│   └── decisions/             ADRs (NNNN-title.md)
├── pipeline/
│   ├── pyproject.toml         uv project; ruff, pyright, pytest config
│   ├── alembic.ini
│   ├── src/foodcatch/
│   │   ├── config.py          pydantic-settings Settings (env + .env)
│   │   ├── cli.py             Typer app: `foodcatch ...`
│   │   ├── logging.py         structured logging setup
│   │   ├── http.py            shared httpx client: UA, timeouts, retry (tenacity, per-request policy), throttle
│   │   ├── monitoring.py      healthchecks.io pings + optional Sentry init
│   │   ├── storage/raw.py     RawStore protocol; LocalRawStore, S3RawStore (B2)
│   │   ├── db/
│   │   │   ├── engine.py      engine/session helpers
│   │   │   ├── tables.py      SQLAlchemy Core Table definitions (single source of truth)
│   │   │   └── migrations/    Alembic env + versions (also creates `api` views + role grants)
│   │   ├── sources/           one module per external API: pydantic response models + fetchers
│   │   │   ├── salling.py     stores, food-waste
│   │   │   ├── tjek.py        dealers, stores, catalogs, offers
│   │   │   ├── rema.py        product catalogue
│   │   │   └── openfoodfacts.py  EAN enrichment
│   │   ├── ingest/            raw payload → normalized rows (idempotent upserts)
│   │   ├── matching/          product recognition (ported from poc/matching.py)
│   │   ├── deals/             reference prices + conservative verdicts
│   │   ├── jobs/              orchestration of one job run (fetch_run bookkeeping, quality checks);
│   │   │                      salling_geo.py plans the Salling food-waste geo queries
│   │   ├── reprocess.py       replay raw objects through ingest, classify, deals
│   │   ├── rawindex.py        rebuild missing raw_object rows from the raw store
│   │   └── review.py          review queue helpers
│   └── tests/
├── web/
│   ├── package.json           pnpm
│   ├── scripts/               development seed (pnpm db:seed)
│   ├── src/app/               routes (Danish UI)
│   ├── src/server/            db client + typed queries (server-only)
│   ├── src/lib/               pure logic (deal filtering, formatting) – unit tested
│   └── src/components/
├── poc/                       archived proof of concept (not used by production code)
└── .github/workflows/         ci.yml (checks + actionlint), collect.yml (all scheduled jobs),
                               db-migrate.yml (production migrations), keepalive.yml
```

## 3. Conventions

* Code, identifiers, comments, docs, commit messages: **English**. Everything a user sees in the
  web UI: **Danish**. Product-domain data values (e.g. `"Hakket oksekød"`) stay Danish.
* Python: typed everywhere (`pyright` strict on `src/`), `ruff` (lint + format), `pytest`.
  No bare `except`. No `print` outside the CLI layer – use logging.
* TypeScript: `strict`, ESLint + Prettier, Vitest for `src/lib`.
* Timestamps are stored as `timestamptz` in UTC; display in `Europe/Copenhagen`.
* Money: `numeric(10,2)` DKK in the DB; unit prices `numeric(12,4)`.
* Secrets only via environment variables. `.env` is git-ignored; `.env.example` documents all.
* Every external request sends `User-Agent: foodcatch/<version> (+https://github.com/toke-dk/foodcatch)`.
  No personal data in requests.
* Commits: Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`).

## 4. Data flow and job design

Every job is a CLI command, e.g. `foodcatch collect salling-food-waste`. A job run:

1. Creates a `fetch_run` row (`status='running'`, `git_sha`, `job`, `started_at`).
2. **Fetch** – calls the external API via `sources/*`, validating responses with pydantic models.
   A schema mismatch is a hard failure (we never store data we could not validate).
3. **Raw** – stores every response body **unchanged**, gzip-compressed, in the raw store at
   `{source}/{endpoint}/{YYYY}/{MM}/{DD}/{fetch_run_id}/{seq:05d}.json.gz` and records a
   `raw_object` row (sha256, bytes, params). Raw objects are never modified or deleted.
4. **Ingest** – parses validated payloads into normalized rows. Idempotent: re-running the same
   raw objects yields the same database state (upserts on natural keys).
5. **Classify** – runs product recognition (`matching/`) with the code's `MATCHER_VERSION` for
   new/changed `listing`s and every listing not yet classified with that version. If that
   version is not the current `matcher_release` (first run after a matcher upgrade), every
   listing has now been classified with it, so it is made current and old classifications are
   pruned (the same as `foodcatch reclassify`).
6. **Deals** – recomputes `deal` rows affected by the run: listings ingest changed and listings
   whose classification changed (`jobs/hooks.py`); every deal when step 5 promoted a release.
7. **Quality checks** – compares the job's quality metric (`records` by default) with the
   previous successful run of the same job; a drop of more than 50 % (configurable) marks the run
   `degraded` and exits non-zero. A job can also report `degraded` itself when it could not
   finish its work (e.g. the Salling quota ended a food-waste run before the region was covered).
8. Finishes the `fetch_run` (`succeeded` / `degraded` / `failed`, counts, error) and pings
   healthchecks.io (`/start`, success, `/fail`) if a ping URL is configured.

`foodcatch reprocess --source <s> [--since DATE] [--until DATE]` replays steps 4–6 from the raw
store. `foodcatch raw reindex` rebuilds missing `raw_object` rows from the raw store (after a
database restore). `foodcatch reclassify` re-runs steps 5–6 for all listings (after matcher or
override changes). `foodcatch review list|resolve` works through the review queue.

### Jobs and schedules (GitHub Actions, times UTC)

All six jobs run from one workflow, `.github/workflows/collect.yml`: each cron entry maps to
exactly one job, with a per-job concurrency group, per-job healthchecks.io check, manual
dispatch (`gh workflow run collect.yml -f job=<job>`) and the repository variable
`COLLECT_PAUSED_JOBS` to pause scheduled runs. `db-migrate.yml` applies migrations to production
on push to `main` when migrations change (and on demand); `keepalive.yml` re-enables the
scheduled workflows monthly. Operations: `docs/runbook.md`.

| Job | Command | Schedule |
|---|---|---|
| Salling stores | `collect salling-stores` | weekly (Mon 03:17) |
| Salling food waste | `collect salling-food-waste` | daily 05:37 and 13:37 (≤ `SALLING_FOOD_WASTE_MAX_CALLS` requests each) |
| Tjek stores | `collect tjek-stores` | weekly (Mon 03:47) |
| Tjek catalogs + offers | `collect tjek-offers` | daily 04:07 |
| Rema catalogue | `collect rema-products` | daily 02:27 |
| Open Food Facts | `collect off-enrich` | daily 06:07 (only EANs without data) |

Minutes are deliberately off the hour (GitHub schedules are delayed at :00).

**Salling request budget** ([ADR 0005](decisions/0005-salling-geo-tiling.md)). The Salling key
answers HTTP 429 for a long time after about 60 requests. `salling-food-waste` therefore uses
the geo query (one request returns the ~17 nearest stores) and plans its queries with
`jobs/salling_geo.py`: region stores first, then the rest of Denmark in rotation (least
recently covered first, persisted in `store.food_waste_checked_at`), never more than
`SALLING_FOOD_WASTE_MAX_CALLS` (default 25) requests per run. A 429 stops the run's fetching at
once without retries; the run keeps its data and is `degraded` only if the region was not fully
covered. Its quality metric is `region_clearances` (not `records`), so the rotating national
coverage does not trigger false alarms. `salling-stores` needs about 9 requests a week (one per page of 100 stores).

### Volume control (Neon free plan: 1 GB)

* Raw payloads live in B2, never in Postgres.
* Store objects: drop fields we do not use (opening hours, customer flow) **after** raw storage.
* Food-waste clearances are stored as `listing`s only for stores within
  `REGION_RADIUS_KM` (default 30) of any configured `REGION_CENTERS` (default: home location).
  For **all** stores we upsert the EAN-level reference price into `product_reference_price`
  (only when the price changes). Region stores are covered every run; the rest of the country in
  rotation over several runs (request budget above). Raw data for all covered stores remains in
  B2, so the region can be widened later by reprocessing.
* `classification` rows for matcher versions older than the two most recent are pruned.
* `foodcatch db stats` reports table sizes; a quality check warns at 70 % of `DB_SIZE_BUDGET_MB`.

## 5. Database schema (schema `public`, owned by Alembic)

Natural keys are enforced with unique constraints so ingest can upsert.

**`fetch_run`** – `id uuid pk`, `job text`, `source text`, `status text` (running|succeeded|degraded|failed),
`started_at`, `finished_at`, `git_sha text`, `stats jsonb` (counts per stage), `error text`.

**`raw_object`** – `id uuid pk`, `fetch_run_id fk`, `source`, `endpoint`, `params jsonb`, `storage_key text unique`,
`sha256 text`, `bytes int`, `fetched_at`.

**`chain`** – `id text pk` (`netto`, `rema1000`, `lidl`, `foetex`, `bilka`, `365discount`, `superbrugsen`,
`kvickly`, `meny`, `loevbjerg`, `spar`), `name text`, `tjek_dealer_id text unique null`, `salling_brand text null`.
Seeded by migration.

**`store`** – `id uuid pk`, `chain_id fk`, `source text` (salling|tjek), `source_store_id text`,
`name`, `street`, `zip`, `city`, `lat double`, `lon double`, `first_seen_at`, `last_seen_at`,
`food_waste_checked_at null` (scheduling state of `salling-food-waste`: when a run last covered
the store; written by the job, not by ingest), `unique(source, source_store_id)`. (Salling and
Tjek ids for the same physical store are not linked in v1.)

**`product`** – `id uuid pk`, `ean text unique`, `name`, `brand`, `source_category text` (e.g. Salling path),
`quantity_text`, `net_quantity numeric`, `net_unit text` (kg|l|stk), `nova_group smallint`,
`nutriscore_grade text`, `off_checked_at`, `first_seen_at`, `last_seen_at`.

**`product_reference_price`** – EAN-level shelf price observed via Salling food-waste `originalPrice`:
`product_id fk`, `chain_id fk`, `price numeric`, `first_seen_at`, `last_seen_at`, `observations int`,
`unique(product_id, chain_id, price, first_seen_at)`; a new row only when the price changes.

**`listing`** – one priced thing as published by a source, over a validity period:
`id uuid pk`, `source text` (tjek|rema|salling_food_waste), `source_item_id text`, `chain_id fk`,
`store_id fk null` (set for food waste), `catalog_id text null`, `kind text` (offer|regular|clearance),
`title text`, `description text`, `product_id fk null` (EAN when known),
`price numeric`, `reference_price numeric null` (pre-price / originalPrice),
`unit text null` (kg|l|stk), `size_min numeric null`, `size_max numeric null` (in `unit`),
`unit_price_min numeric null`, `unit_price_max numeric null`,
`member_only bool`, `max_per_customer int null`,
`valid_from timestamptz`, `valid_to timestamptz`, `first_seen_at`, `last_seen_at`,
`raw_object_id fk`, `extra jsonb` (owned by ingest; food waste: `stock`, `stock_unit`,
`percent_discount`, `offer_ean`, `product_code`, `image`, `category` – the keys
`api.food_waste_near` reads are snake_case; Rema: `is_advertised`, `is_weight_item`,
`compare_unit`, `deposit`, `price_over_max_quantity`, `labels`),
`classified_version text null`, `classified_fingerprint text null` (owned by `matching.persist`:
matcher version and input fingerprint of the last classification; never written by ingest),
`unique(source, source_item_id, valid_from, price)`. Ingest sets `last_seen_at = now()` on every
upsert; `api.food_waste_near` only shows clearances seen by the latest finished food-waste run.
A new price or start for an existing `source_item_id` is a new listing: the Rema and Tjek ingests
then close the superseded open versions (`valid_to` = the payload's fetch time), and deals and
`api.current_netto_deals` only use the latest version (highest `last_seen_at, valid_from`) of a
Tjek offer id.
Unit prices follow the PoC rule: `unit_price_min = price / size_max`, `unit_price_max = price / size_min`.

**`matcher_release`** – `version text pk`, `created_at`, `is_current bool` (exactly one current).

**`classification`** – result of recognition for one variant of a listing:
`listing_id fk`, `matcher_version fk`, `variant_index smallint`, `type_id text`, `type_label text`,
`group_name text`, `attrs jsonb`, `class_key text`, `class_label text` (Danish label of the class,
e.g. `Mælk, letmælk, økologisk`), `is_exact bool`, `is_healthy bool`,
`offer_variants smallint`, `same_class_variants smallint`, `notes text[]`, `source_hint text`,
`pk(listing_id, matcher_version, variant_index)`; index on `(matcher_version, class_key)`.
A listing with no recognized variant gets **no** rows (and may get a `review_item`).

**`classification_override`** – manual corrections that win over rules:
`id`, `source`, `match_title_normalized text`, `action text` (reject|force), `forced_result jsonb null`,
`note`, `created_at`, `unique(source, match_title_normalized)`.

**`review_item`** – queue for humans: `id`, `listing_id fk`, `reason text`
(unrecognized_staple_word|unknown_key_attribute|ambiguous_offer), `status` (open|accepted|rejected|fixed),
`created_at`, `resolved_at`, `note text null` (reviewer's note), `unique(listing_id, reason)`.

**`deal`** – precomputed verdict input for one Netto offer variant (see §6):
`listing_id fk`, `variant_index`, `matcher_version`, `class_key`, `netto_unit_price_worst numeric`,
`netto_unit_price_best numeric`, `price_applies bool`, `references jsonb`, `computed_at`,
`pk(listing_id, variant_index, matcher_version)`.

## 6. Deal logic (single source of truth: `pipeline/src/foodcatch/deals/`)

Ported from the PoC and **must keep its conservatism**:

* A reference counts as **same product** only if `comparability(a, b) == "same"`: identical type,
  all key attributes known and equal (incl. organic, lactose-free), same processing state.
* A competitor offer's unit price counts only if its price **applies to the variant**
  (all variants of that offer are the same class, or the unit-price spread ≤ 25 %).
* Netto is evaluated at its **worst** (highest) unit price, references at their **best** (lowest).
* Unit prices compare only in the same unit. A price per piece (`stk`) is comparable only for
  types counted in pieces (`ProductType.unit == "stk"`, i.e. eggs); a Netto variant of any other
  type priced per `stk` has no unit price (`no_price`), so packs of different size are never
  compared per piece.
* Reference kinds: `offer` (current or upcoming competitor offers: Tjek offers of other chains
  and REMA 1000 campaign prices from the Rema catalogue), `regular` (Rema shelf price;
  later other chains), `history` (Netto offers of the same class that ended before this offer
  started; concurrent offers are not history), `ean_reference`
  (Salling originalPrice for the same EAN, when known).
* "Same class" is evaluated in SQL as equal `classification.class_key` with both rows exact,
  which equals `comparability(a, b) == "same"` (`class_key` contains the type, every key
  attribute and the processing state); a test pins this equivalence on real matcher output.
* `deal.references` is a JSON array of
  `{kind, chain_id, listing_id, title, unit_price, unit, valid_from, valid_to, member_only}` –
  **all** same-class references, not only the best, so the web can filter by nearby chains.
* Member prices (`listing.member_only`: Netto+, Coop members, ...): a competitor's member price
  counts as a reference like any other (only more conservative); a Netto member price is shown
  with a "Medlemspris" badge and may only be a `good_deal` when shown as such (below).

Verdict (computed in the web from `deal` + the set of chains near the user, by the pure function
`web/src/lib/verdict.ts`, mirrored by `pipeline/src/foodcatch/deals/verdict.py` and tested on
shared fixtures in `fixtures/verdict_cases.json` at repo root):

* `no_price` – unit price unknown.
* `ambiguous_offer` – `price_applies = false`.
* `not_exact` – the variant has unknown key attributes.
* `no_reference` – no same-class reference from a nearby chain (history counts regardless of distance).
* `good_deal` – `netto_unit_price_worst <= min(reference.unit_price)`; for a member-only Netto
  price only when the caller marks it as a member price (`member_price_marked`), else `undecided`.
* `cheaper_elsewhere` – `netto_unit_price_best > min(reference.unit_price)`.
* `undecided` – otherwise (Netto's pack sizes overlap the cheapest reference).

Both comparisons are made in whole øre (half up): Rema's compare prices are rounded to øre while
Tjek unit prices have four decimals, so an identical price must not count as more expensive.

## 7. Web contract (schema `api`, read-only)

The web app may only read these views (created in Alembic migrations, `GRANT SELECT` to role
`web_readonly`, a NOLOGIN group role). The web connects with a login role created
`IN ROLE web_readonly` (production: `docs/setup.md` §1.3; locally `pnpm db:seed` creates
`foodcatch_web`) and refuses to serve with a login that could write (superuser, CREATEROLE,
CREATEDB or write access to pipeline tables). Column changes are breaking changes for the web.

* `api.stores` – `id, chain_id, chain_name, name, street, zip, city, lat, lon` (Tjek stores, all chains, plus Salling stores).
* `api.current_netto_deals` – one row per (current or upcoming Netto offer listing, latest version of its
  Tjek offer id × healthy classified variant) under the current matcher: `listing_id, variant_index, title, description, price, unit, unit_price_min,
  unit_price_max, valid_from, valid_to, type_id, type_label, group_name, class_key, class_label, attrs,
  is_exact, notes, price_applies, netto_unit_price_worst, netto_unit_price_best, references, member_only`
  (`price_applies` etc. are null until the deal is computed; `references` is then `[]`).
* `api.food_waste_near` – current clearances with healthy classification:
  `listing_id, store_id, chain_id, store_name, street, zip, city, lat, lon, title, ean, price, reference_price,
  discount_pct, unit, unit_price, valid_to, stock, stock_unit, type_label, class_label, is_exact`.
* `api.class_price_history` – `class_key, class_label, kind, chain_id, chain_name, listing_id, title, unit,
  unit_price_min, unit_price_max, valid_from, valid_to, price_applies, member_only` for all classified listings (all
  matcher-current). `price_applies` is the §6 rule (homogeneous offer, unknown range or spread ≤ 25 %);
  the web leaves rows where it is false out of the chart and marks them in the table.
* `api.pipeline_status` – latest run per job: `job, status, started_at, finished_at, stats, error`,
  plus `api.review_queue_summary` – `reason, open_count`.

Location handling: the user's location (address → coordinates via Nominatim, cached; or a default from
`FOODCATCH_DEFAULT_LOCATION`) is resolved server-side in the web app and kept in a cookie. Nearby chains =
chains with a store in `api.stores` within the chosen radius (haversine in SQL).

## 8. Environments and configuration

| Variable | Used by | Purpose |
|---|---|---|
| `DATABASE_URL` | pipeline | owner connection (local: docker compose; prod: Neon) |
| `WEB_DATABASE_URL` | web | read-only role connection |
| `RAW_STORE_URL` | pipeline | `file://./data/raw` locally, `s3://<bucket>/raw` in prod |
| `S3_ENDPOINT_URL`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION` | pipeline | B2 S3 API |
| `SALLING_API_KEY` | pipeline | Salling Group developer API |
| `SALLING_FOOD_WASTE_MAX_CALLS` | pipeline | default 25 – Salling requests per `salling-food-waste` run |
| `REGION_CENTERS` | pipeline | `lat,lon;lat,lon` – where detailed food-waste is kept |
| `REGION_RADIUS_KM` | pipeline | default 30 |
| `HEALTHCHECKS_URL_<JOB>` | pipeline | optional ping URLs per job |
| `SENTRY_DSN` | pipeline | optional |
| `DB_SIZE_BUDGET_MB` | pipeline | default 1024 |
| `OFF_BATCH_SIZE` | pipeline | default 500 – products looked up per `off-enrich` run |
| `QUALITY_DROP_THRESHOLD` | pipeline | default 0.5 – record-count drop that marks a run `degraded` |
| `LOG_LEVEL`, `LOG_FORMAT` | pipeline | `INFO`; `auto` (JSON in CI) \| `json` \| `console` |
| `FOODCATCH_ENV_FILE` | pipeline | explicit `.env` path; empty = load none (tests) |
| `GIT_SHA` / `GITHUB_SHA` | pipeline | commit recorded in `fetch_run.git_sha` (default: `git rev-parse HEAD`) |
| `FOODCATCH_DEFAULT_LOCATION` | web | `lat,lon` default when no cookie |
| `SEED_DATABASE_URL` | web (dev only) | database for `pnpm db:seed` (local hosts only) |

The web app reads its variables from `web/.env.local`, not the repository-root `.env`.

## 9. Testing

* Unit tests for matching use the gold set derived from Salling categories and hand-verified cases
  from the PoC review (`pipeline/tests/matching/`). The gold-set metrics are asserted with
  thresholds so regressions fail CI (precision on staples, zero wrong key attributes, false positives).
* Source modules are tested with recorded (small, trimmed) fixtures and `respx`. Tests never
  reach the network: a session-wide guard fails any non-loopback connection.
* Ingest/deals are tested against a real Postgres (docker compose locally, service container in CI).
* Web: Vitest for `src/lib` (incl. the shared verdict fixtures), typecheck, lint, `next build`.
