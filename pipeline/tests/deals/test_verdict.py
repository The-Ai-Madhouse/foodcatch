"""The Python verdict mirror against the shared cases in ``fixtures/verdict_cases.json``."""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from foodcatch.deals.verdict import (
    DealInput,
    Reference,
    counted_references,
    parse_references,
    verdict,
)

# Read at collection time so every shared case becomes its own test id.
_CASES_PATH = Path(__file__).resolve().parents[3] / "fixtures" / "verdict_cases.json"
_CASES: list[dict[str, Any]] = json.loads(_CASES_PATH.read_text(encoding="utf-8"))["cases"]


def _deal_input(raw: dict[str, Any]) -> DealInput:
    return DealInput(
        netto_unit_price_worst=raw["netto_unit_price_worst"],
        netto_unit_price_best=raw["netto_unit_price_best"],
        price_applies=raw["price_applies"],
        is_exact=raw["is_exact"],
        references=parse_references(raw["references"]),
    )


@pytest.mark.parametrize("case", _CASES, ids=[c["name"] for c in _CASES])
def test_shared_verdict_case(case: dict[str, Any]) -> None:
    result = verdict(_deal_input(case["deal"]), case["nearby_chains"])
    expected = case["expected"]
    assert result.verdict == expected["verdict"]
    assert result.cheapest_unit_price == expected["cheapest_unit_price"]
    assert result.reference_count == expected["reference_count"]


def test_shared_fixture_is_the_file_used_for_parametrization(
    shared_fixture: Callable[[str], Any],
) -> None:
    assert shared_fixture("verdict_cases.json")["cases"] == _CASES
    assert len(_CASES) >= 10


def test_parse_references_accepts_the_stored_json_shape() -> None:
    refs = parse_references(
        [
            {
                "kind": "history",
                "chain_id": "netto",
                "listing_id": "8f0c7a52-37b4-4c41-9d6c-0b1a5a5c1e01",
                "title": "Hakket grisekød 8-12%",
                "unit_price": 33.33,
                "unit": "kg",
                "valid_from": "2026-11-01T00:00:00+00:00",
                "valid_to": "2026-11-07T22:59:59+00:00",
            }
        ]
    )
    assert refs == (
        Reference(
            kind="history",
            chain_id="netto",
            unit_price=33.33,
            listing_id="8f0c7a52-37b4-4c41-9d6c-0b1a5a5c1e01",
            title="Hakket grisekød 8-12%",
            unit="kg",
            valid_from=datetime(2026, 11, 1, tzinfo=UTC),
            valid_to=datetime(2026, 11, 7, 22, 59, 59, tzinfo=UTC),
        ),
    )


def test_parse_references_rejects_unknown_kind() -> None:
    with pytest.raises(ValidationError):
        parse_references([{"kind": "rumour", "chain_id": "lidl", "unit_price": 1.0}])


def test_missing_best_price_falls_back_to_worst() -> None:
    deal = DealInput(
        netto_unit_price_worst=50.0,
        netto_unit_price_best=None,
        price_applies=True,
        is_exact=True,
        references=(Reference(kind="offer", chain_id="lidl", unit_price=45.0),),
    )
    assert verdict(deal, {"lidl"}).verdict == "cheaper_elsewhere"


def test_counted_references_filter_by_location_except_history_and_ean() -> None:
    refs = (
        Reference(kind="offer", chain_id="lidl", unit_price=1.0),
        Reference(kind="regular", chain_id="rema1000", unit_price=2.0),
        Reference(kind="history", chain_id="netto", unit_price=3.0),
        Reference(kind="ean_reference", chain_id="foetex", unit_price=4.0),
    )
    deal = DealInput(10.0, 10.0, price_applies=True, is_exact=True, references=refs)
    assert [r.unit_price for r in counted_references(deal, ["rema1000"])] == [2.0, 3.0, 4.0]
