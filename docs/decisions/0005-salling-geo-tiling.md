# 0005 – Geo-tiled Salling food-waste collection within a request budget

Status: accepted (2026-11-18)

## Context
The first `salling-food-waste` job asked `GET /v1/food-waste/{storeId}` once per Salling store
(about 721 stores, twice a day). The Salling key turned out to have an undocumented quota
(observed 2026-11-18): every response carries `Retry-After: 1`, and after about 60 requests
the key gets HTTP 429 for a long period (more than 37 minutes; the window and the real
`Retry-After` of the 429 are unknown). The shared HTTP client retried each 429 for up to
5 × 120 s, so a run could neither finish nor fail quickly, and it burned the quota of the weekly
`salling-stores` job too. The job was paused (`COLLECT_PAUSED_JOBS`).

`GET /v1/food-waste/?geo=lat,lon&radius=KM` (radius ≤ 100) returns the same `{store,
clearances}` objects for the ~16–19 stores nearest to the point, regardless of the radius,
including stores without clearances (a recorded answer in central Copenhagen listed the 16
nearest known stores, none missing).

## Decision
1. **Geo tiling.** The job queries the geo endpoint at the coordinates of known stores
   (`store` rows of source `salling`), chosen greedily by `jobs/salling_geo.py`: the store that
   the fewest candidate queries would reach first, by the query predicted to reach the most
   stores still to cover. Every returned store is covered, and so is every known store that is
   absent although nearer than the farthest returned store of its brand (the service does not
   know it, so asking again would only repeat the answer).
2. **Region first, country in rotation.** Stores within `REGION_RADIUS_KM` of
   `REGION_CENTERS` (their clearances become listings) are covered first in every run. The rest
   of Denmark, which only feeds EAN reference prices, is covered with the remaining budget,
   least recently covered first. The rotation state is the new nullable column
   `store.food_waste_checked_at` (migration 0003), set to the run start for every covered store.
3. **Hard budget.** At most `SALLING_FOOD_WASTE_MAX_CALLS` requests per run (default 25:
   two runs a day plus the weekly store job stay under 60 even if the quota is per day).
4. **No waiting on 429.** Geo requests use a per-request retry policy (`http.NO_RETRY`, carried
   as an httpx request extension), so other sources and the store job keep the client's
   retries. The first 429 stops fetching; the run keeps what it ingested, logs the 429's
   `Retry-After`, records `quota_exhausted: true`, and ends `succeeded` if the region was
   covered, `degraded` otherwise (via the new `JobContext.degrade`). Other errors: a failed
   target is retried once, and after three failed requests fetching stops.
5. **Quality metric `region_clearances`** (valid clearances of the region stores, each store
   counted once per run) replaces `records`, which now depends on how much of the country a run
   reached.
6. Each geo response is one raw object (endpoint `food-waste-geo`, params `{geo, radius}`);
   ingest applies the unchanged per-store rules to each element. The per-store endpoint stays
   supported for reprocessing older raw objects.

## Consequences
* With the default region (30 km around Copenhagen, ~256 of 721 stores) a simulation on the
  real store list (16 stores per answer) needs about 23 calls for the region, leaving about two
  calls per run for the rest of the country, which is then fully covered about every 10 days.
  A failed request or two still fits; more make the run `degraded`. If the quota proves to be
  per hour, raising the budget (runbook §3.5) shortens the rotation (35 calls: about 2 days);
  a smaller `REGION_RADIUS_KM` frees calls too.
* EAN reference prices outside the region are refreshed every few days instead of twice a day.
  `api.food_waste_near` only shows region stores, which are covered every run.
* Counters from ingest (`records`, `clearances`, `listings_unchanged`, …) count a store once per
  response that contains it; responses overlap, so use `stores_*` / `region_*` stats for
  coverage.
* The inference of absent stores assumes the API lists the nearest stores (observed); a 5 %
  distance margin guards against small differences in distance calculation.
