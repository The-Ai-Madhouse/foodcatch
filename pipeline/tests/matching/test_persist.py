"""Persistence of recognition results against the test database (listings inserted directly)."""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Connection, func, insert, select, update

from conftest import RawPayloadFactory
from foodcatch.db.tables import (
    classification,
    classification_override,
    listing,
    matcher_release,
    product,
    review_item,
    store,
)
from foodcatch.matching import MATCHER_VERSION, classify, is_healthy_staple
from foodcatch.matching.normalize import normalize
from foodcatch.matching.persist import (
    NOTE_OVERRIDE,
    InvalidOverrideError,
    classify_pending,
    parse_forced_result,
    reclassify_all,
)

VALID_FROM = datetime(2026, 11, 16, tzinfo=UTC)

type ListingFactory = Callable[..., UUID]


@pytest.fixture
def raw_object_id(raw_payload: RawPayloadFactory) -> UUID:
    return raw_payload("tjek", "offers", {"offers": []}).raw_object_id


@pytest.fixture
def add_listing(db_conn: Connection, raw_object_id: UUID) -> ListingFactory:
    """``add_listing(title, description="", source="tjek", **columns) -> listing id``."""

    def factory(title: str, description: str = "", source: str = "tjek", **columns: Any) -> UUID:
        values: dict[str, Any] = {
            "source": source,
            "source_item_id": uuid4().hex,
            "chain_id": "netto",
            "kind": "offer",
            "title": title,
            "description": description,
            "price": Decimal("29.95"),
            "valid_from": VALID_FROM,
            "raw_object_id": raw_object_id,
            **columns,
        }
        return db_conn.execute(
            insert(listing).values(**values).returning(listing.c.id)
        ).scalar_one()

    return factory


@pytest.fixture
def add_food_waste(db_conn: Connection, add_listing: ListingFactory) -> Callable[[str, str], UUID]:
    """``add_food_waste(name, category_path) -> listing id`` (with store and product)."""
    store_id = db_conn.execute(
        insert(store)
        .values(chain_id="netto", source="salling", source_store_id=uuid4().hex, name="Netto")
        .returning(store.c.id)
    ).scalar_one()

    def factory(name: str, category: str) -> UUID:
        product_id = db_conn.execute(
            insert(product)
            .values(ean=uuid4().hex[:13], name=name, source_category=category)
            .returning(product.c.id)
        ).scalar_one()
        return add_listing(
            name,
            source="salling_food_waste",
            kind="clearance",
            store_id=store_id,
            product_id=product_id,
        )

    return factory


def _rows(conn: Connection, listing_id: UUID, version: str = MATCHER_VERSION) -> list[Any]:
    return list(
        conn.execute(
            select(classification)
            .where(
                classification.c.listing_id == listing_id,
                classification.c.matcher_version == version,
            )
            .order_by(classification.c.variant_index)
        ).mappings()
    )


def _reviews(conn: Connection, listing_id: UUID) -> dict[str, str]:
    rows = conn.execute(
        select(review_item.c.reason, review_item.c.status).where(
            review_item.c.listing_id == listing_id
        )
    )
    return {row.reason: row.status for row in rows}


def _add_override(
    conn: Connection, title: str, action: str, forced: Any = None, source: str = "tjek"
) -> None:
    conn.execute(
        insert(classification_override).values(
            source=source,
            match_title_normalized=normalize(title),
            action=action,
            forced_result=forced,
        )
    )


# ------------------------------------------------------------------------- classify_pending


def test_writes_every_match_field(db_conn: Connection, add_listing: ListingFactory) -> None:
    title, description = "Hakket svinekød eller hakket oksekød 8-12%", "500 g"
    listing_id = add_listing(title, description)

    assert classify_pending(db_conn, version=MATCHER_VERSION) == [listing_id]

    expected = classify(title, description)
    rows = _rows(db_conn, listing_id)
    assert len(rows) == len(expected) == 2
    for index, (row, m) in enumerate(zip(rows, expected, strict=True)):
        assert row["variant_index"] == index
        assert row["type_id"] == m.type_id
        assert row["type_label"] == m.type_label
        assert row["group_name"] == m.group_name
        assert row["attrs"] == m.attrs
        assert row["class_key"] == m.class_key
        assert row["class_label"] == m.class_label
        assert row["is_exact"] == m.is_exact
        assert row["is_healthy"] == is_healthy_staple(m)
        assert row["offer_variants"] == m.offer_variants == 2
        assert row["same_class_variants"] == m.same_class_variants == 1
        assert row["notes"] == m.notes
        assert row["source_hint"] == "text"
    # the pork variant has an unknown fat range; the offer covers two products
    assert _reviews(db_conn, listing_id) == {
        "unknown_key_attribute": "open",
        "ambiguous_offer": "open",
    }
    version, fingerprint, extra = db_conn.execute(
        select(
            listing.c.classified_version, listing.c.classified_fingerprint, listing.c.extra
        ).where(listing.c.id == listing_id)
    ).one()
    assert version == MATCHER_VERSION
    assert fingerprint
    assert extra == {}  # ingest owns `extra`; matching never writes it


