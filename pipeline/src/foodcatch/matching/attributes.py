"""Attribute extraction: price-relevant properties of a recognized product variant.

Attribute names and values are Danish domain data (``øko=ja``, ``fedt=8-12%``,
``mælketype=letmælk`` ...). An attribute that cannot be determined is either left out (the class
key then shows ``?``) or set to ``?`` explicitly; it is **never guessed**.

The processing state (``forarbejdet``: marinated, breaded, cold cuts ...) is an attribute rather
than a separate type, so a marinated chicken breast is still recognized as chicken breast but is
neither compared with plain chicken breast nor shown as a healthy staple.
"""

from __future__ import annotations

import re

from foodcatch.matching.model import PROCESSING_ATTR, UNKNOWN
from foodcatch.matching.taxonomy import FLAVOURS, get_type

type FatRange = tuple[float, float]

_NUM = r"(\d+(?:[.,]\d+)?)"
_FAT_INTERVAL = re.compile(rf"{_NUM}\s*-\s*{_NUM}\s*%")
_FAT_MAX = re.compile(rf"max\.?\s*{_NUM}\s*%")
_FAT_SINGLE = re.compile(rf"(?<![\d,.\-]){_NUM}\s*%")
_GRAMS = re.compile(r"(\d+)\s*(?:g|gr)\b")

CONVENIENCE_BRANDS = re.compile(r"godt begyndt|\bgb\b|næmt|salling nu|\bnu\b$")
"""Brands that only make ready meals / convenience food (applies to every type)."""

COLD_CUT_BRANDS = re.compile(
    r"pålækker|3[- ]?stjernet|\bminimum\b|d\.?g\.? slagter|\bbudget\b|gøl\b|tulip|steff houlberg|"
    r"pålægsslagteren|defco|egelykke|\b1h\b"
)
"""Brands that (in the chilled section) only make cold cuts; applies to meat types only."""

PROCESSING_MARKERS: tuple[tuple[str, re.Pattern[str]], ...] = tuple(
    (name, re.compile(pattern))
    for name, pattern in (
        (
            "marineret",
            r"marineret|marinade|\bbbq\b|krydret|med (citron|rosmarin|urter|hvidløg|timian|chili)|"
            r"\bchili\b|teriyaki|tandoori|"
            r"med (peber|paprika|karry|krydder|gyros|ramsløg|pesto)|ramsløg|gyros",
        ),
        ("paneret", r"paneret|panko|nugget|schnitzel|cordon"),
        (
            "tilberedt",
            r"stegt|grillet|røget|pulled|kogt skinke|sous vide|færdigret|gryde|kebab|spyd|sandwich|"
            r"panini|wrap|gratin|godt begyndt|næmt|salling nu|med (kartofler|ris|sauce|svampe)|"
            r"a ?la creme|salat\b|\bi tern\b",
        ),
        ("pålæg", r"pålæg|postej|salami|\bskiver\b.*(kylling|kalkun)|kyllingepålæg|topping"),
        ("pølse/fars", r"pølse|medister|frikadelle|burger|cevapcici|kødboller"),
        ("i sauce", r"i (tomat)?sauce|baked beans|chili sin carne|i tomat\b|bønnemos"),
        ("snack/dessert", r"\bsnack|dessert|\bis\b|kage|chips|slik|chokolade|drik\b|drikke"),
    )
)
"""Processing states (value of ``forarbejdet``) and the words that indicate them, in order."""

_ALWAYS_ATTR_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("øko", re.compile(r"økologisk|\bøko\b|\bøgo\b|änglamark|salling øko|naturmælk")),
    ("laktosefri", re.compile(r"laktosefri|lactofree|\blf\b")),
)

_MILK_TYPES: tuple[tuple[re.Pattern[str], str], ...] = tuple(
    (re.compile(rf"{word}\s*-?\s*mælk"), value)
    for word, value in (
        ("skummet", "skummetmælk"),
        ("mini", "minimælk"),
        ("let", "letmælk"),
        ("sød", "sødmælk"),
        ("jersey", "jerseymælk"),
    )
)

_FLAVOUR = re.compile(FLAVOURS)
_FLAVOUR_OR_VARIANTS = re.compile(FLAVOURS + r"|flere varianter|variant")
_YOGHURT_TYPES = frozenset({"skyr", "græsk_yoghurt", "a38_ymer", "yoghurt"})
_LEGUME_TYPES = frozenset({"kikærter", "kidneybønner", "sorte_bønner", "hvide_bønner", "linser"})
_CHICKEN_BREAST_TYPES = frozenset({"kyllingebryst", "kyllingeinderfilet"})


