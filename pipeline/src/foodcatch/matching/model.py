"""The :class:`Match` data model: one recognized product variant (contract for deals/persist).

Field and property names are a contract used by ``matching.persist`` (``classification``
columns), ``deals`` and the gold-set tests (``tests/matching/data/*.jsonl``): keep them stable.
Attribute names and values are Danish domain data (``øko``, ``ja``/``nej``/``?``).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

UNKNOWN = "?"
"""Value of a key attribute that could not be determined."""

PROCESSING_ATTR = "forarbejdet"
"""Attribute naming the processing state (``marineret``, ``paneret``, ...); absent = ``nej``."""

type SourceHint = Literal["text", "category"]


@dataclass(slots=True)
class Match:
    """A recognized product variant of a listing.

    Attributes:
        type_id: product type id (``hakket_oksekød``).
        type_label: Danish display label of the type (``Hakket oksekød``).
        group_name: Danish group (``Kød``, ``Mejeri``, ...).
        attrs: attribute values (``{"fedt": "8-12%", "øko": "nej"}``); may include
            :data:`PROCESSING_ATTR`.
        key_attrs: names of all key attributes of this type, in class-key order, including the
            always-relevant ``øko``/``laktosefri`` where applicable.
        variant_text: the normalized text of this variant.
        source_hint: whether the type came from the ``text`` or the source ``category``.
        notes: Danish remarks for humans (e.g. ``type fundet i beskrivelse``).
        offer_variants: number of variants in the whole offer (including unrecognized ones).
        same_class_variants: how many of those share this match's class.
    """

    type_id: str
    type_label: str
    group_name: str
    attrs: dict[str, str]
    key_attrs: tuple[str, ...]
    variant_text: str = ""
    source_hint: SourceHint = "text"
    notes: list[str] = field(default_factory=list[str])
    offer_variants: int = 1
    same_class_variants: int = 1

    @property
    def offer_is_homogeneous(self) -> bool:
        """All variants of the offer are this class, so the offer's unit price applies to it."""
        return self.same_class_variants >= self.offer_variants

    @property
    def class_key(self) -> str:
        """Key for "same product": type, every key attribute and the processing state.

        Example: ``svinemørbrad|øko=nej|laktosefri=nej|forarbejdet=nej``. Contains ``?`` when a
        key attribute is unknown.
        """
        parts = [self.type_id]
        parts += [f"{k}={self.attrs.get(k, UNKNOWN)}" for k in self.key_attrs]
        parts.append(f"{PROCESSING_ATTR}={self.attrs.get(PROCESSING_ATTR, 'nej')}")
        return "|".join(parts)

    @property
    def is_exact(self) -> bool:
        """All key attributes are known."""
        return UNKNOWN not in self.class_key

    @property
    def class_label(self) -> str:
        """Danish human-readable label of the class (``Mælk, letmælk, økologisk``)."""
        bits = [self.type_label]
        for k in self.key_attrs:
            v = self.attrs.get(k, UNKNOWN)
            if k in ("øko", "laktosefri"):
                word = "økologisk" if k == "øko" else "laktosefri"
                if v != "nej":
                    bits.append(word if v == "ja" else f"{word}?")
            elif k == "tilsat_vand":
                bits.append({"ja": "tilsat vand", "nej": "uden tilsat vand"}.get(v, "tilsat vand?"))
            else:
                bits.append(v if v != UNKNOWN else f"{k}?")
        if self.attrs.get(PROCESSING_ATTR):
            bits.append(f"[{self.attrs[PROCESSING_ATTR]}]")
        return ", ".join(bits)
