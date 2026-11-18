"""Reference prices and conservative deal verdicts (architecture §6; owned by the deals module).

* :mod:`foodcatch.deals.compute` - :func:`~foodcatch.deals.compute.recompute_deals` fills the
  ``deal`` table for Netto offer variants.
* :mod:`foodcatch.deals.verdict` - :func:`~foodcatch.deals.verdict.verdict`, the Python mirror
  of ``web/src/lib/verdict.ts``, tested on ``fixtures/verdict_cases.json`` (repo root).
"""
