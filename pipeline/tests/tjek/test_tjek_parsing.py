"""Offer normalization (port of the PoC's ``parse_tjek_offer``) on recorded and edge cases."""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import pytest

from foodcatch.ingest.tjek import (
    ParsedOffer,
    UnitQuantity,
    is_fixed_low_price,
    is_member_price,
    parse_amount,
    parse_max_per_customer,
    parse_normal_price,
    parse_offer,
    unit_quantity,
)
from foodcatch.sources.tjek import OFFER_PAGE, TjekOffer, TjekQuantity

D = Decimal


def quantity(
    si: str | None = "kg",
    factor: float | None = 0.001,
    size: tuple[float | None, float | None] | None = (400, 400),
    pieces: float | tuple[float, float] | None = 1,
) -> TjekQuantity:
    lo, hi = pieces if isinstance(pieces, tuple) else (pieces, pieces)
    raw: dict[str, Any] = {
        "unit": {"symbol": "x", "si": {"symbol": si, "factor": factor}} if si else None,
        "size": {"from": size[0], "to": size[1]} if size else None,
        "pieces": {"from": lo, "to": hi, "min": None, "max": None},
    }
    return TjekQuantity.model_validate(raw)


def offer(**overrides: Any) -> TjekOffer:
    raw: dict[str, Any] = {
        "id": "o1",
        "heading": "Hakket oksekød 8-12%",
        "description": "400 g. Pr. kg 87,50",
        "pricing": {"price": 35, "pre_price": None, "currency": "DKK"},
        "quantity": {
            "unit": {"symbol": "g", "si": {"symbol": "kg", "factor": 0.001}},
            "size": {"from": 400, "to": 400},
            "pieces": {"from": 1, "to": 1, "min": None, "max": None},
        },
        "run_from": "2026-11-13T23:00:00+0000",
        "run_till": "2026-11-20T22:59:59+0000",
        "dealer_id": "9ba51",
        "catalog_id": "40K-WXWp",
    }
    raw.update(overrides)
    return TjekOffer.model_validate(raw)


# ------------------------------------------------------------------------- unit quantity


@pytest.mark.parametrize(
    ("q", "expected"),
    [
        # 400 g -> 0.4 kg
        (quantity(), UnitQuantity("kg", D("0.4"), D("0.4"))),
        # range 250-530 g
        (quantity(size=(250, 530)), UnitQuantity("kg", D("0.25"), D("0.53"))),
        # 24 x 33 cl: the pack count multiplies the size
        (
            quantity(si="l", factor=0.01, size=(33, 33), pieces=24),
            UnitQuantity("l", D("7.92"), D("7.92")),
        ),
        # pcs -> stk
        (
            quantity(si="pcs", factor=1, size=(8, 8)),
            UnitQuantity("stk", D("8"), D("8")),
        ),
        # factor missing -> 1, pieces missing -> 1
        (
            quantity(si="kg", factor=None, size=(0.5, 0.5), pieces=None),
            UnitQuantity("kg", D("0.5"), D("0.5")),
        ),
        # a pack count range widens the size range: "18-20 x 33 cl"
        (
            quantity(si="l", factor=0.01, size=(33, 33), pieces=(18, 20)),
            UnitQuantity("l", D("5.94"), D("6.60")),
        ),
        # regression (finding C5): 2-3 x 500 g is 1.0-1.5 kg, not 1.0 kg
        (quantity(size=(500, 500), pieces=(2, 3)), UnitQuantity("kg", D("1.0"), D("1.5"))),
        # both ranges at once, reversed pack range: every combination is covered
        (quantity(size=(250, 500), pieces=(3, 2)), UnitQuantity("kg", D("0.5"), D("1.5"))),
        # reversed range is normalized
        (quantity(size=(530, 250)), UnitQuantity("kg", D("0.25"), D("0.53"))),
    ],
)
def test_unit_quantity(q: TjekQuantity, expected: UnitQuantity) -> None:
    assert unit_quantity(q) == expected