def test_exact_single_variant_needs_no_review(
    db_conn: Connection, add_listing: ListingFactory
) -> None:
    listing_id = add_listing("Hakket oksekød 8-12%", "500 g")
    classify_pending(db_conn, version=MATCHER_VERSION)
    assert [r["class_key"] for r in _rows(db_conn, listing_id)] == [
        "hakket_oksekød|fedt=8-12%|øko=nej|laktosefri=nej|forarbejdet=nej"
    ]
    assert _reviews(db_conn, listing_id) == {}


def test_review_reasons(db_conn: Connection, add_listing: ListingFactory) -> None:
    unknown = add_listing("Mælk", "1 liter")
    ambiguous = add_listing("Lurpak smør eller Kærgården")
    staple_word = add_listing("Kyllingepålæg")
    nothing = add_listing("Vingummi")

    classify_pending(db_conn, version=MATCHER_VERSION)

    assert _reviews(db_conn, unknown) == {"unknown_key_attribute": "open"}
    assert _reviews(db_conn, ambiguous) == {"ambiguous_offer": "open"}
    assert _reviews(db_conn, staple_word) == {"unrecognized_staple_word": "open"}
    assert _rows(db_conn, staple_word) == []
    assert _reviews(db_conn, nothing) == {}
    assert _rows(db_conn, nothing) == []


def test_food_waste_uses_product_category(
    db_conn: Connection, add_food_waste: Callable[[str, str], UUID]
) -> None:
    milk = add_food_waste("ARLA LETMÆLK", "Mejeri & køl>Mælk>Letmælk")
    cold_cuts = add_food_waste("STEGT KYLLINGEPÅLÆG", "Kød & fisk>Pålæg>Kyllingepålæg")

    assert classify_pending(db_conn, version=MATCHER_VERSION) == [milk]

    (row,) = _rows(db_conn, milk)
    assert row["source_hint"] == "category"
    assert row["class_key"] == "mælk|mælketype=letmælk|øko=nej|laktosefri=nej|forarbejdet=nej"
    # a known non-staple category is neither classified nor queued despite "kylling"
    assert _rows(db_conn, cold_cuts) == []
    assert _reviews(db_conn, cold_cuts) == {}


def test_processed_listings_are_skipped(db_conn: Connection, add_listing: ListingFactory) -> None:
    classified = add_listing("Hakket oksekød 8-12%")
    unrecognized = add_listing("Vingummi")
    assert classify_pending(db_conn, version=MATCHER_VERSION) == [classified]

    # already processed: nothing pending, and touching unchanged listings changes nothing
    assert classify_pending(db_conn, version=MATCHER_VERSION) == []
    assert (
        classify_pending(db_conn, version=MATCHER_VERSION, listing_ids={classified, unrecognized})
        == []
    )
    assert len(_rows(db_conn, classified)) == 1


def test_changed_text_is_reclassified(db_conn: Connection, add_listing: ListingFactory) -> None:
    listing_id = add_listing("Hakket oksekød 8-12%")
    classify_pending(db_conn, version=MATCHER_VERSION)

    db_conn.execute(
        update(listing).where(listing.c.id == listing_id).values(title="Hakket oksekød 4-7%")
    )
    assert classify_pending(db_conn, version=MATCHER_VERSION, listing_ids=[listing_id]) == [
        listing_id
    ]
    assert [r["attrs"]["fedt"] for r in _rows(db_conn, listing_id)] == ["≤7%"]

    # becoming unrecognizable removes the rows (and reports the listing for deal recompute)
    db_conn.execute(update(listing).where(listing.c.id == listing_id).values(title="Vingummi"))
    assert classify_pending(db_conn, version=MATCHER_VERSION, listing_ids=[listing_id]) == [
        listing_id
    ]
    assert _rows(db_conn, listing_id) == []


