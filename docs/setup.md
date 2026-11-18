# Production setup

This guide sets up everything FoodCatch needs in production, in order. It takes about an hour.
The stack and its reasons are in [ADR 0001](decisions/0001-free-hosting-stack.md); day-to-day
operations are in the [runbook](runbook.md).

```
GitHub Actions (cron)  ──►  foodcatch collect <job>  ──►  Backblaze B2  (raw API responses)
        │                                         └──►  Neon Postgres (normalized data, deals)
        └── pings ──►  healthchecks.io (alerts by email)        ▲
                                                                 │ read-only role
                                                    web app on your laptop
```

| You will create | Used for | Cost |
|---|---|---|
| Neon project | Postgres database | free plan |
| Backblaze B2 bucket + application key | raw API responses | free up to 10 GB |
| Salling Group developer app | Salling stores and food-waste API | free |
| GitHub repository secrets and variables | configuration of the scheduled jobs | free (public repo) |
| healthchecks.io project with 6 checks | alert when a job fails or does not run | free plan |
| Sentry project (optional) | error reports with stack traces | free plan |

Throughout this guide, **keep every secret in a password manager** while you copy it. Never paste
secrets into issues, commits, chat or workflow logs. The repository is public, and so are its
Actions logs.

Before you start, install the [GitHub CLI](https://cli.github.com/) (`gh auth login`), and have
the repository checked out with the pipeline set up locally (see the README).

---

## 1. Neon (Postgres)

### 1.1 Create the project

1. Sign up at <https://neon.com> and choose **New project**.
2. Project name: `foodcatch`. Postgres version: **17** (the same as `docker-compose.yml`).
3. Cloud provider and region: **AWS, Europe Central 1 (Frankfurt)** (`aws-eu-central-1`), the
   region closest to Denmark and to GitHub's European traffic.
4. Create the project. Keep the default branch (`production`), database (`neondb`) and owner role
   (`neondb_owner`).

### 1.2 Get the owner connection string (pipeline)

1. On the project dashboard, choose **Connect**.
2. Select branch `production`, database `neondb`, role `neondb_owner`.
3. Turn **Connection pooling off**. The pipeline opens only a couple of connections and runs
   migrations, which need a direct (non-pooled) connection. The host must **not** contain
   `-pooler`.
4. Copy the connection string. It looks like:

   ```
   postgresql://neondb_owner:<password>@ep-xxxx-xxxx.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require
   ```

5. Change the scheme to the psycopg form. The pipeline would also accept the plain form, but
   being explicit avoids surprises:

   ```
   postgresql+psycopg://neondb_owner:<password>@ep-xxxx-xxxx.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require
   ```

   This is `DATABASE_URL`. Keep `sslmode=require`: Neon refuses unencrypted connections.

### 1.3 Create the web login role (after the first migration)

The web app connects with a separate role that can only read the views in schema `api`.
The first migration creates the group role `web_readonly` (NOLOGIN) and grants it `SELECT` on
schema `api`. **Run this step after step 7.1** (`db-migrate`). Before that, `web_readonly` does not
exist yet.

Create the login role **with SQL**, not on the Neon console's *Roles* page. Roles created in the
console become members of `neon_superuser` and could read and write everything.

1. Generate a password. Hex characters need no URL escaping:

   ```bash
   openssl rand -hex 24
   ```

2. In the Neon console, open **SQL Editor** (branch `production`, database `neondb`) and run the
   following, with your generated password in place of the placeholder:

   ```sql
   CREATE ROLE foodcatch_web LOGIN PASSWORD '<generated-password>';
   GRANT web_readonly TO foodcatch_web;
   -- Belt and braces: the role can never write and cannot run away with a query.
   ALTER ROLE foodcatch_web SET default_transaction_read_only = on;
   ALTER ROLE foodcatch_web SET statement_timeout = '15s';
   ```

3. Build the web connection string from the owner string: replace user and password, and use
   the plain `postgresql://` scheme. You may use the pooled host (`-pooler`) here:

   ```
   postgresql://foodcatch_web:<generated-password>@ep-xxxx-xxxx-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require
   ```

   This is `WEB_DATABASE_URL` (step 8).

4. Verify the role is read-only and limited to `api`:

   ```bash
   psql "$WEB_DATABASE_URL" -c 'SELECT count(*) FROM api.stores'      # works
   psql "$WEB_DATABASE_URL" -c 'SELECT count(*) FROM public.listing'  # permission denied
   ```

   No local `psql`? Use Docker instead:
   `docker run --rm -it postgres:17 psql "<url>" -c '...'`.

---

## 2. Backblaze B2 (raw store)

Every API response is stored unchanged (gzip) before it is parsed
([ADR 0002](decisions/0002-raw-first-pipeline.md)). This is the only copy of history that can
rebuild the database, so the bucket must be private and durable.

### 2.1 Account and bucket

1. Sign up at <https://www.backblaze.com/sign-up/cloud-storage>. Choose region **EU Central**
   when you sign up. An account's region is fixed at sign-up and cannot be changed later.
2. **Buckets → Create a Bucket**:
   - Bucket name: globally unique, e.g. `foodcatch-raw-<random suffix>`.
   - Files in bucket are: **Private**.
   - Default encryption: **Enable** (SSE-B2, free).
   - Object Lock: **Disable**.
3. On the new bucket, open **Lifecycle Settings** and choose **Keep only the last version of the
   file**. Raw keys contain the run id and a sequence number and are written once, so there is
   never an older version worth keeping. "Keep all versions" would only keep hidden copies of
   files you deliberately delete (and you pay for them).
4. Note the bucket's **Endpoint**, e.g. `s3.eu-central-003.backblazeb2.com`. The region is the
   part after `s3.`: `eu-central-003`.

### 2.2 Application key (restricted to the bucket)

1. **Application Keys → Add a New Application Key**:
   - Name: `foodcatch-pipeline`.
   - Allow access to bucket(s): **only your bucket**.
   - Type of access: **Read and Write**.
   - Allow List All Bucket Names: unchecked (not needed).
   - File name prefix: `raw/` (optional; limits the key to the raw store).
   - Duration: empty (does not expire).
2. Copy `keyID` and `applicationKey` immediately. **The application key is shown only once.**

### 2.3 Resulting settings

| Setting | Value |
|---|---|
| `RAW_STORE_URL` | `s3://<bucket-name>/raw` |
| `S3_ENDPOINT_URL` | `https://s3.eu-central-003.backblazeb2.com` (your endpoint, with `https://`) |
| `S3_REGION` | `eu-central-003` (your region) |
| `S3_ACCESS_KEY_ID` | the `keyID` |
| `S3_SECRET_ACCESS_KEY` | the `applicationKey` |

### 2.4 Caps and alerts

Under **Caps & Alerts**, turn on email alerts for storage and download bandwidth. You can leave
the caps at their defaults. B2 transactions are free, and FoodCatch stays well below the free
10 GB for the first year or more (see §9).

---

## 3. Salling Group API key

1. Sign up at <https://developer.sallinggroup.com/> and create an application.
2. Use **Bearer token** authentication and copy the generated key. FoodCatch uses the
   *Stores* (`/v2/stores`) and *Food Waste* (`/v1/food-waste`) APIs.
3. This is `SALLING_API_KEY`. Locally it goes in the repository-root `.env` (git-ignored).

Never use keys taken from Salling's own websites or apps. They are not ours to use.

---

## 4. GitHub secrets and variables

The workflows read **secrets** (encrypted, masked in logs) and **variables** (plain
configuration, visible in logs). Set them under **Settings → Secrets and variables → Actions**, or
with the GitHub CLI from the repository directory.

### 4.1 Secrets

| Secret | Value | Required |
|---|---|---|
| `DATABASE_URL` | Neon owner string, `postgresql+psycopg://…?sslmode=require&channel_binding=require` (§1.2) | yes |
| `S3_ACCESS_KEY_ID` | B2 `keyID` (§2.2) | yes |
| `S3_SECRET_ACCESS_KEY` | B2 `applicationKey` (§2.2) | yes |
| `SALLING_API_KEY` | Salling bearer token (§3) | yes (for `salling-*` jobs) |
| `HEALTHCHECKS_URL_SALLING_STORES` | ping URL (§5) | recommended |
| `HEALTHCHECKS_URL_SALLING_FOOD_WASTE` | ping URL (§5) | recommended |
| `HEALTHCHECKS_URL_TJEK_STORES` | ping URL (§5) | recommended |
| `HEALTHCHECKS_URL_TJEK_OFFERS` | ping URL (§5) | recommended |
| `HEALTHCHECKS_URL_REMA_PRODUCTS` | ping URL (§5) | recommended |
| `HEALTHCHECKS_URL_OFF_ENRICH` | ping URL (§5) | recommended |
| `SENTRY_DSN` | Sentry DSN (§6) | optional |

The ping URLs are secrets because anyone who knows one could report fake successes.

`gh secret set` prompts for the value, so it never ends up in your shell history:

```bash
gh secret set DATABASE_URL
gh secret set S3_ACCESS_KEY_ID
gh secret set S3_SECRET_ACCESS_KEY
gh secret set SALLING_API_KEY
```

### 4.2 Variables

| Variable | Example | Required | Meaning |
|---|---|---|---|
| `RAW_STORE_URL` | `s3://foodcatch-raw-x7k2/raw` | yes | raw store (§2.3) |
| `S3_ENDPOINT_URL` | `https://s3.eu-central-003.backblazeb2.com` | yes | B2 S3 endpoint |
| `S3_REGION` | `eu-central-003` | yes | B2 region |
| `REGION_CENTERS` | `55.68,12.57` | yes | `lat,lon;lat,lon`: where food-waste listings are kept |
| `REGION_RADIUS_KM` | `30` | no (default 30) | radius around each center |
| `COLLECT_PAUSED_JOBS` | `tjek-offers` | no | jobs whose scheduled runs are skipped (runbook) |
| `QUALITY_DROP_THRESHOLD` | `0.5` | no (default 0.5) | record-count drop that marks a run degraded |
| `DB_SIZE_BUDGET_MB` | `1024` | no (default 1024) | database budget for the 70 % warning |
| `LOG_LEVEL` | `INFO` | no | pipeline log level |

**`REGION_CENTERS` is not secret and appears in public logs.** Use a neighbourhood or city
centre rounded to two decimals (about 1 km), not your exact address. With a 30 km radius the
precision makes no difference.

```bash
gh variable set RAW_STORE_URL   --body "s3://<bucket-name>/raw"
gh variable set S3_ENDPOINT_URL --body "https://s3.eu-central-003.backblazeb2.com"
gh variable set S3_REGION       --body "eu-central-003"
gh variable set REGION_CENTERS  --body "55.68,12.57"
gh variable set REGION_RADIUS_KM --body "30"
```

The collect workflow checks the required values before it runs. A missing value fails the run
with a message naming it. It never falls back to the local development defaults.

### 4.3 Repository settings

- **Settings → Actions → General → Fork pull request workflows**: keep *Require approval for
  first-time contributors* (the default). Our scheduled workflows never run on pull requests, so
  forks cannot see secrets.
- **Your account → Settings → Notifications → Actions**: enable email notifications for failed
  workflows. GitHub sends failures of scheduled runs to the person who last changed the cron
  schedule in the workflow file.

---

## 5. healthchecks.io (dead-man's switch)

Each job pings its check at start (`/start`), on success, and on failure or degraded
(`/fail`). If GitHub drops or delays a scheduled run, no ping arrives and healthchecks.io emails
you once the grace time has passed. The free *Hobbyist* plan (20 checks) is enough.

1. Sign up at <https://healthchecks.io> and create a project `foodcatch`. Email alerts to your
   address are enabled by default (**Integrations → Email**).
2. For each row below: **Add Check** → name it after the job → **Schedule**: choose **Cron**,
   enter the expression, **Time Zone: UTC**, and set the grace time.

   | Check name | Cron expression | Grace time | Secret for its ping URL |
   |---|---|---|---|
   | `salling-stores` | `17 3 * * 1` | 2 hours | `HEALTHCHECKS_URL_SALLING_STORES` |
   | `salling-food-waste` | `37 5,13 * * *` | 2 hours | `HEALTHCHECKS_URL_SALLING_FOOD_WASTE` |
   | `tjek-stores` | `47 3 * * 1` | 2 hours | `HEALTHCHECKS_URL_TJEK_STORES` |
   | `tjek-offers` | `7 4 * * *` | 2 hours | `HEALTHCHECKS_URL_TJEK_OFFERS` |
   | `rema-products` | `27 2 * * *` | 2 hours | `HEALTHCHECKS_URL_REMA_PRODUCTS` |
   | `off-enrich` | `7 6 * * *` | 2 hours | `HEALTHCHECKS_URL_OFF_ENRICH` |

   These expressions must match `.github/workflows/collect.yml`. A grace time of 2 hours covers
   GitHub's schedule delays (usually under 30 minutes) plus the job's run time (timeout 45
   minutes). After `/start`, the grace time is also the longest a run may take before the check
   goes down.

3. Copy each check's **ping URL** (`https://hc-ping.com/<uuid>`) into its secret:

   ```bash
   gh secret set HEALTHCHECKS_URL_TJEK_OFFERS   # paste the URL when prompted
   ```

The same variables work locally in `.env`, but leave them empty there. Pings from development
runs would hide real failures.

---

## 6. Sentry (optional)

Sentry adds stack traces and grouping on top of the logs. The free *Developer* plan is enough.

1. Sign up at <https://sentry.io>, create a project with platform **Python**, name `foodcatch`.
2. Copy the **DSN** (Project Settings → Client Keys) into the secret `SENTRY_DSN`.
3. The pipeline sets `release` to the commit SHA and sends no personal data
   (`send_default_pii=False`). Leave `SENTRY_DSN` empty locally.

---

## 7. First run

Prerequisite: the workflows and the job implementations are merged to `main` and pushed.
`workflow_dispatch` only works for workflows on the default branch.

### 7.1 Create the schema

```bash
gh workflow run db-migrate.yml
gh run watch "$(gh run list --workflow db-migrate.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

The run ends with `foodcatch db stats`, which lists the tables. Now do **§1.3** (web role).

### 7.2 Run every job once, in this order

Each job depends on data from the earlier ones. Wait for each run to finish before starting the
next:

| # | Job | Why at this point |
|---|---|---|
| 1 | `salling-stores` | food waste is fetched per Salling store |
| 2 | `tjek-stores` | stores of all chains (nearby-chain filter in the web app) |
| 3 | `rema-products` | Rema shelf prices are `regular` references for deals |
| 4 | `tjek-offers` | weekly offers of all chains, including Netto deals |
| 5 | `salling-food-waste` | clearances; needs stores from step 1 |
| 6 | `off-enrich` | Open Food Facts data for EANs seen in step 5 |

```bash
for job in salling-stores tjek-stores rema-products tjek-offers salling-food-waste off-enrich; do
  gh workflow run collect.yml -f job="$job"
  sleep 10  # let the run appear
  gh run watch --exit-status "$(gh run list --workflow collect.yml --limit 1 --json databaseId --jq '.[0].databaseId')" || break
done
```

### 7.3 Verify

1. **GitHub**: each run's summary says `succeeded`. Logs are JSON lines; look for
   `job.succeeded` and its `stats`.
2. **healthchecks.io**: all six checks are *up* (green).
3. **B2**: the bucket browser shows `raw/salling/…`, `raw/tjek/…`, `raw/rema/…`,
   `raw/openfoodfacts/…`.
4. **Database**, from your laptop with a production env file (see the runbook, "Production
   shell"):

   ```bash
   cd pipeline
   FOODCATCH_ENV_FILE=../.env.production uv run foodcatch db stats
   ```

   Or in the Neon SQL editor:

   ```sql
   SELECT job, status, finished_at, stats->>'records' AS records FROM api.pipeline_status;
   ```

5. **Web**: after §8, the `/status` page shows the latest run of every job.

From now on the schedules run by themselves. Expect the first healthchecks.io pings at the next
scheduled times.

---

## 8. Running the web app locally against Neon

The web app is not deployed publicly ([ADR 0003](decisions/0003-local-only-web.md)). It runs on
your laptop and reads production data through the read-only role.

1. Create `web/.env.local` (git-ignored):

   ```
   WEB_DATABASE_URL=postgresql://foodcatch_web:<password>@ep-xxxx-xxxx-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require
   FOODCATCH_DEFAULT_LOCATION=55.68,12.57
   ```

2. Start it:

   ```bash
   cd web
   pnpm install
   pnpm dev        # http://localhost:3000
   ```

3. Neon suspends the database after 5 minutes without queries. The first page load after a pause
   takes a moment longer while it wakes up.

To use the local Docker database instead, use the default from `.env.example`
(`postgresql://foodcatch:foodcatch@localhost:5432/foodcatch`).

---

## 9. Costs, limits and what to watch

Everything below is free at FoodCatch's volume. The limits are those published in November 2026;
check the providers' pages if in doubt.

| Service | Free limit | Expected use | What to watch |
|---|---|---|---|
| **Neon** storage | 1 GB per project (ADR 0001; check Neon's pricing page, and if the current free limit is lower, set `DB_SIZE_BUDGET_MB` to it) | grows with history. Raw data lives in B2 and old classifications are pruned | `foodcatch db stats`; runs log a warning (and store `db_size_warning` in `fetch_run.stats`) above 70 % of `DB_SIZE_BUDGET_MB`. See the runbook, "Database size". |
| **Neon** compute | 100 CU-hours per project per month; scales to zero after 5 min idle | about 7 short runs a day at 0.25 CU, roughly 10–20 CU-hours a month, plus your web use | Neon console → *Usage*. |
| **Neon** restore window | 6 hours of instant restore (point in time) | – | Older mistakes need a dump (runbook, "Backups"). |
| **Neon** egress | 5 GB per month | small (the pipeline writes; the web reads small views) | Neon console → *Usage*. |
| **Backblaze B2** storage | 10 GB free, then about $6 per TB-month | estimated a few GB a year of gzip JSON (dominated by food-waste snapshots of every Salling store, twice a day) | bucket size on the B2 *Buckets* page. Check after the first week and extrapolate. |
| **Backblaze B2** transactions / egress | API calls free; downloads free up to 3× stored data per month | uploads only, plus downloads when you reprocess | a large `reprocess` downloads the raw objects it replays. |
| **GitHub Actions** | public repository: standard runners free and unlimited | about 7 runs a day, a few minutes each | schedules can be delayed or dropped (healthchecks.io catches it); workflows are disabled after 60 days without repository activity (`keepalive.yml` prevents it); **logs are public**. |
| **healthchecks.io** | Hobbyist: 20 checks | 6 checks | – |
| **Sentry** (optional) | Developer: 5,000 errors per month | a handful | – |

If Neon storage becomes too tight, move to a paid Neon plan or a small VPS with Postgres. The
pipeline speaks standard Postgres and S3, so this is a matter of changing `DATABASE_URL`
([ADR 0001](decisions/0001-free-hosting-stack.md)).
