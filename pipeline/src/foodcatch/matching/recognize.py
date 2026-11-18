"""Recognition: listing text (+ optional source category) -> recognized product variants."""

from __future__ import annotations

import re

from foodcatch.matching.attributes import extract_attrs, fat_bucket, fat_ranges
from foodcatch.matching.model import Match, SourceHint
from foodcatch.matching.normalize import normalize
from foodcatch.matching.salling_categories import (
    SALLING_CATEGORY_ATTRS,
    SALLING_CATEGORY_MAP,
    SALLING_NON_STAPLE,
    category_leaf,
)
from foodcatch.matching.taxonomy import ProductType, find_type, get_type
from foodcatch.matching.variants import split_variants

NOTE_TYPE_FROM_DESCRIPTION = "type fundet i beskrivelse"
"""Note on matches whose type was only found in the description (Danish, shown to reviewers)."""

_WORDS = re.compile(r"[a-zæøå]{3,}")
_DESCRIPTION_FALLBACK_GROUP = "Kolonial"


def _match(
    product_type: ProductType, attrs: dict[str, str], variant_text: str, source_hint: SourceHint
) -> Match:
    return Match(
        type_id=product_type.id,
        type_label=product_type.label,
        group_name=product_type.group,
        attrs=attrs,
        key_attrs=product_type.key_attrs,
        variant_text=variant_text,
        source_hint=source_hint,
    )


def _type_variants(
    variants: list[str], hint_type: ProductType | None
) -> list[tuple[str, ProductType | None]]:
    """Recognize the type of each variant text.

    Danish leaves out the shared noun in enumerations ("Grønnelund eller Mammen skæreost",
    "hakkede eller flåede tomater"), so an unrecognized variant other than the last borrows
    the last word of the last variant.
    """
    head_nouns = _WORDS.findall(variants[-1])
    head_noun = head_nouns[-1] if head_nouns else ""
    typed: list[tuple[str, ProductType | None]] = []
    for i, variant in enumerate(variants):
        product_type = hint_type or find_type(variant)
        text = variant
        if product_type is None and i < len(variants) - 1 and head_noun:
            product_type = find_type(f"{variant} {head_noun}")
            if product_type is not None:
                text = f"{variant} {head_noun}"
        typed.append((text, product_type))
    return typed


def classify(title: str, description: str = "", category_hint: str | None = None) -> list[Match]:
    """Recognize the product variant(s) in a listing.

    Args:
        title: offer heading or product name (``"Hakket oksekød 8-12%"``).
        description: offer description / Rema ``underline`` (sizes, brands, fat %). It only
            contributes attributes when the title names a single variant.
        category_hint: the source's category path (Salling ``"A>B>Leaf"``). A mapped leaf
            determines the type (and possibly attributes such as ``mælketype``); a leaf known
            to be a non-staple yields no match at all.

    Returns:
        One :class:`Match` per distinct product class, in title order; empty when nothing is
        recognized. ``offer_variants`` counts every variant of the title, recognized or not.
    """
    desc = normalize(description or "")
    leaf = category_leaf(category_hint) if category_hint else ""
    hint_type_id = SALLING_CATEGORY_MAP.get(leaf) if category_hint else None
    if category_hint and hint_type_id is None and leaf in SALLING_NON_STAPLE:
        return []
    hint_type = get_type(hint_type_id) if hint_type_id else None
    source_hint: SourceHint = "category" if hint_type else "text"

    whole = normalize(title)
    variants = split_variants(title) or [whole]
    typed = _type_variants(variants, hint_type)
    single_variant = len(variants) == 1

    matches: list[Match] = []
    for text, product_type in typed:
        if product_type is None:
            continue
        # Lidl & co.: "Hakket grise- og kalvekød" + description "4-7 % eller 8-12 % fedt":
        # one price for two variants, one per fat range.
        desc_fats = fat_ranges(desc) if "fedt" in product_type.key and not fat_ranges(text) else []
        fat_options = {fat_bucket(product_type.id, r) for r in desc_fats}
        if single_variant and len(fat_options) > 1:
            for lo, hi in desc_fats:
                attrs = extract_attrs(product_type.id, f"{text} {lo:g}-{hi:g}%", desc, whole)
                matches.append(_match(product_type, attrs, text, source_hint))
            continue
        attrs = extract_attrs(product_type.id, text, desc if single_variant else "", whole)
        if hint_type:
            for key, value in SALLING_CATEGORY_ATTRS.get(leaf, {}).items():
                attrs.setdefault(key, value)
        matches.append(_match(product_type, attrs, text, source_hint))

    if not matches and description and not category_hint:
        return _classify_from_description(title, description)

    unmatched = sum(1 for _, product_type in typed if product_type is None)
    return _dedupe(matches, total_variants=len(matches) + unmatched)


def _classify_from_description(title: str, description: str) -> list[Match]:
    """Fallback when the type is only named in the description.

    ``"Mutti tomater"`` / ``"Polpa hakkede eller Pelati flåede"``: only pantry types are accepted,
    since for meat and dairy this produced too many errors (menus, toys ...).
    """
    everything = classify(f"{title} {description}")
    fallback = [m for m in everything if m.group_name == _DESCRIPTION_FALLBACK_GROUP]
    for m in fallback:
        m.notes.append(NOTE_TYPE_FROM_DESCRIPTION)
        m.offer_variants = max(m.offer_variants, len(everything))
    return fallback


def _dedupe(matches: list[Match], *, total_variants: int) -> list[Match]:
    """Keep the first match per class key and record the offer's variant counts on each."""
    per_class: dict[str, int] = {}
    for m in matches:
        per_class[m.class_key] = per_class.get(m.class_key, 0) + 1
    seen: set[str] = set()
    out: list[Match] = []
    for m in matches:
        key = m.class_key
        if key in seen:
            continue
        seen.add(key)
        m.offer_variants, m.same_class_variants = total_variants, per_class[key]
        out.append(m)
    return out