def test_ingest_replacing_extra_does_not_trigger_reclassification(
    db_conn: Connection, add_listing: ListingFactory
) -> None:
    listing_id = add_listing("Mælk")
    classify_pending(db_conn, version=MATCHER_VERSION)
    db_conn.execute(update(listing).where(listing.c.id == listing_id).values(extra={"stock": 3}))
    before = db_conn.execute(
        select(review_item.c.id, review_item.c.status).where(review_item.c.listing_id == listing_id)
    ).all()

    # the marker lives in its own columns: nothing to re-process
    assert classify_pending(db_conn, version=MATCHER_VERSION) == []
    row = db_conn.execute(
        select(listing.c.extra, listing.c.classified_version).where(listing.c.id == listing_id)
    ).one()
    assert row.extra == {"stock": 3}
    assert row.classified_version == MATCHER_VERSION
    after = db_conn.execute(
        select(review_item.c.id, review_item.c.status).where(review_item.c.listing_id == listing_id)
    ).all()
    assert after == before


def test_unknown_or_partial_marker_is_reprocessed(
    db_conn: Connection, add_listing: ListingFactory
) -> None:
    listing_id = add_listing(
        "Hakket oksekød 8-12%", classified_version="2001.01.1", classified_fingerprint="x"
    )
    assert classify_pending(db_conn, version=MATCHER_VERSION) == [listing_id]
    assert classify_pending(db_conn, version=MATCHER_VERSION) == []
    db_conn.execute(
        update(listing).where(listing.c.id == listing_id).values(classified_fingerprint=None)
    )
    # a touched listing with a missing fingerprint is re-processed; same result, not rewritten
    assert classify_pending(db_conn, version=MATCHER_VERSION, listing_ids=[listing_id]) == []
    fingerprint = db_conn.execute(
        select(listing.c.classified_fingerprint).where(listing.c.id == listing_id)
    ).scalar_one()
    assert fingerprint is not None


def test_resolved_review_item_is_not_reopened_and_stale_items_are_fixed(
    db_conn: Connection, add_listing: ListingFactory
) -> None:
    listing_id = add_listing("Mælk")
    classify_pending(db_conn, version=MATCHER_VERSION)
    db_conn.execute(
        update(review_item).where(review_item.c.listing_id == listing_id).values(status="accepted")
    )
    db_conn.execute(update(listing).where(listing.c.id == listing_id).values(title="Mælk "))
    classify_pending(db_conn, version=MATCHER_VERSION, listing_ids=[listing_id])
    assert _reviews(db_conn, listing_id) == {"unknown_key_attribute": "accepted"}

    other = add_listing("Mælk")
    classify_pending(db_conn, version=MATCHER_VERSION)
    db_conn.execute(update(listing).where(listing.c.id == other).values(title="Letmælk"))
    classify_pending(db_conn, version=MATCHER_VERSION, listing_ids=[other])
    assert _reviews(db_conn, other) == {"unknown_key_attribute": "fixed"}
    resolved_at = db_conn.execute(
        select(review_item.c.resolved_at).where(review_item.c.listing_id == other)
    ).scalar_one()
    assert resolved_at is not None


def test_new_version_creates_release_but_not_current(
    db_conn: Connection, add_listing: ListingFactory
) -> None:
    listing_id = add_listing("Hakket oksekød 8-12%")
    classify_pending(db_conn, version=MATCHER_VERSION)
    current = select(matcher_release.c.version).where(matcher_release.c.is_current)
    before = db_conn.execute(current).scalar_one()

    assert classify_pending(db_conn, version="2099.1.1") == [listing_id]
    assert len(_rows(db_conn, listing_id, "2099.1.1")) == 1
    assert len(_rows(db_conn, listing_id)) == 1
    assert db_conn.execute(current).scalar_one() == before


# -------------------------------------------------------------------------------- overrides


def test_reject_override(db_conn: Connection, add_listing: ListingFactory) -> None:
    listing_id = add_listing("Mælk")
    classify_pending(db_conn, version=MATCHER_VERSION)
    assert _reviews(db_conn, listing_id) == {"unknown_key_attribute": "open"}

    _add_override(db_conn, "MÆLK", "reject")
    assert classify_pending(db_conn, version=MATCHER_VERSION, listing_ids=[listing_id]) == [
        listing_id
    ]
    assert _rows(db_conn, listing_id) == []
    # the override settles the open question
    assert _reviews(db_conn, listing_id) == {"unknown_key_attribute": "fixed"}


