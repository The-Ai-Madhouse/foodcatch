"""Migration 0008's views: all-chain deals, per-product price history, food-waste references."""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Connection, insert, select, text

from foodcatch.db.product_key import normalize_title, product_key
from foodcatch.db.tables import (
    classification,
    fetch_run,
    listing,
    product,
    product_reference_price,
    store,
)
from foodcatch.deals.compute import recompute_deals
from foodcatch.ingest import RawPayload

NOW = datetime.now(UTC)
DAY = timedelta(days=1)
CLASS_KEY = "hakket_oksekød|fedt=8-12%|øko=nej|laktosefri=nej|forarbejdet=nej"


class Data:
    """Listings + classification rows inside the rolled-back test transaction."""

    def __init__(self, conn: Connection, raw_object_id: UUID) -> None:
        self.conn = conn
        self.raw_object_id = raw_object_id

    def listing(self, *, classify: bool = True, **values: Any) -> UUID:
        row: dict[str, Any] = {
            "source": "tjek",
            "source_item_id": uuid4().hex,
            "chain_id": "netto",
            "kind": "offer",
            "title": "Hakket oksekød 8-12%",
            "price": 40,
            "unit": "kg",
            "size_min": 1,
            "size_max": 1,
            "unit_price_min": 40,
            "unit_price_max": 40,
            "valid_from": NOW - DAY,
            "valid_to": NOW + 3 * DAY,
            "raw_object_id": self.raw_object_id,
            **values,
        }
        listing_id = self.conn.execute(
            insert(listing).values(**row).returning(listing.c.id)
        ).scalar_one()
        if classify:
            self.conn.execute(
                insert(classification).values(
                    listing_id=listing_id,
                    matcher_version="2026.11.1",
                    variant_index=0,
                    type_id="hakket_oksekød",
                    type_label="Hakket oksekød",
                    group_name="Kød",
                    attrs={"fedt": "8-12%"},
                    class_key=CLASS_KEY,
                    class_label="Hakket oksekød, 8-12%",
                    is_exact=True,
                    is_healthy=True,
                )
            )
        return listing_id

    def clearance(self, *, ean: str = "5701234567892", unit_price: float | None = 50) -> UUID:
        """A current Netto clearance (500 g for 25 kr.) seen by the latest food-waste run."""
        store_id = self.conn.execute(
            insert(store)
            .values(chain_id="netto", source="salling", source_store_id="s1", name="Netto")
            .returning(store.c.id)
        ).scalar_one()
        product_id = self.conn.execute(
            insert(product).values(ean=ean, name="HK. OKSEKØD 8-12% 500G").returning(product.c.id)
        ).scalar_one()
        self.conn.execute(
            insert(fetch_run).values(
                job="salling-food-waste",
                source="salling",
                status="succeeded",
                started_at=NOW - timedelta(hours=1),
            )
        )
        return self.listing(
            source="salling_food_waste",
            source_item_id=f"s1:{ean}",
            kind="clearance",
            title="HK. OKSEKØD 8-12% 500G",
            store_id=store_id,
            product_id=product_id,
            price=25,
            reference_price=50,
            size_min=0.5 if unit_price else None,
            size_max=0.5 if unit_price else None,
            unit="kg" if unit_price else None,
            unit_price_min=unit_price,
            unit_price_max=unit_price,
            valid_to=NOW + timedelta(hours=10),
            extra={
                "stock": 2,
                "percent_discount": 50,
                "offer_ean": "2400000000001",
                "product_code": ean,
            },
        )

    def one(self, sql: str, **params: Any) -> dict[str, Any]:
        return dict(self.conn.execute(text(sql), params).mappings().one())


@pytest.fixture
def data(db_conn: Connection, raw_payload: Callable[..., RawPayload]) -> Data:
    return Data(db_conn, raw_payload("salling", "food-waste", {}).raw_object_id)


# ------------------------------------------------------------------------- product key
@pytest.mark.parametrize(
    ("title", "expected"),
    [
        ("  Hakket GRISEKØD, 8-12% ", "hakket grisekød 8 12"),
        ("ÆBLER — Pink Lady®", "æbler pink lady"),
        ("Crème fraîche 18%", "crème fraîche 18"),
        ("ÉÈÊË ÜÖÄ Ñ Ç", "éèêë üöä ñ ç"),
        ("", ""),
    ],
)
def test_normalize_title_in_python_and_sql_agree(data: Data, title: str, expected: str) -> None:
    assert normalize_title(title) == expected
    listing_id = data.listing(classify=False, title=title, chain_id="lidl")
    stored = data.conn.execute(
        select(listing.c.product_key).where(listing.c.id == listing_id)
    ).scalar_one()
    assert stored == f"offer:lidl:{expected}:1kg"


