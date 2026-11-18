# FoodCatch web

The Danish web app of FoodCatch: this week's genuinely cheap healthy staples near you, food-waste
clearances, price history per product and pipeline health. Next.js (App Router, TypeScript strict),
Tailwind CSS, Vitest. The app runs locally only for now (see
[ADR 0003](../docs/decisions/0003-local-only-web.md)).

| Route              | Shows                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/`                | "Tilbud": this week's Netto offers on healthy staples, one card per offer with where to buy, pack size, verdict and source link (`?vis=alle` for all)        |
| `/madspild`        | "Madspild": clearances within your radius grouped by store, nearest first (`?sorter=rabat` for one list by discount)                                         |
| `/kort`            | "Kort": every nearby store on a map, coloured by chain; a store shows its food waste or what is cheaper there than in Netto (`?kaede=netto,lidl&butik={id}`) |
| `/vare/[classKey]` | Price history of one product (chart and a list with source links)                                                                                            |
| `/status`          | "Datastatus": freshness of every pipeline job and the review queue (footer link)                                                                             |

The design is specified in [docs/ui.md](../docs/ui.md). Phones are the primary target (bottom tab
bar, full-screen map); from 1024 px `/` and `/madspild` show a map column next to the list.

## How it fits together

- The app reads **only** the read-only views in schema `api` (architecture §7) through
  `src/server/db.ts` (the `postgres` package, `WEB_DATABASE_URL`). The boundary is the read-only
  login role: on its first query the app checks the login and refuses to serve if it is a
  superuser, can create roles or databases, or can write pipeline tables (e.g. the owner URL
  copied by mistake). Sessions are also opened with `default_transaction_read_only`, which only
  guards against accidental writes (defence in depth).
- `src/lib/` holds pure, unit-tested logic. `src/lib/verdict.ts` mirrors architecture §6 and the
  pipeline's `deals/verdict.py`; both are tested against the shared
  [`fixtures/verdict_cases.json`](../fixtures/verdict_cases.json).
- The user's location (address → coordinates via Nominatim, cached in memory and throttled to
  one request per second, or the browser's position via "Brug min position") and radius (1–5 km)
  are kept in an HTTP-only cookie for a year (renewed on every save) and saved under the text the
  user typed. The client keeps a backup in `localStorage` (`foodcatch.location.v1`) and restores
  the cookie from it when the cookie is gone; "Glem" removes both. Without either the app uses
  `FOODCATCH_DEFAULT_LOCATION` (`lat,lon`; default Rådhuspladsen, Copenhagen).
- Nearby stores are the rows of `api.stores` within the radius (haversine in SQL), one per
  physical store (`lib/stores.ts`: Salling rows for Netto, føtex and Bilka, Tjek rows otherwise).
  The verdict of each deal is computed per request from the deal's references and the chains of
  those stores.
- Source links (`lib/sources.ts`) use only URL templates verified in docs/ui.md §1.1:
  eTilbudsavis offers and store pages, REMA 1000 product pages and Open Food Facts products.
  Salling food waste has no product page, so none is invented.
- The map (`components/map/StoreMap.tsx`) is MapLibre GL with OpenFreeMap vector tiles: no API
  key, no cookies, attribution always visible. It is loaded on the client only, and only on pages
  that show a map. MapLibre's worker is served from `/maplibre-worker.mjs` (a static route that
  copies it from `node_modules`), because the bundled module cannot find it next to itself.
- Product photos of clearances are plain `<img>` requests to Salling's image CDN (not the Salling
  API, so they do not use its quota).

## Development

Requirements: Node 24+, pnpm 10, the local Postgres from the repository's `docker compose`, and
`uv` for the pipeline migrations.

```sh
pnpm install

# 1. A separate development database with the pipeline schema (once).
createdb -h localhost -U foodcatch foodcatch_web_dev   # or: docker compose exec postgres createdb -U foodcatch foodcatch_web_dev
(cd ../pipeline && DATABASE_URL=postgresql+psycopg://foodcatch:foodcatch@localhost:5432/foodcatch_web_dev \
  uv run foodcatch db upgrade)

