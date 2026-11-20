"""The stable per-item key ``listing.product_key`` (architecture §5, §7).

Every listing names *one individual item* whose prices can be followed over time
(``api.product_price_history``, ``api.products``). The key is a stored generated column of
``listing`` (an index makes a product's history one index lookup), computed by
:data:`PRODUCT_KEY_SQL`:

``rema:<product id>``
    A REMA 1000 catalogue product (``source = 'rema'``; ``source_item_id`` is Rema's product
    id): every regular and campaign price period of the product, back to the oldest period the
    catalogue still lists.
``ean:<ean>``
    A Salling food-waste clearance of a product with a real GTIN (``product_id`` set; the EAN is
    ``extra.product_code``, which the Salling ingest stores as ``product.ean`` for exactly these
    clearances). ``api.product_price_history`` adds the EAN's shelf prices per chain
    (``product_reference_price``) under the same key.
``clearance:<chain id>:<normalized title>``
    A clearance without a GTIN (variable-weight goods with an in-store code).
``offer:<chain id>:<normalized title>[:<size>]``
    A Tjek leaflet item (offers, and Lidl's "Fast lav pris" regular prices). Tjek has no product
    id, so the key is the chain, the normalized heading and the pack size: **approximate**. The
    size (:func:`size_suffix`, e.g. ``1.5l``, ``0.4-0.5kg``, ``10stk``; left out when unknown)
    keeps "Faxe Kondi" 1.5 l and a 30-can crate apart (migration 0010). Two products with the
    same heading and size still share a key, and a renamed heading or a changed size starts a
    new one.

Title normalization (:func:`normalize_title`, mirrored exactly by :data:`NORMALIZED_TITLE_SQL`):
upper-case ASCII and Nordic/Western accented letters are mapped to lower case by a fixed table
(no locale is involved, so every database computes the same key), every run of characters other
than ``0-9``, ``a-z`` and those lower-case letters becomes one space, and the ends are trimmed:
``"Hakket grisekød 8-12%"`` -> ``"hakket grisekød 8 12"``.

Changing a rule here changes stored keys: it needs a migration that redefines the column.
"""

from __future__ import annotations

import re
from decimal import Decimal
from typing import Final

_UPPER: Final = "ABCDEFGHIJKLMNOPQRSTUVWXYZÆØÅÄÖÜÉÈÊËÁÀÂÍÌÎÏÓÒÔÚÙÛÑÇ"
_LOWER: Final = "abcdefghijklmnopqrstuvwxyzæøåäöüéèêëáàâíìîïóòôúùûñç"
_KEPT: Final = "0-9a-zæøåäöüéèêëáàâíìîïóòôúùûñç"

_TO_LOWER = str.maketrans(_UPPER, _LOWER)
_SEPARATORS = re.compile(f"[^{_KEPT}]+")


def normalize_title(title: str) -> str:
    """The title part of an ``offer:``/``clearance:`` key (see the module docstring).

    >>> normalize_title("  Hakket GRISEKØD, 8-12% ")
    'hakket grisekød 8 12'
    """
    return _SEPARATORS.sub(" ", title.translate(_TO_LOWER)).strip(" ")


def _plain(value: Decimal) -> str:
    """``value`` without trailing zeros or exponent (PostgreSQL ``trim_scale(value)::text``)."""
    return format(value.normalize(), "f")


def size_suffix(unit: str | None, size_min: Decimal | None, size_max: Decimal | None) -> str:
    """The size part of an ``offer:`` key: ``":1.5l"``, ``":0.4-0.5kg"`` or ``""`` (unknown).

    >>> size_suffix("l", Decimal("1.500"), Decimal("1.5"))
    ':1.5l'
    >>> size_suffix("kg", Decimal("0.4"), Decimal("0.5"))
    ':0.4-0.5kg'
    """
    if unit is None or size_min is None:
        return ""
    size = _plain(size_min)
    if size_max is not None and size_max != size_min:
        size += f"-{_plain(size_max)}"
    return f":{size}{unit}"


def product_key(
    *,
    source: str,
    source_item_id: str,
    chain_id: str,
    title: str,
    has_product: bool = False,
    product_code: str | None = None,
    unit: str | None = None,
    size_min: Decimal | None = None,
    size_max: Decimal | None = None,
) -> str:
    """Python mirror of :data:`PRODUCT_KEY_SQL` (used by tests and documentation)."""
    if source == "rema":
        return f"rema:{source_item_id}"
    if source == "salling_food_waste":
        if has_product and product_code is not None:
            return f"ean:{product_code}"
        return f"clearance:{chain_id}:{normalize_title(title)}"
    return f"offer:{chain_id}:{normalize_title(title)}{size_suffix(unit, size_min, size_max)}"


NORMALIZED_TITLE_SQL: Final = (
    f"btrim(regexp_replace(translate(title, '{_UPPER}', '{_LOWER}'), '[^{_KEPT}]+', ' ', 'g'), ' ')"
)
"""SQL for :func:`normalize_title` of the ``title`` column (immutable functions only)."""

SIZE_SUFFIX_SQL: Final = (
    "CASE WHEN unit IS NOT NULL AND size_min IS NOT NULL"
    " THEN ':' || trim_scale(size_min)::text"
    " || CASE WHEN size_max IS NOT NULL AND size_max <> size_min"
    " THEN '-' || trim_scale(size_max)::text ELSE '' END"
    " || unit ELSE '' END"
)
"""SQL for :func:`size_suffix` of the ``unit``/``size_min``/``size_max`` columns."""

PRODUCT_KEY_SQL: Final = (
    "CASE"
    " WHEN source = 'rema' THEN 'rema:' || source_item_id"
    " WHEN source = 'salling_food_waste' AND product_id IS NOT NULL"
    " AND (extra ->> 'product_code') IS NOT NULL THEN 'ean:' || (extra ->> 'product_code')"
    " WHEN source = 'salling_food_waste'"
    f" THEN 'clearance:' || chain_id || ':' || {NORMALIZED_TITLE_SQL}"
    f" ELSE 'offer:' || chain_id || ':' || {NORMALIZED_TITLE_SQL} || {SIZE_SUFFIX_SQL}"
    " END"
)
"""Generation expression of ``listing.product_key`` (migration 0010 holds a frozen copy)."""