@pytest.mark.parametrize(
    ("unit", "size_min", "size_max", "suffix"),
    [
        ("l", Decimal("1.500"), Decimal("1.5"), ":1.5l"),
        ("l", Decimal("9.90"), Decimal("9.90"), ":9.9l"),
        ("kg", Decimal("0.4"), Decimal("0.5"), ":0.4-0.5kg"),
        ("stk", Decimal("10"), Decimal("10"), ":10stk"),
        ("kg", Decimal("100"), None, ":100kg"),
        ("kg", None, None, ""),
        (None, None, None, ""),
    ],
)
def test_offer_key_ends_in_the_pack_size_in_python_and_sql(
    data: Data,
    unit: str | None,
    size_min: Decimal | None,
    size_max: Decimal | None,
    suffix: str,
) -> None:
    """Same heading, other pack: "Faxe Kondi" 1.5 l and a crate are two items (migration 0010)."""
    listing_id = data.listing(
        classify=False,
        title="Faxe Kondi",
        unit=unit,
        size_min=size_min,
        size_max=size_max,
        unit_price_min=None,
        unit_price_max=None,
    )
    stored = data.conn.execute(
        select(listing.c.product_key).where(listing.c.id == listing_id)
    ).scalar_one()
    assert stored == f"offer:netto:faxe kondi{suffix}"
    assert stored == product_key(
        source="tjek",
        source_item_id="x",
        chain_id="netto",
        title="Faxe Kondi",
        unit=unit,
        size_min=size_min,
        size_max=size_max,
    )


def test_product_keys_per_source(data: Data) -> None:
    rema = data.listing(source="rema", source_item_id="12345", chain_id="rema1000")
    clearance = data.clearance()
    no_gtin = data.listing(
        source="salling_food_waste",
        kind="clearance",
        source_item_id="s1:250913",
        title="Oksekød 8-12% ca. 500g",
        extra={"product_code": "250913"},
        store_id=data.conn.execute(select(store.c.id)).scalar_one(),
    )
    keys = dict(data.conn.execute(select(listing.c.id, listing.c.product_key)).all())
    assert keys[rema] == "rema:12345"
    assert keys[clearance] == "ean:5701234567892"
    assert keys[no_gtin] == "clearance:netto:oksekød 8 12 ca 500g"
    for listing_id, has_product, code in (
        (rema, False, None),
        (clearance, True, "5701234567892"),
        (no_gtin, False, "250913"),
    ):
        row = data.conn.execute(select(listing).where(listing.c.id == listing_id)).one()
        assert keys[listing_id] == product_key(
            source=row.source,
            source_item_id=row.source_item_id,
            chain_id=row.chain_id,
            title=row.title,
            has_product=has_product,
            product_code=code,
        )


# ---------------------------------------------------------------------------- history
def test_product_price_history_follows_one_rema_product_and_one_ean(data: Data) -> None:
    rema: dict[str, Any] = {"source": "rema", "source_item_id": "777", "chain_id": "rema1000"}
    data.listing(
        kind="regular", price=59, valid_from=NOW - 40 * DAY, valid_to=NOW - 10 * DAY, **rema
    )
    data.listing(kind="offer", price=45, valid_from=NOW - 10 * DAY, valid_to=NOW - 3 * DAY, **rema)
    data.listing(kind="regular", price=62, valid_from=NOW - 3 * DAY, valid_to=None, **rema)
    data.listing(source="rema", source_item_id="other", chain_id="rema1000", kind="regular")

    rows = data.conn.execute(
        text(
            "SELECT kind, price, chain_id FROM api.product_price_history"
            " WHERE product_key = 'rema:777' ORDER BY valid_from"
        )
    ).all()
    assert [tuple(r) for r in rows] == [
        ("regular", Decimal(59), "rema1000"),
        ("offer", Decimal(45), "rema1000"),
        ("regular", Decimal(62), "rema1000"),
    ]
    latest = data.one("SELECT * FROM api.products WHERE product_key = 'rema:777'")
    assert (latest["latest_kind"], latest["latest_price"]) == ("regular", Decimal(62))
    assert latest["class_key"] == CLASS_KEY
    assert latest["chain_name"] == "REMA 1000"

    clearance = data.clearance()
    product_id = data.conn.execute(select(listing.c.product_id).where(listing.c.id == clearance))
    pid = product_id.scalar_one()
    for chain, price, seen in (
        ("netto", 45, NOW - 20 * DAY),
        ("netto", 49, NOW),
        ("foetex", 50, NOW),
    ):
        data.conn.execute(
            insert(product_reference_price).values(
                product_id=pid,
                chain_id=chain,
                price=price,
                first_seen_at=seen - DAY,
                last_seen_at=seen,
            )
        )
    rows = data.conn.execute(
        text(
            "SELECT kind, chain_id, price, source, store_id IS NOT NULL AS in_store"
            " FROM api.product_price_history WHERE product_key = 'ean:5701234567892'"
            " ORDER BY kind, chain_id, valid_from"
        )
    ).all()
    assert [tuple(r) for r in rows] == [
        ("clearance", "netto", Decimal(25), "salling_food_waste", True),
        ("reference", "foetex", Decimal(50), "salling_food_waste", False),
        ("reference", "netto", Decimal(45), "salling_food_waste", False),
        ("reference", "netto", Decimal(49), "salling_food_waste", False),
    ]


