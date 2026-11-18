# 0001 – Free hosting stack: GitHub Actions + Neon + Backblaze B2

Status: accepted (2026-11-18)

## Context
FoodCatch is a personal project that must run without a paid server, yet collect data
reliably every day, because price history cannot be recovered later.

## Decision
* Scheduled jobs run as GitHub Actions workflows in a **public** repository (unlimited minutes).
* Postgres is hosted on **Neon** (free plan, 1 GB per project).
* Raw API payloads are stored gzip-compressed in **Backblaze B2** (S3 API, 10 GB free).
* The web app runs **locally** for now (no public deployment; see ADR 0003).
* Monitoring: healthchecks.io dead-man's switch per job, optional Sentry.

## Consequences
* GitHub may delay schedules and disables them after ~60 days without repository activity;
  healthchecks.io must alert when a job does not report.
* The 1 GB limit forces raw data out of Postgres and selective storage of food-waste
  listings (see architecture §4 "Volume control").
* Everything uses standard interfaces (Postgres, S3, CLI commands) so the system can move to
  a small VPS without code changes.
