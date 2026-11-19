# Runbook

How to operate FoodCatch in production: what to do when a job fails or degrades, how to
rebuild derived data, how to change the schema safely, how to restore, and how to keep the
database small. Setting things up the first time is covered in [setup](setup.md); the sources and
their quirks are in [data sources](data-sources.md).

**Price history cannot be re-fetched.** Tjek lists only current leaflets, and food-waste data
changes by the hour. A job that does not run loses that day's data permanently. Fix a broken
daily job the same day.

---

## 1. Where to look

| Signal | Where | Means |
|---|---|---|
| healthchecks.io email "down" | healthchecks.io | a job failed, degraded, or did not report within its grace time |
| failed workflow email | GitHub (to whoever last changed the cron in `collect.yml`) | the workflow failed, including setup failures before the pipeline started |
| run summary | Actions → `collect` → run → *Summary* | `succeeded`, `degraded (…)` or `failed (exit N)` |
| logs | Actions → run → job `<job>` → step *Collect* | JSON lines: `job.started`, `http.retry`, `job.degraded`, `job.failed` (with traceback); Salling food waste: `salling.geo_call`, `salling.quota_exhausted`, `salling.food_waste_collected` |
| run history | `api.pipeline_status` (Neon SQL editor), or `/status` in the web app | latest run per job with `stats` and `error` |
| all runs | `SELECT job, status, started_at, stats, error FROM fetch_run ORDER BY started_at DESC LIMIT 50;` | |
| stack traces | Sentry (if `SENTRY_DSN` is set) | grouped exceptions per release (commit SHA) |

`foodcatch collect` exit codes: `0` succeeded, `1` failed, `2` usage error (e.g. unknown job),
`3` degraded.

### Production shell

Some procedures below run the CLI on your laptop against production. Create a git-ignored
`.env.production` at the repository root (`.env.*` is ignored) with the production values:

```
DATABASE_URL=postgresql+psycopg://neondb_owner:…@ep-…eu-central-1.aws.neon.tech/neondb?sslmode=require
RAW_STORE_URL=s3://<bucket>/raw
S3_ENDPOINT_URL=https://s3.eu-central-003.backblazeb2.com
S3_REGION=eu-central-003
S3_ACCESS_KEY_ID=…
S3_SECRET_ACCESS_KEY=…
REGION_CENTERS=55.68,12.57
```

Leave `HEALTHCHECKS_URL_*` and `SENTRY_DSN` out: manual runs must not ping the production checks.
Then run commands with:

```bash
cd pipeline
FOODCATCH_ENV_FILE=../.env.production uv run foodcatch db stats
```

Before anything that writes (reprocess, reclassify, migrations, deletes), pause the scheduled
jobs that touch the same data (§3.4) and check that no collect run is active
(`gh run list --workflow collect.yml --status in_progress`). A collect run keeps one transaction
open for its whole duration.

---

## 2. A job failed

1. Open the failed run and read the last error in the *Collect* step (or the first failing
   step). The `fetch_run.error` column has the same message.
2. Find the cause in the table and fix it.
3. Re-run the job by hand: `gh workflow run collect.yml -f job=<job>`. A rerun is always safe:
   ingest is idempotent, and raw objects of the failed run stay in B2 for provenance.
4. Check that healthchecks.io is green again.

| Symptom (log / error) | Likely cause | What to do |
|---|---|---|
| `Missing secret …` / `Missing variable …` (before `foodcatch` starts) | configuration not set or renamed | set it ([setup](setup.md) §4) |
| `SourceHTTPError: HTTP 401/403 from https://api.sallinggroup.com/…` | Salling key revoked, expired or out of scope | create a new key, `gh secret set SALLING_API_KEY` |
| `HTTP 429` after retries | rate limit hit despite throttling | rerun later; if it repeats, lower the host rate in `foodcatch/http.py` (`HOST_RATES_PER_SECOND`). Salling: see §3.5 (the quota is shared by both Salling jobs) |
| `HTTP 5xx` after 5 attempts, or `ConnectError` / timeouts | source outage | rerun later; nothing to fix if the next scheduled run succeeds |
| `SourceSchemaError: <endpoint>: response … does not match the expected schema` | **the API changed** (common for unofficial sources) | see §2.1 |
| `TjekPaginationLimitError` | a Tjek query reached the 1,000-result cap | narrow the query in `sources/tjek.py` (e.g. by region with `r_lat`/`r_lng`/`r_radius`) |
| `TjekJobError: all N dealers failed` | Tjek unreachable or blocking us | check by hand (§2.1); if the API is gone for good, record it in an ADR and pause the job |
| `OperationalError` / `could not connect` to Neon | Neon outage, compute-hours quota used up, or password changed | Neon console → project status and *Usage*; update `DATABASE_URL` if the password changed |
| `could not extend file` / `project size limit exceeded` | Neon storage full | §6 now |
| `RawStoreError` / `botocore` `AccessDenied` / `InvalidAccessKeyId` | B2 key deleted, expired or restricted to another prefix | new B2 application key ([setup](setup.md) §2.2), update `S3_*` secrets |
| step timed out after 45 minutes | source extremely slow (long `Retry-After`) or a hang | rerun; if it repeats, check the `http.retry` lines for the host |
| `relation … does not exist` / `column … does not exist` | code is newer than the production schema | run `db-migrate` (§5) |