def _num(value: str) -> float:
    return float(value.replace(",", "."))


def fat_ranges(text: str) -> list[FatRange]:
    """All fat percentages in ``text`` as ``(low, high)`` ranges.

    Intervals (``8-12%``) and maxima (``max. 7%`` -> ``(3, 7)``) win; single values (``3,5%``)
    are only used when there is neither.
    """
    t = text.lower()
    out: list[FatRange] = [(_num(m[1]), _num(m[2])) for m in _FAT_INTERVAL.finditer(t)]
    for m in _FAT_MAX.finditer(t):
        hi = _num(m[1])
        out.append((max(0.0, hi - 4), hi))
    if not out:
        for m in _FAT_SINGLE.finditer(t):
            v = _num(m[1])
            out.append((v, v))
    return out


def fat_bucket(type_id: str, rng: FatRange) -> str:
    """The fat class of a range for ``type_id`` (the value of the ``fedt`` attribute).

    Minced meat, cooking cream, crème fraîche and yoghurt use the market's usual fat classes;
    other types keep the literal range (``"3-3%"``).
    """
    lo, hi = rng
    mid = (lo + hi) / 2
    if type_id.startswith("hakket_"):
        if mid < 7.5:
            return "≤7%"
        if mid < 12.5:
            return "8-12%"
        if mid <= 20:
            return "13-20%"
        return ">20%"
    if type_id == "madlavningsfløde":
        return "≤10%" if mid <= 10 else "11-20%"
    if type_id == "creme_fraiche":
        return "≤9%" if mid <= 9 else ("18%" if mid <= 20 else "38%")
    if type_id == "yoghurt":
        return "≤1%" if mid <= 1 else ("1,5-3,5%" if mid <= 4 else ">4%")
    return f"{lo:g}-{hi:g}%"


def _grams(text: str) -> list[float]:
    return [float(g) for g in _GRAMS.findall(text)]


def extract_attrs(type_id: str, text: str, extra: str, whole: str = "") -> dict[str, str]:
    """Extract the attributes of one variant of type ``type_id``.

    Args:
        type_id: the recognized product type.
        text: the variant's own normalized text.
        extra: additional text such as the description; callers pass it only when it applies
            unambiguously to this variant (offers with a single variant).
        whole: the whole normalized heading. A marker found only there (e.g. "økologiske" in
            "Økologiske hakkede eller flåede tomater") makes the attribute unknown (``?``)
            for the variant; brand markers (cold cuts, ready meals) apply to all variants.

    Returns:
        Attribute name -> value. Always contains ``øko`` and ``laktosefri``.
    """
    whole = whole or text
    both = f"{text} {extra}"
    attrs: dict[str, str] = {}

    for key, pattern in _ALWAYS_ATTR_PATTERNS:
        if pattern.search(both):
            attrs[key] = "ja"
        elif pattern.search(whole):
            attrs[key] = UNKNOWN
        else:
            attrs[key] = "nej"

    _add_processing(attrs, type_id, text, extra, whole, both)

    product_type = get_type(type_id)
    if "fedt" in product_type.key:
        buckets = {fat_bucket(type_id, r) for r in fat_ranges(text) or fat_ranges(extra)}
        if len(buckets) == 1:
            attrs["fedt"] = buckets.pop()

    if type_id == "mælk":
        _add_milk_type(attrs, text)
    elif type_id in _CHICKEN_BREAST_TYPES:
        attrs["tilsat_vand"] = _added_water(both)
    elif type_id == "kyllingelår":
        cut = _chicken_leg_cut(text)
        if cut:
            attrs["udskæring"] = cut
    elif type_id == "fast_ost":
        form = _cheese_form(both)
        if form:
            attrs["form"] = form
    elif type_id == "æg":
        production = _egg_production(attrs["øko"], both)
        if production:
            attrs["produktion"] = production
    elif type_id in _YOGHURT_TYPES:
        flavour = _flavour(text, extra)
        if flavour:
            attrs["smag"] = flavour
    elif type_id in _LEGUME_TYPES:
        form = _legume_form(both)
        if form:
            attrs["form"] = form
    elif type_id == "tun":
        medium = _tuna_medium(both)
        if medium:
            attrs["medium"] = medium
    return attrs