def test_force_override(db_conn: Connection, add_listing: ListingFactory) -> None:
    _add_override(
        db_conn,
        "Mælk",
        "force",
        {"type_id": "mælk", "attrs": {"mælketype": "sødmælk", "øko": "ja", "laktosefri": "nej"}},
    )
    other_source = add_listing("Mælk", source="rema", kind="regular", chain_id="rema1000")
    listing_id = add_listing("Mælk")

    classify_pending(db_conn, version=MATCHER_VERSION)

    (row,) = _rows(db_conn, listing_id)
    assert row["source_hint"] == "override"
    assert row["class_key"] == "mælk|mælketype=sødmælk|øko=ja|laktosefri=nej|forarbejdet=nej"
    assert row["class_label"] == "Mælk, sødmælk, økologisk"
    assert row["is_exact"]
    assert row["notes"] == [NOTE_OVERRIDE]
    assert _reviews(db_conn, listing_id) == {}
    # overrides are per source
    assert _rows(db_conn, other_source)[0]["source_hint"] == "text"


def test_invalid_force_override_falls_back_to_rules(
    db_conn: Connection, add_listing: ListingFactory
) -> None:
    _add_override(db_conn, "Mælk", "force", {"type_id": "no_such_type"})
    listing_id = add_listing("Mælk")
    classify_pending(db_conn, version=MATCHER_VERSION)
    assert [r["source_hint"] for r in _rows(db_conn, listing_id)] == ["text"]


def test_parse_forced_result() -> None:
    matches = parse_forced_result(
        [
            {"type_id": "smør", "attrs": {"øko": "nej", "laktosefri": "nej"}},
            {"type_id": "smørbar", "notes": ["blandingsprodukt"]},
        ],
        title="Smør eller smørbar",
    )
    assert [m.type_id for m in matches] == ["smør", "smørbar"]
    assert all(m.offer_variants == 2 and m.same_class_variants == 1 for m in matches)
    assert matches[0].is_exact
    assert not matches[1].is_exact
    assert matches[1].notes == [NOTE_OVERRIDE, "blandingsprodukt"]


@pytest.mark.parametrize(
    "value", [[], {"type_id": "no_such_type"}, {"attrs": {}}, {"type_id": "smør", "x": 1}, "smør"]
)
def test_parse_forced_result_rejects_invalid(value: object) -> None:
    with pytest.raises(InvalidOverrideError):
        parse_forced_result(value)


# ---------------------------------------------------------------------------- reclassify_all


def _add_release(conn: Connection, version: str, created_at: datetime) -> None:
    conn.execute(
        insert(matcher_release).values(version=version, created_at=created_at, is_current=False)
    )


def _versions(conn: Connection) -> set[str]:
    return set(conn.execute(select(classification.c.matcher_version).distinct()).scalars())


def test_reclassify_all_makes_version_current_and_prunes(
    db_conn: Connection, add_listing: ListingFactory
) -> None:
    listing_id = add_listing("Hakket oksekød 8-12%")
    unrecognized = add_listing("Vingummi")
    _add_release(db_conn, "2025.1.1", datetime(2025, 1, 1, tzinfo=UTC))
    classify_pending(db_conn, version="2025.1.1")
    classify_pending(db_conn, version=MATCHER_VERSION)
    assert _versions(db_conn) == {"2025.1.1", MATCHER_VERSION}

    processed = reclassify_all(db_conn, version="2099.1.1")

    total = db_conn.execute(select(func.count()).select_from(listing)).scalar_one()
    assert processed == total
    current = db_conn.execute(
        select(matcher_release.c.version).where(matcher_release.c.is_current)
    ).scalar_one()
    assert current == "2099.1.1"
    # only the two most recent versions keep their classifications
    assert _versions(db_conn) == {MATCHER_VERSION, "2099.1.1"}
    assert len(_rows(db_conn, listing_id, "2099.1.1")) == 1
    assert _rows(db_conn, unrecognized, "2099.1.1") == []


def test_reclassify_all_is_idempotent(db_conn: Connection, add_listing: ListingFactory) -> None:
    listing_id = add_listing("Hakket oksekød 8-12%")
    reclassify_all(db_conn)
    before = _rows(db_conn, listing_id)
    reclassify_all(db_conn)
    assert _rows(db_conn, listing_id) == before
    releases = db_conn.execute(
        select(matcher_release.c.version, matcher_release.c.is_current).where(
            matcher_release.c.version == MATCHER_VERSION
        )
    ).one()
    assert releases.is_current
