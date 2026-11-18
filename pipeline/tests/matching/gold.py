"""Loading the PoC gold sets in ``tests/matching/data`` (shared by the matching tests)."""

from __future__ import annotations

import json
from functools import cache
from pathlib import Path
from typing import Any, TypedDict

from foodcatch.matching import Match, is_healthy_staple

DATA_DIR = Path(__file__).parent / "data"


class ExpectedMatch(TypedDict):
    """One recognized variant as recorded from the PoC."""

    type_id: str
    attrs: dict[str, str]
    class_key: str
    is_exact: bool
    is_healthy: bool
    offer_variants: int
    same_class_variants: int
    notes: list[str]
    label: str


class OfferText(TypedDict):
    """A Tjek offer or Rema product text with the PoC's recognition result."""

    source: str
    chain: str
    title: str
    description: str
    expected: list[ExpectedMatch]


class SallingProduct(TypedDict):
    """A Salling food-waste product (EAN) with its category and the PoC's results."""

    ean: str
    name: str
    category: str | None
    expected_text_only: list[ExpectedMatch]
    expected_with_category: list[ExpectedMatch]


def _read_jsonl(name: str) -> list[Any]:
    with (DATA_DIR / name).open(encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


@cache
def offer_texts() -> tuple[OfferText, ...]:
    """The 7996 Tjek/Rema texts of ``offer_texts_snapshot.jsonl``."""
    return tuple(_read_jsonl("offer_texts_snapshot.jsonl"))


@cache
def salling_products() -> tuple[SallingProduct, ...]:
    """The 1317 Salling products of ``salling_gold.jsonl``."""
    return tuple(_read_jsonl("salling_gold.jsonl"))


def as_expected(m: Match) -> ExpectedMatch:
    """``m`` in the gold-set representation."""
    return {
        "type_id": m.type_id,
        "attrs": dict(m.attrs),
        "class_key": m.class_key,
        "is_exact": m.is_exact,
        "is_healthy": is_healthy_staple(m),
        "offer_variants": m.offer_variants,
        "same_class_variants": m.same_class_variants,
        "notes": list(m.notes),
        "label": m.class_label,
    }
