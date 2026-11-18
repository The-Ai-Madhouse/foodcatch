# FoodCatch

FoodCatch finds healthy, minimally processed staple groceries that are **genuinely cheap** near a
given location in Denmark: cheaper than the same product at nearby competitors, than reference
shelf prices, and than its own price history. Trustworthiness of every price claim is the primary
design goal - a deal is only called a deal when the comparison is with *exactly* the same product.

Data comes from public sources: Salling Group's developer API (stores, food-waste clearances),
Tjek/eTilbudsavis (weekly offer catalogues of all major chains), the REMA 1000 product catalogue
and Open Food Facts. See [docs/architecture.md](docs/architecture.md) and
[docs/data-sources.md](docs/data-sources.md).

## Architecture

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

* Every API response is stored **unchanged** (gzip) in the raw store before it is parsed, so all
  derived data can be rebuilt (`foodcatch reprocess`, `foodcatch reclassify`).
* Product recognition is versioned; every classification records the matcher version.
* The web app reads only the views in schema `api`.

## Repository layout

```
foodcatch/
├── docs/                 architecture, setup, data sources, runbook, ADRs (docs/decisions/)
├── fixtures/             test fixtures shared by pipeline and web (verdict cases)
├── pipeline/             Python 3.12 package `foodcatch` (uv)
│   ├── src/foodcatch/
│   │   ├── config.py     settings from environment / .env
│   │   ├── cli.py        `foodcatch ...` commands
│   │   ├── http.py       shared HTTP client (User-Agent, throttling, retries)
│   │   ├── storage/      raw store (local directory or S3/B2)
│   │   ├── db/           tables, engine, Alembic migrations (incl. `api` views)
│   │   ├── sources/      one module per external API (validated responses)
│   │   ├── ingest/       raw payload → normalized rows
│   │   ├── matching/     product recognition
│   │   ├── deals/        reference prices and verdicts
│   │   └── jobs/         job registry, run lifecycle, post-fetch hooks
│   └── tests/
├── web/                  Next.js app (Danish UI), reads only the `api` views
├── poc/                  archived proof of concept
└── .github/workflows/    ci.yml, collect.yml (scheduled jobs), db-migrate.yml, keepalive.yml
```

## Local development (pipeline)

Requirements: Docker, [uv](https://docs.astral.sh/uv/), Python 3.12 (uv can install it).

```bash
docker compose up -d                  # Postgres 17 on 127.0.0.1:5432 (loopback only)
cp .env.example .env                  # then fill in SALLING_API_KEY if you have one
cd pipeline
uv sync                               # create .venv with all dependencies
uv run foodcatch db upgrade           # create tables, seed data and `api` views
uv run pytest                         # tests create and drop their own database
```

Useful commands:

```bash
uv run foodcatch jobs list            # registered collection jobs
uv run foodcatch collect <job>        # run one job (e.g. tjek-offers)
uv run foodcatch db stats             # table sizes vs. the database budget
uv run foodcatch reprocess --source tjek --since 2026-11-01 --until 2026-11-15
uv run foodcatch reclassify           # re-run recognition for all listings, recompute deals
uv run foodcatch review list          # doubtful classifications; `review resolve ID --status ...`
uv run foodcatch raw reindex --dry-run  # rebuild raw_object rows from the raw store
uv run ruff check . && uv run ruff format --check . && uv run pyright
```

Tests need a Postgres server; set `TEST_DATABASE_ADMIN_URL` if it is not the docker compose one
(default `postgresql+psycopg://foodcatch:foodcatch@localhost:5432/postgres`). They never reach
the network: external APIs are mocked with `respx`, and a guard fails any other connection.

## Web app

A Next.js app with a Danish UI: this week's genuinely cheap Netto offers on healthy staples with a
verdict for your location, food-waste clearances nearby, price history per product and pipeline
health. It reads only the read-only views in schema `api` and runs locally for now
([ADR 0003](docs/decisions/0003-local-only-web.md)). Requirements: Node 24+ and pnpm 10.

```bash
cd web
pnpm install
pnpm db:seed          # sample data in a local dev database + read-only login `foodcatch_web`
pnpm dev              # http://localhost:3000
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

The app reads `WEB_DATABASE_URL` and `FOODCATCH_DEFAULT_LOCATION` from `web/.env.local`. Setup,
seed data and scripts: [web/README.md](web/README.md).

## Operations (Neon, Backblaze B2, scheduled jobs, monitoring)

Production runs on free tiers ([ADR 0001](docs/decisions/0001-free-hosting-stack.md)): GitHub
Actions runs the jobs, Neon hosts Postgres, Backblaze B2 keeps the raw payloads, healthchecks.io
alerts when a job fails or does not report, Sentry is optional.

* `.github/workflows/collect.yml` runs all six collection jobs on their schedules
  (architecture §4). Run one by hand with `gh workflow run collect.yml -f job=<job>` (add
  `-f accept_drop=true` to accept a genuine record-count drop as the new baseline). Pause
  scheduled runs of a job with the repository variable `COLLECT_PAUSED_JOBS`.
* `.github/workflows/db-migrate.yml` applies migrations to production on push to `main` when
  migrations change, and on demand.
* `.github/workflows/keepalive.yml` keeps the scheduled workflows from being disabled after 60
  days without repository activity.

Guides:

* [docs/setup.md](docs/setup.md) - first-time production setup: Neon (including the read-only
  web login role), B2, the Salling key, GitHub secrets and variables, healthchecks.io, Sentry.
* [docs/runbook.md](docs/runbook.md) - failed and degraded jobs, reprocessing, matcher upgrades,
  the review queue, schema migrations, database size, backups and restore, known limitations.
* [docs/data-sources.md](docs/data-sources.md) - what each source provides, limits and caveats.

## Documentation

* [Architecture](docs/architecture.md) - the contract between all parts
* [Production setup](docs/setup.md), [runbook](docs/runbook.md),
  [data sources](docs/data-sources.md), [web app](web/README.md)
* [Decisions (ADRs)](docs/decisions/)

## License

[MIT](LICENSE)
