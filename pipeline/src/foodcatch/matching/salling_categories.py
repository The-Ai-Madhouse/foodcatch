"""Salling Group category paths -> product types (used for EAN products from food waste).

Salling's own category (``"Mejeri & køl>Mælk>Letmælk"``) is more reliable than the abbreviated
product name, so its leaf (last segment) wins over text recognition when it is mapped. Paths
may repeat segments (``"A>B>C>A>B>D"``); only the leaf matters.
"""

from __future__ import annotations

from collections.abc import Mapping


def category_leaf(path: str | None) -> str:
    """The last segment of a ``>``-separated category path (``""`` for ``None``)."""
    return (path or "").split(">")[-1].strip()


SALLING_CATEGORY_MAP: Mapping[str, str] = {
    "Hakket grise- & kalvekød": "hakket_gris_kalv",
    "Hakket grisekød": "hakket_grisekød",
    "Hakket oksekød": "hakket_oksekød",
    "Hakket kylling": "hakket_kylling",
    "Svinemørbrad": "svinemørbrad",
    "Letmælk": "mælk",
    "Minimælk": "mælk",
    "Skummetmælk": "mælk",
    "Sødmælk": "mælk",
    "Kærnemælk": "kærnemælk",
    "Piskefløde": "piskefløde",
    "Madlavningsfløde": "madlavningsfløde",
    "Smør": "smør",
    "Smørbart": "smørbar",
    "Hytteost": "hytteost",
    "Mozzarella": "mozzarella",
    "Feta & salatost": "feta",
    "Revet ost & topping": "fast_ost",
    "Ost i skiver": "fast_ost",
    "Skæreost": "fast_ost",
    "Skyr": "skyr",
    "A38, tykmælk & ymer": "a38_ymer",
}
"""Category leaf -> product type id."""

SALLING_CATEGORY_ATTRS: Mapping[str, Mapping[str, str]] = {
    "Revet ost & topping": {"form": "revet"},
    "Ost i skiver": {"form": "skiver"},
    "Skæreost": {"form": "blok"},
    "Letmælk": {"mælketype": "letmælk"},
    "Minimælk": {"mælketype": "minimælk"},
    "Skummetmælk": {"mælketype": "skummetmælk"},
    "Sødmælk": {"mælketype": "sødmælk"},
}
"""Attributes a category leaf determines when the product name does not say otherwise."""

SALLING_NON_STAPLE: frozenset[str] = frozenset(
    {
        "Kyllingepålæg",
        "Tilberedt kylling",
        "Grisepølser",
        "Kyllingepølser",
        "Medister",
        "Smøreost",
        "Snackost",
        "Dessert & snacks",
        "Kolde kaffedrikke & kakao",
        "Koldskål",
        "Mælkedrikke",
        "Drikke- & børneyoghurt",
        "Margarine",
        "Fedt",
        "Spareribs & barbecuekød",
        "Hønse- & kyllingesalat",
        "Middagsretter",
        "Sandwiches & wraps",
        "Oliven & andet tilbehør",
        "Naan- & fladbrød",
    }
)
"""Category leaves that are certainly not staples: such products are never recognized."""
