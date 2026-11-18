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
| logs | Actions → run → job `<job>` → step *Collect* | JSON lines: `job.started`, `http.retry`, `job.degraded`, `job.failed` (with traceback) |
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
| `HTTP 429` after retries | rate limit hit despite throttling | rerun later; if it repeats, lower the host rate in `foodcatch/http.py` (`HOST_RATES_PER_SECOND`) |
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
(`records` by default) dropped by more than `QUALITY_DROP_THRESHOLD` (default 50 %) compared
with the **previous succeeded run** of the same job. The run exits with code 3, the workflow is
marked failed and healthchecks.io gets `/fail`. The reason is in `fetch_run.error`, and
`stats.quality` has the numbers.

### 3.1 Decide whether the drop is real

| Job | Normal reasons for a drop | Suspicious reasons |
|---|---|---|
| `tjek-offers` | holiday weeks, a chain publishing late, fewer upcoming catalogs on the day | several chains with `dealer_errors`/`catalog_errors` in `stats`; offers parsed but skipped |
| `salling-food-waste` | Sunday or holiday (fewer clearances); the 13:37 run compared with 05:37 | many HTTP errors in the logs; stores missing |
| `rema-products`, `*-stores` | assortment or store-list changes (small) | anything above 10 % |
| `off-enrich` | few new EANs that day (expected to vary a lot) | – |

Compare the stats of recent runs:

```sql
SELECT started_at, status, stats->'records' AS records, stats->'quality' AS quality, error
FROM fetch_run WHERE job = 'tjek-offers' ORDER BY started_at DESC LIMIT 14;
```

### 3.2 If the drop is genuine (the source really has less data)

Every following run is compared with the last *succeeded* run, so it keeps degrading until a
run succeeds. Accept the new level once:

```bash
gh workflow run collect.yml -f job=<job> -f accept_drop=true
```

This sets `QUALITY_DROP_THRESHOLD=1` for that run only. It succeeds and becomes the new
baseline.

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
* Everything runs in **one transaction**. A long range downloads many objects from B2 and holds
  the transaction open; pause the source's jobs first and prefer ranges of a few weeks.
* Free B2 downloads are 3× the stored data per month (setup §9), which is plenty for occasional
  reprocessing.

To widen the food-waste region (`REGION_CENTERS`, `REGION_RADIUS_KM`) retroactively, change the
variables, then reprocess `salling` with the same values in `.env.production`.

### 4.2 Reclassify after matcher changes

Product recognition is versioned (`MATCHER_VERSION` in `pipeline/src/foodcatch/matching/`).
After merging a matcher change that bumps the version:

1. The next collect run classifies the listings it touches with the new version, but older
   listings still only have classifications of the old version, and the `api` views show the
   current version only.
2. Reclassify everything once, then recompute deals:

   ```bash
   FOODCATCH_ENV_FILE=../.env.production uv run foodcatch reclassify
   ```

   `reclassify` re-runs recognition for all listings with the current version and recomputes
   deals (`foodcatch deals recompute` recomputes deals alone).
3. Classifications of all but the two most recent matcher versions are pruned, so the previous
   version stays available for comparison and rollback.
4. Check the review queue: `uv run foodcatch review list`, and `api.review_queue_summary`.

Run it soon after the merge (outside the collect schedule; the early afternoon UTC is free
except for 13:37), so the web never shows a mix of versions for long.

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
6. **Downgrades** are a manual emergency procedure: pause all jobs, then in the production shell
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
   Make sure a reclassify after a version bump has run (§4.2).
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

`raw_object` grows by one row per API response (on the order of 1,500 rows a day, mostly
food-waste requests). Its rows are small and
required for reprocessing, so keep them.

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
3. Replay raw data for the gap since the dump: `foodcatch reprocess --source … --since …`.
   **Limitation:** `reprocess` finds raw objects through their `raw_object` rows in the database.
   Objects stored in B2 after the dump have no row in the restored database and are not replayed
   by the current CLI. Rebuilding the index from the bucket listing (keys are
   `{source}/{endpoint}/{YYYY}/{MM}/{DD}/{fetch_run_id}/{seq}.json.gz`) needs a new command; until
   then, regular dumps are what limits data loss.
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
| weekly | healthchecks.io all green; `api.review_queue_summary` (review open items: `foodcatch review list`) |
| monthly | `foodcatch db stats` trend; B2 bucket size; Neon *Usage* (compute hours, storage); a database dump (§7.2); the `keepalive` run of the 1st succeeded |
| after a matcher change | reclassify (§4.2) |
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