@pytest.mark.parametrize(
    "q",
    [
        quantity(size=None),
        quantity(size=(None, 400)),
        quantity(size=(400, None)),
        quantity(size=(0, 400)),
        quantity(size=(-1, 400)),
    ],
)
def test_unit_known_but_size_missing(q: TjekQuantity) -> None:
    assert unit_quantity(q) == UnitQuantity("kg")


@pytest.mark.parametrize("q", [None, quantity(si=None), quantity(si="m")])
def test_unknown_unit(q: TjekQuantity | None) -> None:
    assert unit_quantity(q) == UnitQuantity(None)


# ------------------------------------------------------------------------- unit prices


def test_unit_prices_for_a_range() -> None:
    parsed = parse_offer(
        offer(
            pricing={"price": 24, "pre_price": None},
            quantity={
                "unit": {"symbol": "g", "si": {"symbol": "kg", "factor": 0.001}},
                "size": {"from": 250, "to": 530},
                "pieces": {"from": 1, "to": 1},
            },
        )
    )
    assert (parsed.size_min, parsed.size_max) == (D("0.25"), D("0.53"))
    # min = price / hi, max = price / lo; rounded half up to 4 decimals
    assert parsed.unit_price_min == D("45.2830")
    assert parsed.unit_price_max == D("96.0000")


def test_unit_prices_unknown_without_size() -> None:
    parsed = parse_offer(offer(quantity={"unit": {"symbol": "kg", "si": {"symbol": "kg"}}}))
    assert parsed.unit == "kg"
    assert parsed.size_min is parsed.size_max is parsed.unit_price_min is None
    assert parsed.unit_price_max is None


def test_offer_without_quantity() -> None:
    parsed = parse_offer(offer(quantity=None))
    assert parsed.unit is None
    assert parsed.unit_price_min is None


def test_price_is_rounded_to_cents() -> None:
    parsed = parse_offer(
        offer(pricing={"price": 9.970000000000001, "pre_price": 21.950000000000003})
    )
    assert parsed.price == D("9.97")
    assert parsed.reference_price == D("21.95")


# ------------------------------------------------------------------------- reference price


@pytest.mark.parametrize(
    ("description", "expected"),
    [
        ("325 g. Pr. kg 30,68 Normalpris 21,95 Max. 6 stk.", D("21.95")),
        ("NORMALPRIS 1.299,95", D("1299.95")),
        ("Normalpris 1899,-. Få yderligere 200 kr. i cashback", D("1899")),
        ("Normalpris 30,00² pr. stk.", D("30.00")),
        ("Normalpris op til 49,-", None),  # the PoC rule needs the amount right after
        ("Før-pris 109,95.", None),
        ("", None),
        (None, None),
    ],
)
def test_parse_normal_price(description: str | None, expected: Decimal | None) -> None:
    assert parse_normal_price(description) == expected


def test_reference_price_prefers_pre_price() -> None:
    parsed = parse_offer(
        offer(pricing={"price": 10, "pre_price": 25}, description="Normalpris 19,95")
    )
    assert parsed.reference_price == D("25.00")


def test_reference_price_falls_back_to_normalpris() -> None:
    parsed = parse_offer(
        offer(pricing={"price": 10, "pre_price": None}, description="Normalpris 19,95")
    )
    assert parsed.reference_price == D("19.95")


def test_zero_pre_price_counts_as_missing() -> None:
    parsed = parse_offer(offer(pricing={"price": 10, "pre_price": 0}, description="Normalpris 15"))
    assert parsed.reference_price == D("15.00")


def test_no_reference_price() -> None:
    assert parse_offer(offer()).reference_price is None


@pytest.mark.parametrize(
    ("text", "expected"),
    [("19,95", D("19.95")), ("1.299,95", D("1299.95")), ("20", D("20")), ("8", D("8"))],
)
def test_parse_amount(text: str, expected: Decimal) -> None:
    assert parse_amount(text) == expected


