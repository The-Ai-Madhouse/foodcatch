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
``offer:<chain id>:<normalized title>``
    A Tjek leaflet item (offers, and Lidl's "Fast lav pris" regular prices). Tjek has no product
    id, so the key is the chain plus the normalized heading: **approximate**. Two products with
    the same heading share a key, and a renamed heading starts a new one.

Title normalization (:func:`normalize_title`, mirrored exactly by :data:`NORMALIZED_TITLE_SQL`):
upper-case ASCII and Nordic/Western accented letters are mapped to lower case by a fixed table
(no locale is involved, so every database computes the same key), every run of characters other
than ``0-9``, ``a-z`` and those lower-case letters becomes one space, and the ends are trimmed:
``"Hakket grisekød 8-12%"`` -> ``"hakket grisekød 8 12"``.

Changing a rule here changes stored keys: it needs a migration that redefines the column.
"""

from __future__ import annotations

import re
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


def product_key(
    *,
    source: str,
    source_item_id: str,
    chain_id: str,
    title: str,
    has_product: bool = False,
    product_code: str | None = None,
) -> str:
    """Python mirror of :data:`PRODUCT_KEY_SQL` (used by tests and documentation)."""
    if source == "rema":
        return f"rema:{source_item_id}"
    if source == "salling_food_waste":
        if has_product and product_code is not None:
            return f"ean:{product_code}"
        return f"clearance:{chain_id}:{normalize_title(title)}"
    return f"offer:{chain_id}:{normalize_title(title)}"


NORMALIZED_TITLE_SQL: Final = (
    f"btrim(regexp_replace(translate(title, '{_UPPER}', '{_LOWER}'), '[^{_KEPT}]+', ' ', 'g'), ' ')"
)
"""SQL for :func:`normalize_title` of the ``title`` column (immutable functions only)."""

PRODUCT_KEY_SQL: Final = (
    "CASE"
    " WHEN source = 'rema' THEN 'rema:' || source_item_id"
    " WHEN source = 'salling_food_waste' AND product_id IS NOT NULL"
    " AND (extra ->> 'product_code') IS NOT NULL THEN 'ean:' || (extra ->> 'product_code')"
    " WHEN source = 'salling_food_waste'"
    f" THEN 'clearance:' || chain_id || ':' || {NORMALIZED_TITLE_SQL}"
    f" ELSE 'offer:' || chain_id || ':' || {NORMALIZED_TITLE_SQL}"
    " END"
)
"""Generation expression of ``listing.product_key`` (migration 0008 holds a frozen copy)."""
