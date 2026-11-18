"""Reference prices and conservative deal verdicts (architecture §6; owned by the deals module).

* :mod:`foodcatch.deals.compute` - :func:`~foodcatch.deals.compute.recompute_deals` fills the
  ``deal`` table for Netto offer variants with set-based SQL; its module docstring documents
  every reference rule (same class, price applies, reference kinds, scope and staleness).
* :mod:`foodcatch.deals.verdict` - :func:`~foodcatch.deals.verdict.verdict`, the Python mirror
  of ``web/src/lib/verdict.ts``, tested on ``fixtures/verdict_cases.json`` (repo root), plus
  :func:`~foodcatch.deals.verdict.parse_references` for stored ``deal.references`` JSON.
"""