### 2.1 A source changed its format

Responses that fail validation are **not** stored (we never store data we could not validate),
so reproduce the request by hand with the same parameters (they are in the error and in earlier
`raw_object.params`):

```bash
curl -s -A "foodcatch/0.1.0 (+https://github.com/toke-dk/foodcatch)" \
  "https://squid-api.tjek.com/v2/offers?catalog_ids=<id>&limit=100&offset=0" | jq '.[0]'
```

For Salling, add `-H "Authorization: Bearer $SALLING_API_KEY"` from your local `.env`, and never
paste the key into an issue or a log.

Then:

1. Record a new, trimmed fixture under `pipeline/tests/fixtures/<source>/`, with no keys or
   auth headers in it.
2. Adapt the pydantic models in `pipeline/src/foodcatch/sources/<source>.py` and the ingest
   module, plus their tests. Keep the models strict about fields we use.
3. Merge, then rerun the job by hand. The days in between are lost for that source, so this is
   a same-day fix.

---

## 3. A job is degraded

`degraded` means the run **succeeded and its data was committed**, but its quality metric
(`records` by default; `current_listings` for `tjek-offers`, §3.6; `region_clearances` for
`salling-food-waste`) dropped by more than
`QUALITY_DROP_THRESHOLD` (default 50 %) compared with the **previous succeeded run** of the same
job, or the job reported itself incomplete (`salling-food-waste`: the region was not fully
covered, §3.5). The run exits with code 3, the workflow is
marked failed and healthchecks.io gets `/fail`. The reason is in `fetch_run.error`, and
`stats.quality` has the numbers.

### 3.1 Decide whether the drop is real

| Job | Normal reasons for a drop | Suspicious reasons |
|---|---|---|
| `tjek-offers` | holiday weeks, a chain publishing late, fewer current or upcoming catalogs on the day | several chains with `dealer_errors`/`catalog_errors` in `stats`; offers parsed but skipped; `catalogs_seen` far below the previous run |
| `salling-food-waste` | Sunday or holiday (fewer clearances in the region); the 13:37 run compared with 05:37; `region not fully covered` because the quota ran out (§3.5) | `geo_calls_failed` in `stats`; `region_stores_covered` far below `region_stores` on a run without `quota_exhausted` |
| `rema-products`, `*-stores` | assortment or store-list changes (small) | anything above 10 % |
| `off-enrich` | few new EANs that day (expected to vary a lot) | – |

Compare the stats of recent runs:

```sql
SELECT started_at, status, stats->'quality' AS quality, stats->'catalogs_seen' AS catalogs,
       stats->'catalog_errors' AS catalog_errors, stats->'dealer_errors' AS dealer_errors, error
FROM fetch_run WHERE job = 'tjek-offers' ORDER BY started_at DESC LIMIT 14;
```

### 3.2 If the drop is genuine (the source really has less data)

Every following run is compared with the last *succeeded* run, so it keeps degrading until a
run succeeds. Accept the new level once:

```bash
gh workflow run collect.yml -f job=<job> -f accept_drop=true
```

This sets `QUALITY_DROP_THRESHOLD=1` for that run only. It succeeds and becomes the new
baseline. It does not override a run that reported itself incomplete (`salling-food-waste`
whose region was not fully covered, §3.5).

### 3.3 If the drop is a bug

Treat it as a failure (§2). Data from the degraded run is already in the database, which is
fine: once the bug is fixed, a normal run or a reprocess (§4.1) upserts the correct rows.

### 3.4 Pausing a job

To stop a broken job from alerting while you fix it, set the repository variable
`COLLECT_PAUSED_JOBS` (space- or comma-separated job names):

```bash
gh variable set COLLECT_PAUSED_JOBS --body "tjek-offers"
gh variable delete COLLECT_PAUSED_JOBS   # resume
```