# ------------------------------------------------------------------------- purchase limits


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("560 g. Pr. kg 10,71 Max. 6 stk. pr. kunde pr. dag til denne pris", 6),
        ("Max. 6 rammer pr. variant pr. kunde pr. dag til denne pris", 6),
        ("Dybfrost Med Lidl Plus³ 560 g. Maks. 3 ps. pr. kunde pr. dag.", 3),
        ("MEDLEMSPRIS* PR. STK. 25.- Max. kg pris 130,21 Max. 4 Poser pr. kunde", 4),
        ("Max. 2 stk. til denne pris", 2),
        ("Max. 12 pr. husstand", 12),
        ("900-1000 g. Pr. kg max. 76,67", None),
        ("Kg-pris maks. 276,00. 1 glas/pose.", None),
        ("Max. literpris 70,00.", None),
        ("max 70 cl. Literpris 141,43", None),
        ("", None),
        (None, None),
    ],
)
def test_parse_max_per_customer(text: str | None, expected: int | None) -> None:
    assert parse_max_per_customer(text) == expected


def test_max_per_customer_falls_back_to_pieces_max() -> None:
    assert parse_max_per_customer("400 g.", 6) == 6
    assert parse_max_per_customer("Max. 3 stk. pr. kunde", 6) == 3
    assert parse_max_per_customer("400 g.", 0) is None


# ------------------------------------------------------------------------- membership


@pytest.mark.parametrize(
    ("text", "price", "expected"),
    [
        # Netto: the offer price is for everyone; "+ PRIS" is an extra app price
        (
            "250-530 g. Pr. kg max. 96,00 + PRIS 20: Pr. kg max. 80,00 Gælder kun med Netto+ appen",
            24,
            False,
        ),
        (
            "150 g. / Pr. kg 66,67 / + PRIS 8.- / Pr. kg 53,33 / Gælder kun med Netto+ appen",
            10,
            False,
        ),
        ("500 ml. Pr. liter 24,00 + PRIS 8,- Pr. liter 16,00 Gælder kun med Netto+ appen", 8, True),
        # the whole offer is app-only
        ("Mango\nPr. stk. Udenlandsk. Gælder kun med Netto+ appen", 5, True),
        # føtex plus
        (
            "3 liter. Pr. liter 36,33 plus pris 99,- Pr. liter 33,- "
            "Gælder kun med føtex plus appen",
            109,
            False,
        ),
        ("Pr. kg 157,14 Pr. kg 128,57 Gælder kun med føtex plus appen", 45, True),
        # Coop: explicit non-member price
        ("500 ml. Literpris 238,00. Medlemsrabat 30,95 / Pris ikke-medlem 149,95", 149.95, False),
        ("500 ml. Literpris 238,00. Medlemsrabat 30,95 / Pris ikke-medlem 149,95", 119, True),
        ("5-pak. Medlemsrabat op til 10,-. Pris ikke-medlem op til 55,00", 45, True),
        ("Et medlemskab af Coop koster et engangsbeløb på 200 kr.", 20, True),
        ("Medlemstilbud. 1 kg.", 20, True),
        ("Kun for medlemmer af Coop. 1 kg.", 20, True),
        # MENY
        (
            "PR. STK. 28.- + PANT MEDLEMSPRIS* PR. STK. 19,95 + PANT Max. 4 Stk. pr. kunde",
            28,
            False,
        ),
        (
            "PR. STK. 28.- + PANT MEDLEMSPRIS* PR. STK. 19,95 + PANT Max. 4 Stk. pr. kunde",
            19.95,
            True,
        ),
        # Lidl Plus
        ("Æbleskiver\nDybfrost Med Lidl Plus³ 560 g. Pr. kg 10,71", 6, True),
        # no membership involved
        ("Et nyt, nuttet medlem af Baby Paws-familien. Gratis Baby Paws-app", 99, False),
        ("24 x 33 cl. + pant. Pr. liter 9,97", 79, False),
        ("", 10, False),
        (None, 10, False),
    ],
)
def test_is_member_price(text: str | None, price: float, expected: bool) -> None:
    assert is_member_price(text, D(str(price))) is expected


def test_member_hint_in_heading_counts() -> None:
    parsed = parse_offer(offer(heading="Netto+ tilbud: mango", description="Pr. stk."))
    assert parsed.member_only is True


# ------------------------------------------------------------------------- recorded offers

