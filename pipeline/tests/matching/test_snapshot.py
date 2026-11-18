"""Behavioural equivalence with the proof of concept, record by record.

The gold sets were produced by ``poc/matching.py``; the production matcher must reproduce every
recognized type, attribute, class key, exactness, health verdict, variant count, note and label.
"""

from __future__ import annotations

import pytest

from foodcatch.matching import classify
from matching.gold import OfferText, SallingProduct, as_expected, offer_texts, salling_products


def _offer_id(record: OfferText) -> str:
    return f"{record['source']}:{record['title'][:40]}"


def _salling_id(record: SallingProduct) -> str:
    return record["ean"]


@pytest.mark.parametrize("record", offer_texts(), ids=_offer_id)
def test_offer_text_matches_poc(record: OfferText) -> None:
    got = [as_expected(m) for m in classify(record["title"], record["description"])]
    assert got == record["expected"]


@pytest.mark.parametrize("record", salling_products(), ids=_salling_id)
def test_salling_name_only_matches_poc(record: SallingProduct) -> None:
    got = [as_expected(m) for m in classify(record["name"])]
    assert got == record["expected_text_only"]


@pytest.mark.parametrize("record", salling_products(), ids=_salling_id)
def test_salling_with_category_matches_poc(record: SallingProduct) -> None:
    category = record["category"]
    if category is None:
        # The gold set records no category-based result for products without a category;
        # their text-only result is covered by test_salling_name_only_matches_poc.
        assert record["expected_with_category"] == []
        return
    got = [as_expected(m) for m in classify(record["name"], category_hint=category)]
    assert got == record["expected_with_category"]


def test_gold_sets_are_complete() -> None:
    assert len(offer_texts()) == 7996
    assert len(salling_products()) == 1317
