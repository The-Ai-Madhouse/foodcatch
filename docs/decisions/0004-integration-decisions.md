# 0004 – Matcher state, release promotion and Rema campaign references

Status: accepted (2026-11-18)

## Context
Integrating the module branches surfaced three cross-module inconsistencies:

1. `matching.persist` recorded the matcher version and input fingerprint of each listing in
   `listing.extra["matcher"]`, but `listing.extra` is written by ingest. The Salling ingest
   replaces it on every upsert, which erased the marker (so those listings were re-classified on
   every run) and made the ingest report unchanged listings as changed.
2. The post-fetch hook classifies with the code's `MATCHER_VERSION`, while deals and the `api`
   views read the database's *current* `matcher_release`. After a version bump, new listings
   were classified only with a version nobody read until `foodcatch reclassify` was run by hand.
3. Deals used REMA 1000 shelf prices (`regular`) from the Rema catalogue but ignored its campaign
   prices, which include in-store campaigns that are missing from Rema's Tjek leaflet. A Netto
   offer could then beat Rema's regular price and be called a good deal although Rema sold the
   same product cheaper - a non-conservative verdict.

## Decision
1. The matcher state lives in its own columns, `listing.classified_version` and
   `listing.classified_fingerprint` (migration 0002, which moves existing markers). Ingest owns
   `listing.extra`; matching never writes it.
2. The post-fetch hook promotes the code's `MATCHER_VERSION` to the current release once it has
   classified every listing with it (which the first run after a bump does anyway), pruning old
   classifications exactly like `foodcatch reclassify`.
3. Rema catalogue campaign prices (`source = 'rema'`, `kind = 'offer'`) count as `offer`
   references, one per open price period, next to Tjek offers of other chains.

## Consequences
* Deploying a matcher change needs no manual step; the first collect run after it is slower and
  switches the views when it commits (runbook §4.2). `reclassify` remains for switching at once
  and for applying override changes to existing listings.
* A Rema campaign present in both sources appears twice among a deal's references (same price);
  the verdict is unaffected (runbook §9).
