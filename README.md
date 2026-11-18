# FoodCatch

FoodCatch finds healthy, minimally processed staple groceries that are **genuinely cheap** near a
given location in Denmark: cheaper than the same product at nearby competitors, than reference
shelf prices, and than its own price history. Trustworthiness of every price claim is the primary
design goal - a deal is only called a deal when the comparison is with *exactly* the same product.

Data comes from public sources: Salling Group's developer API (stores, food-waste clearances),
Tjek/eTilbudsavis (weekly offer catalogues of all major chains), the REMA 1000 product catalogue
and Open Food Facts. See [docs/architecture.md](docs/architecture.md).

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
├── docs/                 architecture, ADRs (docs/decisions/)
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
│   │   └── jobs/         job registry and run lifecycle
│   └── tests/
├── web/                  Next.js app (coming)
├── poc/                  archived proof of concept
└── .github/workflows/    CI (and scheduled collection jobs, coming)
```

## Local development (pipeline)

Requirements: Docker, [uv](https://docs.astral.sh/uv/), Python 3.12 (uv can install it).

```bash
docker compose up -d                  # Postgres 17 on localhost:5432
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
uv run foodcatch reprocess --source tjek --since 2026-11-01
uv run ruff check . && uv run ruff format --check . && uv run pyright
```

Tests need a Postgres server; set `TEST_DATABASE_ADMIN_URL` if it is not the docker compose one
(default `postgresql+psycopg://foodcatch:foodcatch@localhost:5432/postgres`).

## Web app

Coming.

## Operations (Neon, Backblaze B2, scheduled jobs, monitoring)

Coming - see [docs/decisions/0001-free-hosting-stack.md](docs/decisions/0001-free-hosting-stack.md)
for the chosen stack.

## Documentation

* [Architecture](docs/architecture.md) - the contract between all parts
* [Decisions (ADRs)](docs/decisions/)

## License

[MIT](LICENSE)
