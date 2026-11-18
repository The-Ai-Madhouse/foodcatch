"""Product types recognized by FoodCatch (the staple taxonomy).

Each :class:`ProductType` is recognized by an ``include`` regex that must match and an optional
``exclude`` regex that must not match the normalized text. **Order matters**: the first matching
type wins, so specific types come before general ones (``kærnemælk`` before ``mælk``).

``key`` lists the type-specific key attributes: attributes that must be known and equal for two
products to be "the same product". Organic (``øko``) and lactose-free (``laktosefri``) always
change the price and are appended by :attr:`ProductType.key_attrs`.

Regexes and labels are Danish domain data and must stay byte-for-byte compatible with the
gold sets in ``tests/matching/data``; any change requires a new ``MATCHER_VERSION``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

type Unit = Literal["kg", "l", "stk"]

ALWAYS_KEY_ATTRS: tuple[str, ...] = ("øko", "laktosefri")
"""Attributes that always change the price and are therefore always key attributes."""

FLAVOURS = (
    r"jordbær|blåbær|hindbær|kirsebær|vanilje|mango|passion|banan|fersken|ananas|æble|rabarber|"
    r"citron|lemon|skovbær|hyldeblomst|kokos|müsli|granola|honning|karamel|stracciatella|frugt|"
    r"smag|bær\b|pære|abrikos|mynte|kaffe|choko|appelsin|melba|peach|lime|tropisk|multifrugt|"
    r"blåbær|solbær"
)
"""Flavour words: a yoghurt/milk mentioning one of these is flavoured (not a plain staple)."""

CHEESE_FAT = (
    r"\b(13|20|30|40|45|50|60)\+\s*(ml\b|mk\b|mild|mellemlagret|lagret|ekstra|ost|kommen|skiver)|"
    r"(mild|mellemlagret|lagret|\bml|ekstralagret)\s*(13|20|30|40|45|50|60)\+"
)
"""Cheese fat grade (``45+``) - only in a cheese context (not ``45+ lyde``, ``Livol 50+``)."""


@dataclass(frozen=True, slots=True)
class ProductType:
    """A recognizable staple product type.

    Attributes:
        id: stable identifier (``hakket_oksekød``); part of every class key.
        label: Danish display label.
        group: Danish group (``Kød``, ``Æg``, ``Mejeri``, ``Kolonial``).
        include: pattern that must match the normalized text.
        exclude: pattern that must not match (``None``: nothing is excluded).
        key: type-specific key attributes, in class-key order.
        unit: the unit prices of this type are compared in.
    """

    id: str
    label: str
    group: str
    include: re.Pattern[str]
    exclude: re.Pattern[str] | None = None
    key: tuple[str, ...] = ()
    unit: Unit = "kg"

    def matches(self, text: str) -> bool:
        """Whether normalized ``text`` is of this type."""
        if not self.include.search(text):
            return False
        return self.exclude is None or not self.exclude.search(text)

    @property
    def key_attrs(self) -> tuple[str, ...]:
        """All key attributes: :attr:`key` plus organic/lactose-free.

        For eggs, organic is part of ``produktion`` and therefore not a separate key.
        """
        extra = tuple(k for k in ALWAYS_KEY_ATTRS if k not in self.key)
        if self.id == "æg":
            extra = tuple(k for k in extra if k != "øko")
        return self.key + extra


def _type(
    type_id: str,
    label: str,
    group: str,
    include: str,
    *,
    exclude: str | None = None,
    key: tuple[str, ...] = (),
    unit: Unit = "kg",
) -> ProductType:
    return ProductType(
        id=type_id,
        label=label,
        group=group,
        include=re.compile(include),
        exclude=re.compile(exclude) if exclude is not None else None,
        key=key,
        unit=unit,
    )


_OTHER_SPECIES = r"\bkalv|\bokse|\blam(me|\b)|kalkun|kylling|\bhjort|vild|\band(e)?mørbrad"
"""Other animals than pig in a cut's name ("Kalvemørbrad", "Koteletter af lam", "Vildsvin")."""

