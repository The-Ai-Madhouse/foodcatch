# FoodCatch web

The Danish web app of FoodCatch: this week's genuinely cheap healthy staples near you, food-waste
clearances, price history per product and pipeline health. Next.js (App Router, TypeScript strict),
Tailwind CSS, Vitest. The app runs locally only for now (see
[ADR 0003](../docs/decisions/0003-local-only-web.md)).

| Route              | Shows                                                                       |
| ------------------ | --------------------------------------------------------------------------- |
| `/`                | Netto offers on healthy staples with a verdict for your location and radius |
| `/madspild`        | Food-waste clearances within your radius, largest discount first            |
| `/vare/[classKey]` | Price history of one product class (SVG chart and table)                    |
| `/status`          | Freshness and health of every pipeline job and the review queue             |

## How it fits together

- The app reads **only** the read-only views in schema `api` (architecture §7) through
  `src/server/db.ts` (the `postgres` package, `WEB_DATABASE_URL`). Sessions are opened with
  `default_transaction_read_only`, so the app cannot write even with an owner connection.
- `src/lib/` holds pure, unit-tested logic. `src/lib/verdict.ts` mirrors architecture §6 and the
  pipeline's `deals/verdict.py`; both are tested against the shared
  [`fixtures/verdict_cases.json`](../fixtures/verdict_cases.json).
- The user's location (address → coordinates via Nominatim, cached in memory and throttled to
  one request per second) and radius (1–5 km) are kept in an HTTP-only cookie. Without a cookie the
  app uses `FOODCATCH_DEFAULT_LOCATION` (`lat,lon`; default Rådhuspladsen, Copenhagen).
- Nearby chains are the chains with a store in `api.stores` within the radius (haversine in SQL).
  The verdict of each deal is computed per request from the deal's references and those chains.

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

pnpm dev            # http://localhost:3000
```

### Seed data

`pnpm db:seed` runs [`scripts/seed-dev.sql`](scripts/seed-dev.sql) against
`SEED_DATABASE_URL` (default `postgres://foodcatch:foodcatch@localhost:5432/foodcatch_web_dev`).
It **truncates all data tables** first and refuses non-local hosts unless `--allow-remote` is
passed. It inserts:

- stores of eleven chains around Rådhuspladsen – some within 2 km, some between 2 and 5 km, so
  changing the radius changes verdicts (e.g. MENY's cheaper minced beef at 3.1 km);
- one week of Netto offers covering every verdict: _Godt køb_ (hakket grisekød 8-12 % at
  33,33 kr./kg, frilandsæg, letmælk, Danbo, smør), _Uafklaret_ (hakket oksekød 14-18 %),
  _Billigere andetsteds_, _Ingen sammenligning_, _Ukendt egenskab_, _Flere varer i tilbuddet_,
  _Ingen kilopris_ and an upcoming offer that is not computed yet;
- competitor offers, REMA 1000 shelf prices and earlier Netto offers (price history);
- food-waste clearances in Netto and føtex nearby (plus one unhealthy and one distant item that
  must not show);
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
| `pnpm db:seed`              | load the development seed                       |

Pages never touch the database at build time, so `pnpm build` works without one.