# ----------------------------------------------------------------------- current deals
def test_current_deals_show_every_chain_and_netto_view_is_its_netto_part(data: Data) -> None:
    netto = data.listing(price=40)
    lidl = data.listing(chain_id="lidl", price=35, unit_price_min=35, unit_price_max=35)
    data.listing(chain_id="lidl", kind="regular", price=38, unit_price_min=38, unit_price_max=38)
    recompute_deals(data.conn)

    rows = {
        r["listing_id"]: r
        for r in data.conn.execute(text("SELECT * FROM api.current_deals")).mappings()
    }
    assert set(rows) == {netto, lidl}  # Lidl's shelf price is no deal
    assert rows[lidl]["chain_name"] == "Lidl"
    assert rows[lidl]["target_unit_price_worst"] == Decimal(35)
    assert rows[lidl]["product_key"] == "offer:lidl:hakket oksekød 8 12:1kg"
    assert {r["kind"] for r in rows[netto]["references"]} == {"offer", "regular"}

    netto_row = data.one("SELECT * FROM api.current_netto_deals")
    assert netto_row["listing_id"] == netto
    assert netto_row["netto_unit_price_worst"] == rows[netto]["target_unit_price_worst"]
    assert netto_row["references"] == rows[netto]["references"]


# ------------------------------------------------------------------------- food waste
def test_food_waste_near_exposes_the_salling_source(data: Data) -> None:
    clearance = data.clearance()
    row = data.one("SELECT * FROM api.food_waste_near")
    fetched_at = data.conn.execute(
        text(
            "SELECT r.fetched_at FROM raw_object r JOIN listing l ON l.raw_object_id = r.id"
            " WHERE l.id = :id"
        ),
        {"id": clearance},
    ).scalar_one()
    assert row["source_fetched_at"] == fetched_at
    assert (row["price"], row["reference_price"]) == (Decimal(25), Decimal(50))
    assert row["salling_percent_discount"] == 50
    assert row["offer_ean"] == "2400000000001"
    assert row["product_code"] == row["ean"] == "5701234567892"
    assert row["salling_store_id"] == "s1"
    assert row["source_item_id"] == "s1:5701234567892"
    assert row["product_key"] == "ean:5701234567892"
    assert row["class_key"] == CLASS_KEY
    assert row["food_waste_references"] == []
    assert row["beats_competitors"] is None  # nothing to compare with


def test_food_waste_references_and_beats_competitors(data: Data) -> None:
    data.clearance()  # 50 kr./kg
    data.listing(chain_id="lidl", unit_price_min=60, unit_price_max=60)
    data.listing(chain_id="netto", unit_price_min=10, unit_price_max=10)  # own chain: ignored
    data.listing(  # expired
        chain_id="meny", unit_price_min=20, unit_price_max=20, valid_to=NOW - DAY
    )
    data.listing(chain_id="spar", unit="l", unit_price_min=20, unit_price_max=20)  # other unit
    rema: dict[str, Any] = {"source": "rema", "chain_id": "rema1000", "kind": "regular"}
    data.listing(unit_price_min=55, unit_price_max=55, source_item_id="r1", **rema)

    row = data.one("SELECT food_waste_references, beats_competitors FROM api.food_waste_near")
    refs = row["food_waste_references"]
    assert [(r["kind"], r["chain_id"], r["unit_price"]) for r in refs] == [
        ("regular", "rema1000", 55),
        ("offer", "lidl", 60),
    ]
    assert set(refs[0]) == {
        "kind",
        "chain_id",
        "listing_id",
        "title",
        "unit_price",
        "unit",
        "valid_from",
        "valid_to",
        "member_only",
    }
    assert row["beats_competitors"] is True

    # a Lidl "Fast lav pris" shelf price below the clearance's unit price
    data.listing(chain_id="lidl", kind="regular", unit_price_min=49.99, unit_price_max=49.99)
    row = data.one("SELECT food_waste_references, beats_competitors FROM api.food_waste_near")
    assert row["food_waste_references"][0]["chain_id"] == "lidl"
    assert row["beats_competitors"] is False


def test_food_waste_without_unit_price_gets_no_references(data: Data) -> None:
    data.clearance(unit_price=None)
    data.listing(chain_id="lidl", unit_price_min=60, unit_price_max=60)

    row = data.one("SELECT food_waste_references, beats_competitors FROM api.food_waste_near")
    assert row == {"food_waste_references": [], "beats_competitors": None}