PRODUCT_TYPES: tuple[ProductType, ...] = (
    # ---------------------------------------------------------------- meat
    _type(
        "hakket_gris_kalv",
        "Hakket grise- og kalvekød",
        "Kød",
        r"(hakket|fars).{0,12}gris[e]?[- ]*(og|&|/)\s*kalv|gris[e]?\s*(&|/|og)\s*kalv",
        key=("fedt",),
    ),
    _type(
        "hakket_okse_gris",
        "Hakket okse- og grisekød",
        "Kød",
        r"okse-?\s*(og|&|/)\s*grise?|grise-?\s*(og|&|/)\s*okse",
        key=("fedt",),
    ),
    _type(
        "hakket_oksekød",
        "Hakket oksekød",
        "Kød",
        r"hakket( \w+){0,2} (oksekød|kødkvæg)|hakket okse\b|oksefars",
        exclude=r"grøn|grøntsager|okse/grøn|okse-?\s*(og|&)\s*gris",
        key=("fedt",),
    ),
    _type(
        "hakket_grisekød",
        "Hakket grisekød",
        "Kød",
        r"hakket( \w+){0,2} (grise|svine)kød|hakket gris\b|grisefars|svinefars|"
        r"gris.{0,12}hakkekød|hakkekød.{0,12}gris",
        key=("fedt",),
    ),
    _type(
        "hakket_kylling",
        "Hakket kylling",
        "Kød",
        r"hakket( \w+){0,2} kylling|kyllingefars",
        key=("fedt",),
    ),
    _type("hakket_kalkun", "Hakket kalkun", "Kød", r"hakket kalkun", key=("fedt",)),
    _type(
        "kyllingeinderfilet",
        "Kyllingeinderfilet",
        "Kød",
        r"kyllinge?\s*-?\s*inderfilet|inderfilet af kylling",
        key=("tilsat_vand",),
    ),
    _type(
        "kyllingebryst",
        "Kyllingebryst(filet)",
        "Kød",
        r"kyllinge?\s*-?\s*bryst|kyllingfilet|kyllingefilet",
        key=("tilsat_vand",),
    ),
    _type(
        "kyllingelår",
        "Kyllingelår",
        "Kød",
        r"kyllinge?\s*-?\s*(under|over|hele\s*)?lår|kylling hele lår|(under|over)lår",
        key=("udskæring",),
    ),
    _type("hel_kylling", "Hel kylling", "Kød", r"hel(e)? kylling|helkylling"),
    # "koteletter" / "mørbrad" alone are pork, but not when another animal is named.
    _type(
        "svinekoteletter",
        "Svinekoteletter",
        "Kød",
        r"\bkoteletter|svinekotelet",
        exclude=_OTHER_SPECIES,
    ),
    _type(
        "svinemørbrad",
        "Svinemørbrad",
        "Kød",
        r"(svine|grise)?mørbrad",
        exclude=rf"a ?la|ala\b|bøffer|{_OTHER_SPECIES}",
    ),
    # ---------------------------------------------------------------- eggs
    _type(
        "æg",
        "Æg",
        "Æg",
        r"(^|\W)æg(\W|$)|skrabeæg|frilandsæg|buræg|økologiske æg",
        exclude=r"påske|chokolade|kinder|overrask|dino|ægge(salat|nudler)|nudler|pasta|"
        r"æggehvide|smadr|spejle|spil\b|æggeur",
        key=("produktion",),
        unit="stk",
    ),
    # ---------------------------------------------------------------- dairy
    _type("kærnemælk", "Kærnemælk", "Mejeri", r"kærnemælk", key=("øko",), unit="l"),
    _type(
        "mælk",
        "Mælk",
        "Mejeri",
        r"skummetmælk|minimælk|letmælk|sødmælk|jerseymælk|(^|\W)mælk(\W|$)",
        exclude=r"kakao|choko|kaffe|barista|havre|mandel|soja|ris(drik|mælk)|mælkesnitte|"
        r"mælkechokolade|kondens|drikke|protein|brød|kiks|nød|ritter|med (" + FLAVOURS + ")",
        key=("mælketype", "øko", "laktosefri"),
        unit="l",
    ),
    _type(
        "piskefløde",
        "Piskefløde",
        "Mejeri",
        r"piskefløde|fløde 3[68]\s*%|pisk\.?\s*fløde",
        exclude=r"cremefine|plante|piskbar",
        key=("øko", "laktosefri"),
        unit="l",
    ),
    _type(
        "madlavningsfløde",
        "Madlavningsfløde",
        "Mejeri",
        r"madlavningsfløde|madfløde|kogefløde",
        exclude=r"jævner|cremefine",
        key=("fedt",),
        unit="l",
    ),
    _type(
        "creme_fraiche",
        "Creme fraiche",
        "Mejeri",
        r"creme ?fraiche|cremefraiche|fraiche",
        exclude=r"plante|frisk",
        key=("fedt",),
    ),
    _type(
        "smørbar",
        "Smørbar (blandingsprodukt)",
        "Mejeri",
        r"smørbar|smørbart|blandingsprodukt|smør\s*(&|og)\s*(raps|olie)|kærgården",
        exclude=r"plante",
        key=("øko",),
    ),
    _type(
        "smør",
        "Smør",
        "Mejeri",
        r"(^|\W)smør(\W|$)",
        exclude=r"jordnødde|peanut|smørrebrød|smørbagt|smørcroissant|hvidløg|kryddersmør|"
        r"plante|citron",
        key=("øko",),
    ),
    _type("hytteost", "Hytteost", "Mejeri", r"hytteost", exclude=r"salat|frugt"),
    _type(
        "mozzarella",
        "Mozzarella",
        "Mejeri",
        r"mozzarella",
        exclude=r"revet|stick|panere",
        key=("øko",),
    ),
    _type("feta", "Feta/salatost", "Mejeri", r"\bfeta\b|salatost", exclude=r"oliven|peber|tapas"),
    _type(
        "fast_ost",
        "Fast ost",
        "Mejeri",
        r"skæreost|skiveost|danbo|havarti|samsø|gouda|cheddar|revet ost|ost i skiver|"
        + CHEESE_FAT
        + "|"
        r"revet (mozzarella|pizzaost|emmentaler)",
        exclude=r"smøreost|flødeost|ostehaps|hapser|snack|ostepops|ostestænger|kage|pizza|kiks|"
        r"chips|dipper|cubes|grillost|brie|camembert|skimmel|gedeost|parmesan|peber|oliven|"
        r"peppadew|pesto|kartof|agurk|gulerod|salat\b|grøntsag|kål\b",
        key=("form",),
    ),
    _type("skyr", "Skyr", "Mejeri", r"skyr", exclude=r"drikke|drik\b|bar\b|is\b", key=("smag",)),
    _type(
        "græsk_yoghurt", "Græsk yoghurt", "Mejeri", r"græsk(-inspireret)? yoghurt", key=("smag",)
    ),
    _type("a38_ymer", "A38/ymer/tykmælk", "Mejeri", r"\ba38\b|\bymer\b|tykmælk", key=("smag",)),
    _type(
        "yoghurt",
        "Yoghurt",
        "Mejeri",
        r"yoghurt",
        exclude=r"drik|actimel|kefir|plante|gurt\b|bar\b|is\b|frossen",
        key=("smag", "fedt"),
    ),
    # ---------------------------------------------------------------- pantry
    _type(
        "hakkede_tomater",
        "Hakkede tomater (dåse)",
        "Kolonial",
        r"(fint?)?hakkede tomater|polpa|tomater.{0,10}hakkede|hakkede.{0,10}tomater",
    ),
    _type(
        "flåede_tomater",
        "Flåede tomater (dåse)",
        "Kolonial",
        r"flåede tomater|pelati|hele flåede",
    ),
    _type("passata", "Passata", "Kolonial", r"passata|tomatpassata"),
    _type(
        "tomatpuré", "Tomatpuré", "Kolonial", r"tomatpur[eé]|tomatkoncentrat", exclude=r"ketchup"
    ),
    _type(
        "kikærter",
        "Kikærter",
        "Kolonial",
        r"kikærter",
        exclude=r"snack|chips|ristede|hummus",
        key=("form",),
    ),
    _type("kidneybønner", "Kidneybønner", "Kolonial", r"kidney", key=("form",)),
    _type("sorte_bønner", "Sorte bønner", "Kolonial", r"sorte bønner", key=("form",)),
    _type(
        "hvide_bønner",
        "Hvide bønner",
        "Kolonial",
        r"hvide bønner|butter\s*beans|cannellini|borlotti",
        exclude=r"tomat|baked",
        key=("form",),
    ),
    _type(
        "linser",
        "Linser",
        "Kolonial",
        r"linser",
        exclude=r"chips|snack|pasta|kontakt",
        key=("form",),
    ),
    _type(
        "tun",
        "Tun (dåse)",
        "Kolonial",
        r"(^|\W)tun(\W|$)|tunfisk|yellowfin",
        exclude=r"salat|mousse|tunge|tunnel",
        key=("medium",),
    ),
    _type(
        "havregryn",
        "Havregryn",
        "Kolonial",
        r"havregryn|grovvalsede|finvalsede",
        exclude=r"kugler|bar\b|cookies|granola|müsli|drik|kiks",
        key=("øko",),
    ),
)
"""All product types in recognition order (specific before general)."""

TYPE_BY_ID: dict[str, ProductType] = {t.id: t for t in PRODUCT_TYPES}
"""Product types by :attr:`ProductType.id`."""


class UnknownProductTypeError(KeyError):
    """Raised for a ``type_id`` that is not part of the taxonomy."""


def get_type(type_id: str) -> ProductType:
    """The product type ``type_id``; raises :class:`UnknownProductTypeError` if unknown."""
    try:
        return TYPE_BY_ID[type_id]
    except KeyError as exc:
        raise UnknownProductTypeError(type_id) from exc


def find_type(text: str) -> ProductType | None:
    """The first product type matching normalized ``text``, or ``None``."""
    for product_type in PRODUCT_TYPES:
        if product_type.matches(text):
            return product_type
    return None