NETTO_FROM = datetime(2026, 11, 13, 23, tzinfo=UTC)
NETTO_TO = datetime(2026, 11, 20, 22, 59, 59, tzinfo=UTC)
SB_FROM = datetime(2026, 11, 12, 23, tzinfo=UTC)

# id -> (price, reference, unit, size_min, size_max, unit_price_min, unit_price_max,
#        member_only, max_per_customer)
type Expected = tuple[str, str | None, str | None, str, str, str, str, bool, int | None]

NETTO_EXPECTED: dict[str, Expected] = {
    # Dava danske frilandsæg, 8 stk.
    "qwTjdWcAYW7bm7c0sxkF4": ("20", None, "stk", "8", "8", "2.5", "2.5", False, None),
    # Dansk kyllingefilet 900-1000 g ("Pr. kg max. 76,67")
    "pyuF3FVONEex9gEDcKpv0": ("69", None, "kg", "0.9", "1", "69", "76.6667", False, None),
    # Bakersfield æbleskiver, "Max. 6 stk. pr. kunde"
    "j4XqdFYiHjljPkc_F0LKW": ("6", None, "kg", "0.56", "0.56", "10.7143", "10.7143", False, 6),
    "Uk_bN-Hw1HZI1vpuHnimy": ("35", None, "kg", "0.4", "0.4", "87.5", "87.5", False, None),
    # Libero bleer: Tjek gives size 1 pcs
    "PpCpOx8TpHkiKC4PEMr7U": ("55", None, "stk", "1", "1", "55", "55", False, None),
    # Netto sild with an extra Netto+ price
    "7qGv_TbAvxkE14OAPOR3W": ("24", None, "kg", "0.25", "0.53", "45.2830", "96", False, None),
    # Coca-Cola 24 x 33 cl, max 6 rammer
    "3WybkQoMTw8Xl2MndnZhw": ("79", None, "l", "7.92", "7.92", "9.9747", "9.9747", False, 6),
    # ØGO flæskesteg, 1/2 kg with factor 1
    "p1E_rUkWijRUdCn5177P7": ("49.95", None, "kg", "0.5", "0.5", "99.9", "99.9", False, None),
    # K-Salat with pre_price and "Normalpris 21,95"
    "s5ehhEDWvGkXUuC86EOXj": (
        "9.97",
        "21.95",
        "kg",
        "0.325",
        "0.325",
        "30.6769",
        "30.6769",
        False,
        6,
    ),
    "C6n7pp8_CU-FipuooLjvp": ("5", None, "kg", "1", "1", "5", "5", False, None),
    # Heineken 18 x 33 cl
    "6mYi0QN8ntrl1qKBb0N-b": ("79", None, "l", "5.94", "5.94", "13.2997", "13.2997", False, 6),
    "RFCinoluG0Y5BFmC-5ZMG": ("10", None, "kg", "0.15", "0.15", "66.6667", "66.6667", False, None),
}

SUPERBRUGSEN_EXPECTED: dict[str, Expected] = {
    "JCZlye8-gQ_GOCK4fh8ex": ("32", None, "stk", "10", "10", "3.2", "3.2", False, None),
    # Blossa with pre_price ("Før-pris")
    "rHNNiy_P1gCF8011a81Qf": ("99", "109.95", "l", "2", "2", "49.5", "49.5", False, None),
    # Heineken 18-20 x 33 cl: the pack count range gives 5.94-6.60 l
    "RcXEvHZcW_2dhzSNObgDh": ("89", None, "l", "5.94", "6.60", "13.4848", "14.9832", False, None),
    # olive oil: price equals "Pris ikke-medlem 149,95"
    "eTqWIdeNJh0dzGhhY65wb": ("149.95", None, "l", "0.5", "0.5", "299.9", "299.9", False, None),
    "HFVWpYTME8EMA3uhLcUJN": ("15", None, "stk", "1", "1", "15", "15", False, None),
    # Pakkemarked: 2 x 200-1500 g
    "5i5tNBmoC9ZGuI0AOyEsu": ("110", None, "kg", "0.4", "3", "36.6667", "275", False, None),
    # 6 x 75 cl wine with a 6-bottle pre_price
    "TeGEDI8Lqt0tJvwO5c91C": ("279", "719.7", "l", "4.5", "4.5", "62", "62", False, None),
    "R2EwFs5lThCRMujkMV2j3": ("45", None, "kg", "0.225", "0.225", "200", "200", False, None),
}