Paused jobs skip only their scheduled runs; `gh workflow run` still runs them. Pause the
matching healthchecks.io check too (**Pause** on the check), or it reports the missing pings.
Remember that every skipped day of a daily job is lost data.

To see what is paused: `gh variable get COLLECT_PAUSED_JOBS`. To resume one job while others
stay paused, set the variable to the remaining names; delete it when nothing is paused. Resume
the healthchecks.io check at the same time.

### 3.5 Salling food waste: request budget and quota

The Salling key gets HTTP 429 for a long period after about 60 requests
([data sources](data-sources.md#salling-group), [ADR 0005](decisions/0005-salling-geo-tiling.md)).
`salling-food-waste` makes at most `SALLING_FOOD_WASTE_MAX_CALLS` requests per run (default 25),
covers the region first and the rest of Denmark in rotation, and stops at the first 429 without
retrying. Read a run's `stats`:

| Stat | Meaning |
|---|---|
| `salling_calls` / `call_budget` | requests made / allowed in this run |
| `region_stores`, `region_stores_covered` | region stores known / covered (equal on a good run) |
| `national_stores`, `national_stores_covered` | stores outside the region / covered by this run (rotation) |
| `stores_inferred_absent` | known stores counted as covered although absent from the answers (unknown to the food-waste service) |
| `region_clearances` | the quality metric |
| `quota_exhausted` | a 429 stopped the run (the log line `salling.quota_exhausted` has `retry_after`) |
| `budget_exhausted` | the budget ran out before every store was covered (normal: the rotation continues next run) |
| `geo_calls_failed` | requests that failed for other reasons (each target is retried once; 3 failures stop the run) |

**Tuning the budget.** Set the repository variable (or `.env` locally):

```bash
gh variable set SALLING_FOOD_WASTE_MAX_CALLS --body 25
```

* Raise it if runs end with `budget_exhausted` before the region is covered (the region grew), or
  to cover the country faster - but only once you know the quota: two runs a day plus the weekly
  `salling-stores` (~9 requests, Monday 03:17) must stay below it. The first `quota_exhausted`
  run tells you the 429's `Retry-After`; if it shows an hourly window, the runs 8 hours apart can
  each use close to the full quota.
* Lower it if runs hit `quota_exhausted`, or shrink the region (`REGION_RADIUS_KM`) - the
  default region needs about 23 requests (simulated: 15 km ~16, 20 km ~19, 25 km ~21).
* What the budget buys (simulated): with 25 the region takes ~23 requests and the rest of
  Denmark is fully covered about every 10 days; with 35, about every 2 days.
* A manual `gh workflow run collect.yml -f job=salling-food-waste` spends the same quota as a
  scheduled run: do not dispatch it shortly before 05:37, 13:37 or a Monday `salling-stores`.

**Resuming the job after the redesign** (one time; it was paused while the per-store version
burned the quota):

1. Merge the change. The push runs `db-migrate`, which adds `store.food_waste_checked_at`
   (migration 0003); check that it succeeded (`gh run list --workflow db-migrate.yml --limit 1`).
   The new job fails on a database without that column.
2. Remove `salling-food-waste` from `COLLECT_PAUSED_JOBS` (§3.4):

   ```bash
   gh variable get COLLECT_PAUSED_JOBS                 # what is paused now
   gh variable delete COLLECT_PAUSED_JOBS              # if it was the only paused job
   gh variable set COLLECT_PAUSED_JOBS --body "<rest>" # otherwise: the remaining names
   ```

3. Resume its healthchecks.io check. Optionally run it once by hand, at least an hour after the
   last Salling request (`gh workflow run collect.yml -f job=salling-food-waste`), and read its
   `stats` as above. The first run has no `region_clearances` baseline, so it cannot degrade on
   the quality check.

**After a 429** nothing has to be done: the next scheduled run starts with the region again,
and the rotation continues where it stopped (`store.food_waste_checked_at`). If every run hits
429, pause the job (§3.4), wait for the quota to recover (at least an hour), lower the budget and
resume.

### 3.6 Tjek offers: skipped catalogs and a full refresh

`tjek-offers` fetches every dealer's catalog list on each run, but the offer pages of a catalog
only when it is new, its fingerprint changed, or its last full fetch is `TJEK_FULL_REFRESH_DAYS`
(default 3) days old ([architecture §4](architecture.md#4-data-flow-and-job-design), "Tjek
request volume"). A run's `stats`:

| Stat | Meaning |
|---|---|
| `catalogs_seen` | current or upcoming food catalogs in the catalog lists |
| `catalogs_fetched` | catalogs whose offers were fetched; split into `catalogs_fetched_new`, `_changed`, `_refresh` |
| `catalogs_skipped_unchanged` | catalogs whose offers were not fetched (their listings stay as they are) |
| `offer_pages_fetched` | offer requests made (plus one catalog request per dealer) |
| `current_listings` | the quality metric: Tjek listings still valid after the run, of the catalogs seen |
| `records` | offers parsed in this run; small or 0 on days that skip most catalogs - normal |

**Forcing a full refresh** (every offer page of every current catalog, as before the change),
e.g. after fixing a Tjek ingest bug or when a leaflet changed without its fingerprint changing:

```bash
gh workflow run collect.yml -f job=tjek-offers -f tjek_full_refresh=true    # production
TJEK_FULL_REFRESH_DAYS=0 uv run foodcatch collect tjek-offers               # locally
```

To refresh every catalog permanently more or less often, set the repository variable
(`gh variable set TJEK_FULL_REFRESH_DAYS --body 2`; `0` = every run). Deleting the rows of
`tjek_catalog_fetch` (all, or one `catalog_id`) makes the next scheduled run fetch those catalogs
in full. A full refresh costs about 110 requests (~20 MB); avoid repeating it on the same day.

The first run after migration 0009 (`tjek_catalog_fetch`) fetches every catalog, as the table is
empty, and cannot degrade: earlier runs have no `current_listings` to compare with. The job fails
on a database without the table, so the migration must be applied first (§5 rule 2).

---

## 4. Rebuilding derived data

Normalized rows, classifications and deals are derived from the raw store
([ADR 0002](decisions/0002-raw-first-pipeline.md)). All commands below run in the production
shell (§1).

### 4.1 Reprocess from raw (after an ingest fix)

```bash
FOODCATCH_ENV_FILE=../.env.production uv run foodcatch reprocess --source tjek --since 2026-11-01
```

* Replays the `raw_object`s of one source (`salling`, `tjek`, `rema`, `openfoodfacts`) fetched on
  or after `--since` (UTC date), in fetch order, through ingest, classification and deals.
  The sha256 of each body is verified against its `raw_object` row.
* Ingest is idempotent: rows are upserted on their natural keys, so replaying never duplicates.
  Listings that the fixed code no longer produces are **not** deleted; remove them by hand if the
  bug created wrong rows (find them by `raw_object_id` or `first_seen_at`).
* Run-level steps are replayed per fetch run too: after the last object of each finished
  `rema-products` run, products that left a complete catalogue are closed again at that run's
  `started_at`, exactly as live (`rema_listings_closed_vanished` in the output).
* Everything runs in **one transaction**. A long range downloads many objects from B2 and holds
  the transaction open; pause the source's jobs first and split long replays into consecutive
  ranges with `--until` (exclusive), each of which commits on its own:

  ```bash
  uv run foodcatch reprocess --source tjek --since 2026-11-01 --until 2026-11-15
  uv run foodcatch reprocess --source tjek --since 2026-11-15
  ```

  **For `rema` and `tjek` the last range must reach the present** (no `--until`), and the jobs
  stay paused until it has run: their ingest closes superseded prices as of each payload, so a
  replay that stops in the past leaves that window's prices as the current ones (the CLI warns).
  The next range or live run restores the latest state.
* Free B2 downloads are 3× the stored data per month (setup §9), which is plenty for occasional
  reprocessing.

To widen the food-waste region (`REGION_CENTERS`, `REGION_RADIUS_KM`) retroactively, change the
variables, then reprocess `salling` with the same values in `.env.production`.

### 4.2 Reclassify after matcher changes

Product recognition is versioned (`MATCHER_VERSION` in `pipeline/src/foodcatch/matching/`).
After merging a matcher change that bumps the version, nothing has to be done by hand:

1. The first collect run with post-fetch hooks (`tjek-offers`, `rema-products`,
   `salling-food-waste`) classifies **every** listing with the new version (listings remember
   the version they were last classified with in `listing.classified_version`), so that run takes
   longer than usual.
2. In the same transaction it makes the new version the current `matcher_release`, prunes
   classifications of all but the two most recent versions and recomputes **all** deals (like
   `reclassify`; a rollback to a kept older version reports few listings as changed, so a
   scoped recompute would leave most offers without a deal). The run's `stats` show
   `matcher_promoted: 1` and the log has a
   `matcher.promoted` warning. The `api` views switch to the new version when that run commits.

To switch immediately instead of waiting for the next scheduled run (or after an override
change, see §4.3), run in the production shell:

```bash
FOODCATCH_ENV_FILE=../.env.production uv run foodcatch reclassify
```

`reclassify` re-runs recognition for all listings with the code's version, makes it current and
recomputes all deals (`foodcatch deals recompute` recomputes deals alone). Run it outside the
collect schedule (the early afternoon UTC is free except for 13:37). Rolling back the code to
an older version works the same way: the older version becomes current again on the next run.

Afterwards check the review queue (§4.3).

### 4.3 Review queue

Recognition queues doubtful listings in `review_item` (`api.review_queue_summary` counts the
open ones; `/status` in the web app shows them):

```bash
uv run foodcatch review list                                  # open items, oldest first
uv run foodcatch review list --reason unknown_key_attribute --limit 20
uv run foodcatch review resolve 123 --status accepted --note "fat % only on the picture"
uv run foodcatch review list --status accepted                # resolved items with notes
```

`--status` is `accepted` (the result is right as it is), `rejected` (the listing is not what the
rule thought; add a `classification_override` with action `reject` so it stays out) or `fixed`
(a rule or override now handles it). Resolved items are never reopened; open items whose reason
disappears on re-classification are closed as `fixed` automatically.

An override (`classification_override`: `source`, normalized title, `action` `reject` or
`force` with a `forced_result` such as `{"type_id": "mælk", "attrs": {"mælketype": "letmælk",
"øko": "nej", "laktosefri": "nej"}}`) takes effect for listings classified afterwards; run
`foodcatch reclassify` to apply it to existing listings.

---

## 5. Schema migrations

Migrations live in `pipeline/src/foodcatch/db/migrations/versions/` and are applied to
production by the `db-migrate` workflow: automatically on a push to `main` that changes a
migration, or by hand (`gh workflow run db-migrate.yml`). The run ends with `foodcatch db stats`.

GitHub concurrency groups cannot span workflows, so `collect` and `db-migrate` cannot share one.
The workflows approximate mutual exclusion: `db-migrate` waits until no **earlier** `collect` run
is active (up to 30 minutes), and `collect` waits while an **earlier** migration runs (up to 20
minutes). Neither waits for runs created after it, so they never wait for each other. This is
best effort (it relies on the GitHub API), so these operational rules apply:

1. **Migrations are backwards compatible (expand, then contract).** A migration must work with
   the code currently on `main`, because a scheduled run may start right after it:
   * add columns as nullable or with a default; add tables and views freely;
   * rename or drop a column in two releases: first add the new one and switch the code (both
     work), later drop the old one in a separate migration;
   * changing an `api` view's columns is a breaking change for the web (architecture §7).
2. **Merge the migration before (or together with) the code that needs it**, never after. A
   push that changes a migration triggers `db-migrate`; the code that relies on it runs at the
   next schedule.
3. **Do not merge migrations just before a scheduled run** (see the times in architecture §4).
   The quiet windows are 06:30–13:30 and 14:00–02:00 UTC.
4. **Long-running migrations** (rewriting a large table, building an index) need the jobs paused
   (§3.4). Use `CREATE INDEX CONCURRENTLY` in its own non-transactional migration where
   possible.
5. **Never run `foodcatch db upgrade` against production from a laptop** while workflows are
   active. Use the workflow, which runs the same command with the same code as the jobs.
6. **Migration 0008** (all-chain deals, `listing.product_key`) rewrites `listing` once to add
   the generated column (seconds at current volumes; merge it in a quiet window) and marks
   Lidl "Fast lav pris" listings `regular`. Afterwards run `foodcatch deals recompute` once
   (production shell, §1): job runs only recompute the deals of changed listings, so the other
   chains' deals would otherwise appear gradually.
7. **Downgrades** are a manual emergency procedure: pause all jobs, then in the production shell
   `uv run foodcatch db downgrade --revision -1`, revert the code on `main`, resume. Restoring
   from a Neon branch (§7.1) is often simpler.

---

## 6. Database size

Neon's free plan allows 1 GB per project (check the current limit on Neon's pricing page and set
`DB_SIZE_BUDGET_MB` to match). Every run records `db_size_mb` in `fetch_run.stats` and logs
`db.size_budget` and sets `db_size_warning` above 70 % of `DB_SIZE_BUDGET_MB`.

```bash
FOODCATCH_ENV_FILE=../.env.production uv run foodcatch db stats   # sizes per table and budget use
```

```sql
SELECT started_at::date, stats->'db_size_mb' FROM fetch_run
WHERE job = 'salling-food-waste' ORDER BY started_at DESC LIMIT 30;   -- growth per day
```

Levers, from least to most invasive:

1. **Old classifications** are pruned automatically (two most recent matcher versions kept).
   A new matcher version prunes them when it becomes current (§4.2).
2. **Shrink the food-waste region**: lower `REGION_RADIUS_KM` or remove a `REGION_CENTERS` entry.
   This affects new runs only. Clearance listings are the fastest-growing table.
3. **Delete expired food-waste listings.** They are only shown while current, and they can be
   rebuilt from B2 by reprocessing. With jobs paused:

   ```sql
   DELETE FROM listing
   WHERE source = 'salling_food_waste' AND valid_to < now() - interval '90 days';
   ```

   Classifications, deals and review items of those listings are removed by `ON DELETE CASCADE`.
   Keep offer listings (`tjek`, `rema`): they are the price history behind `history` references.
4. **Reclaim space.** Deleted rows are reused by later inserts but do not shrink the files.
   Neon runs autovacuum; `VACUUM (ANALYZE) listing;` is safe at any time. `VACUUM FULL listing;`
   returns space to the storage quota but locks the table, so pause the jobs first.
5. **Move up**: a paid Neon plan, or Postgres on a small VPS. Only `DATABASE_URL` changes
   ([ADR 0001](decisions/0001-free-hosting-stack.md)).

`raw_object` grows by one row per API response (Salling food waste adds at most
2 × `SALLING_FOOD_WASTE_MAX_CALLS` rows a day). Its rows are small and required for
reprocessing, so keep them.

---

## 7. Backups and restore

| Data | Where | Protection |
|---|---|---|
| normalized data, history, classifications | Neon | point-in-time restore inside the plan's history window, plus your own dumps (§7.2) |
| raw API responses | B2 bucket | written once and never modified or deleted by the pipeline; B2 stores them redundantly |
| code, migrations, configuration names | GitHub | git |
| secrets | GitHub secrets (write-only) | **your password manager**: GitHub never shows a secret again |

### 7.1 Neon point-in-time restore

The free plan keeps a short history window for instant restore: **6 hours** at the time of
writing (paid plans keep days). It covers mistakes noticed the same day, such as a bad manual
`DELETE` or a broken migration.

1. Pause the jobs (§3.4) so nothing writes while you restore.
2. Neon console → **Branches** → `production` → **Restore**, choose a timestamp before the
   mistake. Neon keeps the pre-restore state as a backup branch, so a restore can be undone.
3. Alternatively create a **new branch from a point in time**, inspect it, and copy the rows
   you need back into `production`. This is safer when only part of the data is wrong.
4. If the restore went to a different branch or endpoint, update `DATABASE_URL` (secret,
   `.env.production`) and `WEB_DATABASE_URL`. The web role is part of the restored database.
5. Rerun the jobs that were scheduled after the restore point (`gh workflow run …`). For Tjek, a
   rerun fetches the current leaflets again; food-waste data of the lost hours is in B2 and can
   be replayed with `reprocess --source salling --since <date>` if its `raw_object` rows survived.

### 7.2 Logical dumps (longer than the restore window)

Take a dump at least monthly, and before every risky operation (large delete, `VACUUM FULL`,
contract migration). `pg_dump` needs the plain `postgresql://` scheme and the same major version
as the server (17):

```bash
url="${DATABASE_URL/postgresql+psycopg/postgresql}"
docker run --rm -v "$PWD:/backup" postgres:17 \
  pg_dump --format=custom --no-owner --file "/backup/foodcatch-$(date +%Y%m%d).dump" "$url"
```

Store dumps outside Neon: locally (encrypted disk), or in a second B2 bucket with its own key.
The pipeline key may be restricted to the `raw/` prefix of the raw bucket, so do not reuse it.

Restore into an empty database (a new Neon branch or project):

```bash
docker run --rm -v "$PWD:/backup" postgres:17 \
  pg_restore --no-owner --dbname "$url" /backup/foodcatch-20261201.dump
```

Roles are cluster-level and not part of the dump. In a **new** project, create the group role
before restoring, so the dumped grants apply: `CREATE ROLE web_readonly NOLOGIN;`. Afterwards
recreate the web login role as in [setup](setup.md) §1.3, and run `db-migrate` (a no-op when the
schema is already current).

### 7.3 Total loss of the database

1. Create a new Neon project ([setup](setup.md) §1), set the new `DATABASE_URL`.
2. Restore the latest dump (§7.2), or, without a dump, run `db-migrate` for an empty schema.
3. Rebuild the raw index for the gap since the dump, then replay it. `reprocess` finds raw
   objects through their `raw_object` rows, and objects stored in B2 after the dump have none in
   the restored database. `raw reindex` lists the bucket, parses each key
   (`{source}/{endpoint}/{YYYY}/{MM}/{DD}/{fetch_run_id}/{seq}.json.gz`) and inserts the missing
   rows (sha256 and size recomputed, the object's upload time as `fetched_at`, a placeholder
   `fetch_run` with job `raw-reindex` for runs the database does not know):

   ```bash
   uv run foodcatch raw reindex --since 2026-11-01 --dry-run   # count only
   uv run foodcatch raw reindex --since 2026-11-01
   uv run foodcatch reprocess --source salling --since 2026-11-01   # then tjek, rema, openfoodfacts
   ```

   The order of sources does not matter (food-waste payloads carry their store). The original request parameters are not recoverable (`params` is
   `{"reindexed": true}`); no ingest depends on them. Placeholder runs appear in
   `api.pipeline_status` under the job `raw-reindex`.
4. Recreate the web role and rerun every job once ([setup](setup.md) §7).

### 7.4 Raw store (B2)

The pipeline only ever writes new keys, and the bucket keeps only the last version of each file
(setup §2.1). To protect against accidental deletion through the B2 console or a leaked key,
keep an occasional local mirror:

```bash
aws s3 sync "s3://<bucket>/raw" ./raw-mirror --endpoint-url "$S3_ENDPOINT_URL"
```

A leaked key: delete it in B2 (**Application Keys**), create a new one, update the `S3_*` secrets.

---

## 8. Routine checks

| When | Check |
|---|---|
| weekly | healthchecks.io all green; `api.review_queue_summary` (work through open items, §4.3) |
| monthly | `foodcatch db stats` trend; B2 bucket size; Neon *Usage* (compute hours, storage); a database dump (§7.2); the `keepalive` run of the 1st succeeded |
| after a matcher change | the next collect run promotes the version (§4.2); check the review queue (§4.3) |
| after renaming a job or changing a schedule | update `collect.yml` (cron **and** the `case` mapping), the healthchecks.io check and its secret name |

### Scheduled workflows disabled

GitHub disables scheduled workflows after 60 days without repository activity. The `keepalive`
workflow re-enables them monthly. If they were disabled anyway (for example `keepalive` itself
failed):

```bash
gh workflow list --all                     # shows disabled workflows
gh workflow enable collect.yml
gh workflow enable keepalive.yml
gh workflow run keepalive.yml              # verify that it works
```

### Rotating secrets

| Secret | Rotate | Then |
|---|---|---|
| `DATABASE_URL` | Neon console → Roles → `neondb_owner` → reset password | `gh secret set DATABASE_URL`, update `.env.production` |
| web role password | `ALTER ROLE foodcatch_web PASSWORD '…';` | update `web/.env.local` |
| `S3_*` | new B2 application key, then delete the old one | `gh secret set S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` |
| `SALLING_API_KEY` | Salling developer portal | `gh secret set SALLING_API_KEY` |
| `HEALTHCHECKS_URL_*` | check → *Settings* → regenerate ping URL | `gh secret set HEALTHCHECKS_URL_<JOB>` |

A collect run between the two steps of a `DATABASE_URL` rotation fails to connect. The workflows
mask the database host, endpoint id and user before running the pipeline
(`.github/scripts/mask_database_url.py`), because connection errors print them and GitHub masks
a secret only as a whole; the resolved IP addresses can still appear.

---

## 9. Known limitations

Accepted trade-offs and open points, so nobody mistakes them for bugs. Each is a candidate for
later work.

**Collection**

* *Salling quota.* The Salling key allows about 60 requests before a long 429 period; its exact
  window is unknown (§3.5). `salling-food-waste` stays within `SALLING_FOOD_WASTE_MAX_CALLS`
  and covers Denmark outside the region only in rotation (about every 10 days with the defaults),
  so EAN reference prices from there are days old. If the job was paused while it was
  redesigned, resume it: remove `salling-food-waste` from `COLLECT_PAUSED_JOBS` (§3.4) and
  resume its healthchecks.io check.
* *A degraded food-waste run hides uncovered region stores.* `api.food_waste_near` shows
  clearances seen by the latest finished run; region stores a quota-stopped run did not reach
  disappear until the next complete run.
* *Absent-store inference.* A known store absent from a geo answer although nearer than the
  farthest returned store of its brand counts as covered (Salling lists stores without
  clearances too, so such a store is unknown to the food-waste service). If Salling ever ranks
  stores differently, a store could be skipped for a run; `stores_inferred_absent` shows how often
  the rule applies.

**Prices and deals**

* *Member prices are detected from the offer text.* Tjek offers whose text marks a member price
  (Netto+, Coop members, ...) are stored with `listing.member_only = true`; in doubt the parser
  marks them member-only. The web shows a "Medlemspris" badge on such Netto deals and references,
  and a Netto member price is "Godt køb" only because the page marks it. A member price whose
  text does not say so is treated as everyone's price. The membership is named per chain
  (Netto+, Coop-medlem), not read from the offer.
* *Duplicate REMA 1000 references.* A Rema campaign is collected from Tjek (leaflet) and from
  the Rema catalogue; when both carry it, a deal lists it twice. The cheapest reference and
  hence the verdict are unaffected. As a *deal of its own* ("Ugens tilbud" for REMA 1000) a
  catalogue campaign is dropped when a Tjek Rema offer has the same price, an overlapping validity
  and the same class; a campaign whose leaflet price differs (e.g. a multi-buy price) or whose
  leaflet text is classified differently appears twice.
* *"Fast lav pris" is read from Lidl's text.* A Lidl leaflet item whose heading or description
  says "Fast lav pris" is a shelf price (`kind = 'regular'`): no deal of its own, a `regular`
  reference elsewhere. Other chains' texts are not read this way, and a Lidl shelf price printed
  without the phrase is treated as an offer.
* *Product keys of leaflet items are approximate.* Tjek has no product id, so a leaflet item's
  price history (`api.product_price_history`, key `offer:<chain>:<normalized heading>`) joins
  every item of that chain with the same heading and starts afresh when the heading changes.
  `rema:` and `ean:` keys are exact.
* *Food-waste comparison is chain-wide.* `food_waste_references` / `beats_competitors` use the
  current offers and shelf prices of every other chain regardless of distance (more conservative
  than a local comparison) and are computed when the view is read.
* *Withdrawn Tjek offers stay current.* A Tjek offer re-published with a new price or start
  replaces its earlier version at once, but an offer Tjek removes from a catalogue without a
  replacement stays current until its own end date (the jobs do not yet close offers of a fully
  fetched catalogue that a run no longer saw).
* *Upcoming offers as references.* Competitor offers count from publication until they end,
  including offers that start later than the Netto offer; this is deliberate (more references,
  more conservative verdicts).
* *EAN reference prices refresh with their listing.* A changed `product_reference_price` (a
  Salling `originalPrice`) reaches deals when the same-class listing changes or on
  `foodcatch deals recompute`; a change at a store outside the region, or a new net quantity
  from Open Food Facts, waits for one of those. EAN references also need `product.net_quantity`,
  which only Open Food Facts provides.
* *Rema sizes are approximate.* The size is `price / compare price` (Rema rounds the compare
  price); for weight items it is the typical package. A withdrawn Rema price period is closed at
  the first run that no longer sees it, not at the start of its successor.

**Data**

* *Non-GTIN clearances.* Variable-weight food-waste items with in-store codes get no `product`
  row (`api.food_waste_near.ean` is `NULL`); the code is kept in `listing.extra.product_code`.
* *Stores are not linked across sources.* A physical Netto store exists once from Salling and
  once from Tjek; per-chain store counts can count it twice (the UI only shows the nearest
  distance per chain).
* *Tjek pagination cap.* Tjek answers at most 1000 results per query (observed, not
  documented). The fetchers fail loudly at the cap instead of truncating; a catalogue with more
  offers needs a smarter split.
* *Quality baseline.* A run is compared with the last **succeeded** run of its job, so a genuine
  lasting drop keeps degrading until accepted (§3.2).

**Operations**

* *Matcher upgrade run.* The first run after a matcher version bump classifies every listing
  (sequential scan of `listing`) before it promotes the version (§4.2); fine at current
  volumes, an index on `listing.classified_version` can be added if it grows large.
* *Raw-store writes are check-then-write on S3.* `S3RawStore.put` checks for an existing key
  before writing; safe because keys contain the run id and a run has one writer.
* *Workflow exclusion is best effort.* `collect` and `db-migrate` only wait for earlier runs of
  each other (§5); follow the migration rules there.
* *keepalive is unverified against GitHub's inactivity timer.* It re-enables workflows through
  the API monthly (the approach of common keepalive actions); see "Scheduled workflows disabled"
  above if it ever fails.
* *External limits.* Free-tier numbers in [setup](setup.md) §9 (Neon storage and restore window,
  B2, healthchecks.io, Sentry) were taken from the providers' pages in November 2026 and are not
  checked automatically; set `DB_SIZE_BUDGET_MB` to the real Neon limit.
* *Development seed.* `pnpm db:seed` (web) creates the cluster-wide login role `foodcatch_web`
  (password `foodcatch_web`) on the local Postgres, and writes deal references itself instead
  of running `deals/compute.py`.
* *Web.* The price-history chart scrolls sideways on narrow screens (minimum width 540 px) and
  starts at the oldest data.