# 2. Sample data (re-run any time; dates are relative to today).
pnpm db:seed

# 3. Configuration, e.g. in web/.env.local (git-ignored):
#    WEB_DATABASE_URL=postgres://foodcatch_web:foodcatch_web@localhost:5432/foodcatch_web_dev
#    FOODCATCH_DEFAULT_LOCATION=55.6761,12.5683

pnpm dev            # http://localhost:3000 (listens on 127.0.0.1 only, like `pnpm start`)
```

### Seed data

`pnpm db:seed` runs [`scripts/seed-dev.sql`](scripts/seed-dev.sql) against
`SEED_DATABASE_URL` (default `postgres://foodcatch:foodcatch@localhost:5432/foodcatch_web_dev`).
It **truncates all data tables** first and refuses non-local hosts unless `--allow-remote` is
passed. It inserts:

- stores of eleven chains around Rådhuspladsen – some within 2 km, some between 2 and 5 km, so
  changing the radius changes verdicts (e.g. MENY's cheaper minced beef at 3.1 km);
- one week of Netto offers covering every verdict: _Godt køb_ (hakket grisekød 8-12 % at
  33,33 kr./kg, frilandsæg, letmælk as a _Medlemspris (Netto+)_, Danbo, smør), _Uafklaret_ (hakket oksekød 14-18 %),
  _Billigere andetsteds_, _Ingen sammenligning_, _Ukendt egenskab_, _Flere varer i tilbuddet_,
  _Ingen kilopris_ and an upcoming offer that is not computed yet;
- competitor offers, REMA 1000 shelf prices and earlier Netto offers (price history);
- food-waste clearances in Netto and føtex nearby (plus one unhealthy and one distant item that
  must not show), with Salling product images, one placeholder image (shown as no image), one
  item without an image, one sold by weight (no size) and one without an Open Food Facts size;
- pipeline runs with one failed and one degraded job, and open review items.

The seed also creates a local login role `foodcatch_web` (password `foodcatch_web`, member of the
migration's `web_readonly` role) so the app can be run exactly as in production: it can read the
`api` views and nothing else. These are development-only credentials.

## Scripts

| Script                      | Purpose                                         |
| --------------------------- | ----------------------------------------------- |
| `pnpm dev`                  | development server                              |
| `pnpm build` / `pnpm start` | production build / server                       |
| `pnpm lint`                 | ESLint (no warnings allowed) and Prettier check |
| `pnpm typecheck`            | route type generation and `tsc --noEmit`        |
| `pnpm test`                 | Vitest unit tests for `src/lib`                 |
| `pnpm format`               | Prettier write                                  |
| `pnpm e2e`                  | Playwright end-to-end tests (local only, below) |
| `pnpm db:seed`              | load the development seed                       |

Pages never touch the database at build time, so `pnpm build` works without one.

## End-to-end tests

`pnpm e2e` runs Playwright (`e2e/`) in the installed Google Chrome (`channel: "chrome"`) at
390×844 and 1440×900: the location survives reloads and is restored from `localStorage` without
the cookie, "Brug min position" saves a (faked) browser position, cards show the store and pack
size and link to the leaflet, the map renders markers with attribution, a clearance shows its
store, weight and source, and no page scrolls sideways on a phone. No test geocodes an address,
so Nominatim is never called.

They need a database with real data (`WEB_DATABASE_URL` in `.env.local`) and reuse a running
`pnpm dev` on port 3000 (or start one); set `E2E_BASE_URL` to test another server, e.g.
`pnpm build && pnpm start -p 3100` and `E2E_BASE_URL=http://127.0.0.1:3100 pnpm e2e`. They are
**local only**: CI has neither a database with data nor Chrome, so they are not part of the CI
workflow.
