"""Product recognition (ported from ``poc/matching.py``; owned by the matching module).

Public API (stable; signatures are a contract for jobs, deals and tests):

* :data:`MATCHER_VERSION` - version of the rules; bump (``YYYY.MM.N``) on every behaviour change.
  Classifications are stored per version (``classification.matcher_version``).
* :func:`classify` - text (+ optional source category path) -> recognized variants.
* :func:`comparability` - ``"same"`` (may be used for a price verdict), ``"similar"``
  (informational only) or ``None``.
* :func:`is_healthy_staple` - whether a match counts as a healthy, minimally processed staple.
* :class:`Match` - see :mod:`foodcatch.matching.model`.

Persistence (``classification`` rows, overrides, review queue) lives in
:mod:`foodcatch.matching.persist`.

Must keep the PoC's conservatism: unknown key attributes make a match inexact, never guessed.
Gold-set tests: ``tests/matching/data/salling_gold.jsonl`` and ``offer_texts_snapshot.jsonl``.
"""

from __future__ import annotations

from typing import Literal

from foodcatch.matching.model import Match

MATCHER_VERSION = "2026.11.1"

type Comparability = Literal["same", "similar"]


def classify(title: str, description: str = "", category_hint: str | None = None) -> list[Match]:
    """Recognize the product variant(s) in a listing title.

    Args:
        title: offer heading or product name (``"Hakket oksekød 8-12%"``).
        description: offer description / Rema ``underline`` (sizes, brands, fat %).
        category_hint: the source's category path (Salling ``"A>B>Leaf"``); the leaf wins over
            text when mapped. Paths may repeat segments; the leaf is the last segment.

    Returns:
        One :class:`Match` per distinct recognized class; empty when nothing is recognized.
    """
    raise NotImplementedError


def comparability(a: Match, b: Match) -> Comparability | None:
    """``"same"`` only if type, every key attribute (known on both) and processing are equal."""
    raise NotImplementedError


def is_healthy_staple(m: Match) -> bool:
    """Whether ``m`` is a healthy, minimally processed staple (not processed/flavoured)."""
    raise NotImplementedError


__all__ = [
    "MATCHER_VERSION",
    "Comparability",
    "Match",
    "classify",
    "comparability",
    "is_healthy_staple",
]
