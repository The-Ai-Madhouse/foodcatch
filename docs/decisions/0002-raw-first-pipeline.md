# 0002 – Raw-first, reprocessable pipeline

Status: accepted (2026-11-18)

## Decision
Every external response is stored unchanged before parsing. Normalized tables, classifications
and deals are derived data that can be rebuilt from raw objects (`foodcatch reprocess`,
`foodcatch reclassify`). Each classification records the matcher version that produced it.

## Consequences
Product recognition can improve over time and be applied retroactively to all history, and any
price claim can be traced back to the exact API response it came from.
