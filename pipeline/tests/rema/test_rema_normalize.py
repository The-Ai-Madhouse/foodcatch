"""Rema ingest: pure normalization (no database)."""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from uuid import uuid4

import pytest

from foodcatch.ingest.rema import (
    COPENHAGEN,
    ORGANIC_HINT,
    build_listing,
    describe,
    normalize_page,
    normalize_unit,
    to_valid_from,
    to_valid_to,
)
from foodcatch.sources.rema import RemaPrice, RemaProduct, RemaProductPage

FIXTURE = "rema/products_page1.json"


@pytest.fixture
def products(fixture_bytes: Callable[[str], bytes]) -> dict[int, RemaProduct]:
    page = RemaProductPage.model_validate_json(fixture_bytes(FIXTURE))
    return {p.id: p for p in page.data}


def _product(**overrides: Any) -> RemaProduct:
    price: dict[str, Any] = {
        "price": 10,
        "is_campaign": False,
        "starting_at": "2026-11-01T00:00:00+00:00",
        "ending_at": "2099-12-31T00:00:00+00:00",
        "compare_unit": "kg",
        "compare_unit_price": 20,
    }
    price.update(overrides.pop("price", {}))
    return RemaProduct.model_validate(
        {"id": 1, "name": "HAVREGRYN", "underline": "500 GR.", "prices": [price], **overrides}
    )


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("kg", "kg"),
        ("KG", "kg"),
        ("ltr", "l"),
        ("liter", "l"),
        ("l", "l"),
        ("stk", "stk"),
        ("stk.", "stk"),
        (" Stk. ", "stk"),
        ("ml", None),  # compare prices per ml are rounded to 2 decimals: too imprecise
        ("mtr", None),
        ("sæt", None),
        ("par", None),
        ("rl", None),
        ("", None),
        (None, None),
    ],
)
def test_normalize_unit(raw: str | None, expected: str | None) -> None:
    assert normalize_unit(raw) == expected


def test_calendar_dates_are_danish_days() -> None:
    start = datetime(2026, 11, 15, tzinfo=UTC)
    end = datetime(2026, 11, 21, tzinfo=UTC)
    assert to_valid_from(start) == datetime(2026, 11, 15, tzinfo=COPENHAGEN)
    assert to_valid_to(end) == datetime(2026, 11, 22, tzinfo=COPENHAGEN)
    # summer time is handled by the zone
    assert to_valid_from(datetime(2026, 7, 1, tzinfo=UTC)).utcoffset().total_seconds() == 7200  # type: ignore[union-attr]


def test_far_future_end_means_open_ended() -> None:
    assert to_valid_to(datetime(2099, 12, 31, tzinfo=UTC)) is None


def test_precise_timestamps_are_kept() -> None:
    ts = datetime(2026, 11, 15, 6, 30, tzinfo=UTC)
    assert to_valid_from(ts) == ts
    assert to_valid_to(ts) == ts


def test_regular_price(products: dict[int, RemaProduct]) -> None:
    product = products[100004]
    item = build_listing(product, product.prices[0])
    assert item is not None
    assert item.source_item_id == "100004"
    assert item.kind == "regular"
    assert item.title == "JORDBÆRMARMELADE"
    assert item.description == "285 GR. / EASIS"
    assert item.price == Decimal("23.95")
    assert item.unit == "kg"
    assert item.unit_price == Decimal("84.0400")
    assert item.size == Decimal("0.285")  # 23.95 / 84.04 kr/kg
    assert item.valid_from == datetime(2025, 11, 20, tzinfo=COPENHAGEN)
    assert item.valid_to is None
    assert item.max_per_customer is None
    row = item.as_row(raw_object_id=uuid4())
    assert row["source"] == "rema"
    assert row["chain_id"] == "rema1000"
    assert row["member_only"] is False
    assert row["size_min"] == row["size_max"] == item.size
    assert row["unit_price_min"] == row["unit_price_max"] == item.unit_price


def test_campaign_and_following_regular_price(products: dict[int, RemaProduct]) -> None:
    product = products[100529]  # campaign 15-21 Nov, regular price from 22 Nov
    campaign, regular = (build_listing(product, p) for p in product.prices)
    assert campaign is not None
    assert regular is not None
    assert campaign.kind == "offer"
    assert campaign.price == Decimal("20.00")
    assert campaign.size == Decimal("0.500")
    assert campaign.valid_to == regular.valid_from == datetime(2026, 11, 22, tzinfo=COPENHAGEN)
    assert regular.kind == "regular"
    assert regular.price == Decimal("27.95")
    assert regular.valid_to == datetime(2026, 12, 6, tzinfo=COPENHAGEN)