def _check(parsed: ParsedOffer, expected: Expected) -> None:
    price, ref, unit, smin, smax, upmin, upmax, member, max_pc = expected
    assert parsed.price == D(price)
    assert parsed.reference_price == (D(ref) if ref else None)
    assert parsed.unit == unit
    assert parsed.size_min == D(smin)
    assert parsed.size_max == D(smax)
    assert parsed.unit_price_min == D(upmin)
    assert parsed.unit_price_max == D(upmax)
    assert parsed.member_only is member
    assert parsed.max_per_customer == max_pc


@pytest.mark.parametrize(
    ("fixture", "expected", "valid_from"),
    [
        ("tjek/offers_netto.json", NETTO_EXPECTED, NETTO_FROM),
        ("tjek/offers_superbrugsen.json", SUPERBRUGSEN_EXPECTED, SB_FROM),
    ],
)
def test_recorded_offers(
    fixture_bytes: Callable[[str], bytes],
    fixture: str,
    expected: dict[str, Expected],
    valid_from: datetime,
) -> None:
    offers = OFFER_PAGE.validate_json(fixture_bytes(fixture))
    assert {o.id for o in offers} == set(expected)
    for o in offers:
        parsed = parse_offer(o)
        _check(parsed, expected[o.id])
        # offers carry their own period; it usually equals the catalog's
        assert parsed.valid_from == o.run_from
        assert parsed.title == o.heading
        assert "\n" not in parsed.description
    assert sum(parse_offer(o).valid_from == valid_from for o in offers) >= len(offers) - 1


def test_recorded_offer_fields(fixture_bytes: Callable[[str], bytes]) -> None:
    offers = {o.id: o for o in OFFER_PAGE.validate_json(fixture_bytes("tjek/offers_netto.json"))}
    parsed = parse_offer(offers["s5ehhEDWvGkXUuC86EOXj"])
    assert parsed.source_item_id == "s5ehhEDWvGkXUuC86EOXj"
    assert parsed.dealer_id == "9ba51"
    assert parsed.catalog_id == "40K-WXWp"
    assert parsed.title == "K-Salat bearnaisesauce"
    assert parsed.valid_from == NETTO_FROM
    assert parsed.valid_to == NETTO_TO


def test_offer_period_can_differ_from_catalog(fixture_bytes: Callable[[str], bytes]) -> None:
    """SuperBrugsen's monthly "gourmet" offer runs for the whole month inside a weekly leaflet."""
    offers = OFFER_PAGE.validate_json(fixture_bytes("tjek/offers_superbrugsen.json"))
    oil = parse_offer(next(o for o in offers if o.id == "eTqWIdeNJh0dzGhhY65wb"))
    assert oil.valid_from == datetime(2026, 10, 31, 23, tzinfo=UTC)
    assert oil.valid_to == datetime(2026, 11, 30, 22, 59, 59, tzinfo=UTC)


@pytest.mark.parametrize(
    ("chain_id", "text", "expected"),
    [
        ("lidl", "Hakket kalkunkød\n500 g / pk. Pr. kg 55,90 Fast lav pris", True),
        ("lidl", "Baguette\nFast lav pris 250 g. Pr. kg 20,00", True),
        ("lidl", "Grødris\nNyhed FAST  LAV\nPRIS 450 g.", True),
        ("lidl", "Smør\n200 g. Pr. kg 99,75", False),
        ("lidl", "Faste lavpriser", False),
        ("lidl", None, False),
        ("netto", "Smør\nFast lav pris", False),  # the rule is Lidl's wording only
    ],
)
def test_is_fixed_low_price(chain_id: str, text: str | None, expected: bool) -> None:
    assert is_fixed_low_price(chain_id, text) is expected
