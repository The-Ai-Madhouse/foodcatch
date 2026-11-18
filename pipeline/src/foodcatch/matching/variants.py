"""Splitting offer headings that name several product variants.

Leaflet offers often cover several products at one price: ``"Kyllingebryst, -inderfilet eller
-lårfilet"`` or ``"Hakkede eller flåede tomater"``. Each variant is recognized separately, and
the deal logic only trusts the offer's unit price for a variant when every variant is the same
product class (see :attr:`~foodcatch.matching.model.Match.offer_is_homogeneous`).
"""

from __future__ import annotations

import re

from foodcatch.matching.normalize import normalize

_STEMS = re.compile(r"(kyllinge?|okse|grise?|svine|kalve?|lamme|kalkun)")
_TOKENS = re.compile(r"(\s+)")
# A full stop only splits after a whole word (5+ letters), not after abbreviations
# such as "kar." or "d.g.".
_SEPARATORS = re.compile(r",\s*|\s+eller\s+|(?<=[a-zæøå]{5})\.\s+|\s+samt\s+")
# A part with nothing but numbers/percentages ("8-12%") belongs to the previous variant.
_SUFFIX_ONLY = re.compile(r"[\d\s,.\-%+]+(fedt)?")


def expand_hyphen_prefixes(text: str) -> str:
    """Expand Danish suspended compounds using the last meat stem seen.

    ``"kyllingevinger, -lårfilet eller -underlår"`` ->
    ``"kyllingevinger, kyllingelårfilet eller kyllingeunderlår"``.
    """
    out: list[str] = []
    last_stem: str | None = None
    for token in _TOKENS.split(text):
        if token.startswith("-") and len(token) > 2 and token[1].isalpha() and last_stem:
            token = last_stem + token[1:]
        stems = list(_STEMS.finditer(token))
        if stems:
            last_stem = stems[-1].group(1)
        out.append(token)
    return "".join(out)


def split_variants(heading: str) -> list[str]:
    """Split a heading into normalized variant texts (one element when there is one variant).

    Separators are commas, "eller", "samt" and full stops after whole words. A part ending in
    a hyphen is joined with the next (``"kyllingeover- eller underlår"`` stays one variant),
    and a part with only numbers (``"8-12%"``) is appended to the previous variant. Brands
    or prefixes of the first variant are deliberately not carried over to later variants.
    """
    text = expand_hyphen_prefixes(normalize(heading))
    merged: list[str] = []
    for raw_part in _SEPARATORS.split(text):
        part = raw_part.strip(" .")
        if not part:
            continue
        if merged and merged[-1].endswith("-"):
            merged[-1] = merged[-1] + " eller " + part
        else:
            merged.append(part)
    final: list[str] = []
    for part in merged:
        if final and _SUFFIX_ONLY.fullmatch(part):
            final[-1] += " " + part
        else:
            final.append(part)
    return final