def test_max_quantity_and_deposit(products: dict[int, RemaProduct]) -> None:
    product = products[200101]
    item = build_listing(product, product.prices[0])
    assert item is not None
    assert item.max_per_customer == 12
    assert item.unit == "l"
    assert item.extra["deposit"] == 6.0
    assert item.extra["price_over_max_quantity"] == 43.5
    assert item.extra["is_advertised"] is True


def test_stk_unit(products: dict[int, RemaProduct]) -> None:
    product = products[130005]
    item = build_listing(product, product.prices[0])
    assert item is not None
    assert item.unit == "stk"
    assert item.size == Decimal("26.033")  # rounded compare price -> approximate size


def test_unknown_unit_has_no_unit_price(products: dict[int, RemaProduct]) -> None:
    product = products[136810]  # dental floss priced per metre
    item = build_listing(product, product.prices[0])
    assert item is not None
    assert (item.unit, item.unit_price, item.size) == (None, None, None)
    assert item.extra["compare_unit"] == "mtr"


def test_missing_compare_price_has_no_unit_price() -> None:
    product = _product(price={"compare_unit_price": None})
    item = build_listing(product, product.prices[0])
    assert item is not None
    assert (item.unit, item.unit_price, item.size) == (None, None, None)


def test_weight_item(products: dict[int, RemaProduct]) -> None:
    # Loose tomatoes: the price is for a typical piece (0.12 kg), the compare price per kg.
    product = products[306137]
    item = build_listing(product, product.prices[0])
    assert item is not None
    assert item.extra["is_weight_item"] is True
    assert item.kind == "regular"
    assert (item.unit, item.unit_price) == ("kg", Decimal("30.0000"))
    assert item.size == Decimal("0.115")  # 3.45 / 30

    joint = products[413723]  # RØGET RIBBENSTEG, 0.9 kg at 79.90 kr/kg
    item = build_listing(joint, joint.prices[0])
    assert item is not None
    assert item.extra["is_weight_item"] is True
    assert (item.price, item.unit_price, item.size) == (
        Decimal("71.91"),
        Decimal("79.9000"),
        Decimal("0.900"),
    )


def test_period_ending_before_it_starts_is_skipped() -> None:
    product = _product(
        price={"starting_at": "2026-11-10T00:00:00+00:00", "ending_at": "2026-11-01T00:00:00+00:00"}
    )
    assert build_listing(product, product.prices[0]) is None


def test_organic_label_without_text_adds_a_hint(products: dict[int, RemaProduct]) -> None:
    oat_drink = products[100325]  # "HAVREDRIK" / "1 LTR. / PLANTEKØKKENET", label Økologi
    assert describe(oat_drink) == f"1 LTR. / PLANTEKØKKENET / {ORGANIC_HINT}"
    oats = products[180055]  # the underline already says ØKOLOGISK
    assert describe(oats) == "1 KG. / REMA 1000, ØKOLOGISK"
    assert describe(products[100004]) == "285 GR. / EASIS"  # no organic label


def test_organic_hint_without_underline() -> None:
    product = _product(underline="", labels=[{"name": "Økologi"}])
    assert describe(product) == ORGANIC_HINT


def test_normalize_page_counts_and_dedupes(fixture_bytes: Callable[[str], bytes]) -> None:
    page = RemaProductPage.model_validate_json(fixture_bytes(FIXTURE))
    normalized = normalize_page(page)
    assert len(normalized.listings) == 15  # 12 products, three with a second price period
    assert normalized.counts["rema_products"] == 12
    assert normalized.counts["rema_prices_without_unit_price"] == 1

    duplicate = page.model_copy(update={"data": [*page.data, page.data[0]]})
    normalized = normalize_page(duplicate)
    assert len(normalized.listings) == 15
    assert normalized.counts["rema_duplicate_prices"] == 1


def test_price_model_rejects_negative_prices() -> None:
    with pytest.raises(ValueError, match="greater than or equal"):
        RemaPrice.model_validate(
            {
                "price": -1,
                "is_campaign": False,
                "starting_at": "2026-11-01T00:00:00+00:00",
                "ending_at": "2099-12-31T00:00:00+00:00",
            }
        )