def _add_processing(
    attrs: dict[str, str], type_id: str, text: str, extra: str, whole: str, both: str
) -> None:
    """Set ``forarbejdet`` from processing words in the variant (or its unambiguous extra)."""
    processing = [
        name
        for name, pattern in PROCESSING_MARKERS
        if pattern.search(text) or (extra and pattern.search(extra))
    ]
    brand_text = f"{whole} {extra}"
    if CONVENIENCE_BRANDS.search(brand_text) and "tilberedt" not in processing:
        processing.append("tilberedt")
    is_meat = get_type(type_id).group == "Kød"
    if is_meat and COLD_CUT_BRANDS.search(brand_text) and "pålæg" not in processing:
        processing.append("pålæg")
    if type_id in _CHICKEN_BREAST_TYPES and "pålæg" not in processing:
        grams = _grams(both)
        if grams and max(grams) <= 200:  # chicken breast in packs of <= 200 g is cold cuts
            processing.append("pålæg")
    if processing:
        attrs[PROCESSING_ATTR] = ",".join(processing)


def _add_milk_type(attrs: dict[str, str], text: str) -> None:
    for pattern, value in _MILK_TYPES:
        if pattern.search(text):
            attrs["mælketype"] = value
            return
    ranges = fat_ranges(text)
    if ranges:
        v = ranges[0][1]
        attrs["mælketype"] = (
            "skummetmælk"
            if v <= 0.1
            else "minimælk"
            if v <= 0.5
            else "letmælk"
            if v <= 1.5
            else "sødmælk"
        )


def _added_water(both: str) -> str:
    if re.search(r"med lage|tilsat (vand|lage)|injiceret", both):
        return "ja"
    if re.search(r"uden (vand|lage)|ikke tilsat|100\s*%\s*kød", both):
        return "nej"
    return "nej" if re.search(r"frisk|økologisk|friland", both) else UNKNOWN


def _chicken_leg_cut(text: str) -> str | None:
    if re.search(r"lårfilet|filet af lår|udbenet", text):
        return "lårfilet"
    if "underlår" in text and "overlår" not in text:
        return "underlår"
    if "overlår" in text and "underlår" not in text:
        return "overlår"
    if re.search(r"hele\s*-?\s*lår|hele kyllingelår|lår med ryg", text):
        return "hele lår"
    if "lårmix" in text or ("underlår" in text and "overlår" in text):
        return "blandet"
    return None


def _cheese_form(both: str) -> str | None:
    if re.search(r"revet|reven", both):
        return "revet"
    if re.search(r"skive|\bskiver\b", both):
        return "skiver"
    grams = _grams(both)
    # Sliced and grated cheese is almost always sold in < 400 g and says so on the pack.
    if re.search(r"skæreost|\bblok\b", both) or (grams and min(grams) >= 400):
        return "blok"
    return None


def _egg_production(organic: str, both: str) -> str | None:
    if organic == "ja":
        return "økologisk"
    if re.search(r"friland", both):
        return "frilands"
    if re.search(r"skrabe", both):
        return "skrabe"
    if re.search(r"\bbur", both):
        return "bur"
    return None


def _flavour(text: str, extra: str) -> str | None:
    if re.search(r"naturel|natural|\bplain\b|neutral", text):
        return "naturel"
    if _FLAVOUR.search(text):
        return "med smag"
    if re.search(r"naturel|natural", extra):
        return "naturel"
    if _FLAVOUR_OR_VARIANTS.search(extra):
        return "med smag"
    return None


def _legume_form(both: str) -> str | None:
    if re.search(r"tørre(de|t)", both):
        return "tørret"
    if re.search(r"i lage|i vand|dåse|kogte|drænet|\bglas\b|tetra", both):
        return "kogt (dåse)"
    # 200-449 g is in practice always a can/carton; dried legumes are sold in 500 g and more.
    if re.search(r"\b(2[0-9]{2}|3[0-9]{2}|4[0-4][0-9])\s*(g|gr)\b", both):
        return "kogt (dåse)"
    return None


def _tuna_medium(both: str) -> str | None:
    if re.search(r"i (vand|lage|saltlage|eget)", both):
        return "i vand"
    if re.search(r"i (olie|solsikke|oliven|rapsolie)", both):
        return "i olie"
    return None
