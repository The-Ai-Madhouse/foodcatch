"""Product recognition (ported from ``poc/matching.py``).

Public API (stable; signatures are a contract for jobs, deals and tests):

* :data:`MATCHER_VERSION` - version of the rules; bump (``YYYY.MM.N``) on every behaviour change.
  Classifications are stored per version (``classification.matcher_version``).
* :func:`classify` - text (+ optional source category path) -> recognized variants.
* :func:`comparability` - ``"same"`` (may be used for a price verdict), ``"similar"``
  (informational only) or ``None``.
* :func:`is_healthy_staple` - whether a match counts as a healthy, minimally processed staple.
* :class:`Match` - see :mod:`foodcatch.matching.model`.

Modules: :mod:`~foodcatch.matching.normalize` (text normalization),
:mod:`~foodcatch.matching.taxonomy` (product types), :mod:`~foodcatch.matching.variants`
(multi-variant headings), :mod:`~foodcatch.matching.attributes` (key attributes),
:mod:`~foodcatch.matching.salling_categories` (Salling category hints),
:mod:`~foodcatch.matching.recognize`, :mod:`~foodcatch.matching.compare` and
:mod:`~foodcatch.matching.persist` (``classification`` rows, overrides, review queue).

Must keep the PoC's conservatism: unknown key attributes make a match inexact, never guessed.
Gold-set tests: ``tests/matching/data/salling_gold.jsonl`` and ``offer_texts_snapshot.jsonl``.
"""

from __future__ import annotations

from foodcatch.matching.compare import Comparability, comparability, is_healthy_staple
from foodcatch.matching.model import Match
from foodcatch.matching.recognize import classify

MATCHER_VERSION = "2026.11.1"

__all__ = [
    "MATCHER_VERSION",
    "Comparability",
    "Match",
    "classify",
    "comparability",
    "is_healthy_staple",
]
