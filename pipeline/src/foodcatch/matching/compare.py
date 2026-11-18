"""Comparing recognized products and the healthy-staple filter.

Two matches are "the same product" only when their type, processing state and **every** key
attribute are known and equal. Unknown attributes give at most "similar", which is
informational and must never be used to call something a good deal.

The health filter is deliberately separate from recognition: a marinated chicken breast is
recognized as chicken breast (with ``forarbejdet=marineret``) but is not a healthy staple.
"""

from __future__ import annotations

import re
from typing import Literal

from foodcatch.matching.model import PROCESSING_ATTR, UNKNOWN, Match

type Comparability = Literal["same", "similar"]

_FLAVOURABLE_TYPES = frozenset({"skyr", "græsk_yoghurt", "a38_ymer", "yoghurt"})

STAPLE_WORDS = re.compile(
    r"hakket|kylling|\bæg\b|mælk|smør|fløde|\bost\b|ost\b|skyr|yoghurt|tomat|bønne|kikært|\btun\b|"
    r"havregryn|linser|fraiche|mozzarella|cheddar|hytteost",
    re.IGNORECASE,
)
"""Words suggesting a staple; unrecognized texts containing one are queued for review."""


def comparability(a: Match, b: Match) -> Comparability | None:
    """How ``a`` and ``b`` compare.

    Returns:
        ``"same"`` - same type and processing, all key attributes known and equal: may be used
        for a price verdict. ``"similar"`` - same type and processing, no known key attribute
        contradicts: informational only. ``None`` - different products.
    """
    if a.type_id != b.type_id:
        return None
    if a.attrs.get(PROCESSING_ATTR) != b.attrs.get(PROCESSING_ATTR):
        return None
    if a.is_exact and b.is_exact and a.class_key == b.class_key:
        return "same"
    for key in a.key_attrs:
        value_a, value_b = a.attrs.get(key, UNKNOWN), b.attrs.get(key, UNKNOWN)
        if UNKNOWN not in (value_a, value_b) and value_a != value_b:
            return None
    return "similar"


def is_healthy_staple(m: Match) -> bool:
    """Whether ``m`` is a healthy, minimally processed staple.

    Processed products (any ``forarbejdet``) and flavoured yoghurt-like products are not.
    """
    if m.attrs.get(PROCESSING_ATTR):
        return False
    return not (m.type_id in _FLAVOURABLE_TYPES and m.attrs.get("smag") == "med smag")


def contains_staple_word(text: str) -> bool:
    """Whether ``text`` mentions a staple word (see :data:`STAPLE_WORDS`)."""
    return STAPLE_WORDS.search(text) is not None
