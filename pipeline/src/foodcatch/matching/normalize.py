"""Text normalization applied before recognition.

Source texts are lower-cased, common abbreviations are expanded (Salling food-waste names are
abbreviated upper-case strings such as ``"KYL.BRYST"`` or ``"HK. OKSEKØD"``) and whitespace is
collapsed. The same normalization is used for the ``classification_override`` lookup key.
"""

from __future__ import annotations

import re

ABBREVIATIONS: tuple[tuple[re.Pattern[str], str], ...] = tuple(
    (re.compile(pattern), replacement)
    for pattern, replacement in (
        (r"\bkyl\.\s*", "kylling"),
        (r"\bhk\.?\s+", "hakket "),
        (r"\bmadl\.\s*", "madlavnings"),
        (r"\bmar\.\s*", "marineret "),
        (r"\bpan\.\s*", "paneret "),
        (r"\bkot\.", "koteletter"),
        (r"\bched\.", "cheddar"),
        (r"\brev\.?\s+", "revet "),
        (r"\bøko\.?\s+", "økologisk "),
        (r"\bøko$", "økologisk"),
        (r"\bml\s+(\d\d\+)", r"mellemlagret \1"),
        (r"\bcreme f\b", "creme fraiche"),
        (r"crème", "creme"),
        (r"fraîche", "fraiche"),
        (r"’", "'"),
        (r"\bm\.\s*", "med "),
        (r"\bm/\s*", "med "),
        (r"\bsandw(i)?\.", "sandwich"),
    )
)
"""Ordered ``(pattern, replacement)`` rewrites; order matters (``kyl.`` before ``m.``)."""

_WHITESPACE = re.compile(r"\s+")


def normalize(text: str) -> str:
    """Lower-case ``text``, expand abbreviations and collapse whitespace.

    Example: ``"HK. OKSEKØD 8-12%"`` -> ``"hakket oksekød 8-12%"``.
    """
    t = " " + text.lower().replace("\n", " ") + " "
    for pattern, replacement in ABBREVIATIONS:
        t = pattern.sub(replacement, t)
    return _WHITESPACE.sub(" ", t).strip()
