"""Review queue helpers against the test database."""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Connection, insert, select

from conftest import RawPayloadFactory
from foodcatch.db.tables import listing, review_item
from foodcatch.review import (
    ReviewItemNotFoundError,
    enqueue,
    enqueue_many,
    list_items,
    list_open,
    resolve,
    sync_open_items,
)


@pytest.fixture
def listing_ids(db_conn: Connection, raw_payload: RawPayloadFactory) -> list[UUID]:
    raw_object_id = raw_payload("tjek", "offers", {"offers": []}).raw_object_id
    return [
        db_conn.execute(
            insert(listing)
            .values(
                source="tjek",
                source_item_id=uuid4().hex,
                chain_id="lidl",
                kind="offer",
                title=title,
                description="beskrivelse",
                price=Decimal("10.00"),
                valid_from=datetime(2026, 11, 16, tzinfo=UTC),
                raw_object_id=raw_object_id,
            )
            .returning(listing.c.id)
        ).scalar_one()
        for title in ("Mælk", "Kyllingepålæg", "Smør eller smørbar")
    ]


def test_enqueue_is_idempotent(db_conn: Connection, listing_ids: list[UUID]) -> None:
    first = listing_ids[0]
    assert enqueue(db_conn, first, "unknown_key_attribute")
    assert not enqueue(db_conn, first, "unknown_key_attribute")
    assert enqueue(db_conn, first, "ambiguous_offer")
    assert enqueue_many(db_conn, [(first, "ambiguous_offer"), (listing_ids[1], "ambiguous_offer")])
    assert enqueue_many(db_conn, []) == 0


def test_list_open_joins_listing_and_filters(db_conn: Connection, listing_ids: list[UUID]) -> None:
    milk, cold_cuts, butter = listing_ids
    enqueue(db_conn, milk, "unknown_key_attribute")
    enqueue(db_conn, cold_cuts, "unrecognized_staple_word")
    enqueue(db_conn, butter, "ambiguous_offer")

    items = list_open(db_conn)
    assert [i.listing_id for i in items] == [milk, cold_cuts, butter]
    item = items[0]
    assert (item.title, item.description, item.source, item.chain_id, item.status) == (
        "Mælk",
        "beskrivelse",
        "tjek",
        "lidl",
        "open",
    )
    assert [i.title for i in list_open(db_conn, "unrecognized_staple_word")] == ["Kyllingepålæg"]
    assert len(list_open(db_conn, limit=2)) == 2


def test_resolve(db_conn: Connection, listing_ids: list[UUID]) -> None:
    enqueue(db_conn, listing_ids[0], "unknown_key_attribute")
    (item,) = list_open(db_conn)

    resolve(db_conn, item.id, "accepted", note="mælketype står kun på billedet")

    assert list_open(db_conn) == []
    (resolved,) = list_items(db_conn, status="accepted")
    assert resolved.id == item.id
    assert resolved.note == "mælketype står kun på billedet"
    resolved_at = db_conn.execute(
        select(review_item.c.resolved_at).where(review_item.c.id == item.id)
    ).scalar_one()
    assert resolved_at is not None
    # a resolved item is not reopened
    assert not enqueue(db_conn, listing_ids[0], "unknown_key_attribute")
    assert list_open(db_conn) == []


def test_resolve_errors(db_conn: Connection, listing_ids: list[UUID]) -> None:
    enqueue(db_conn, listing_ids[0], "ambiguous_offer")
    (item,) = list_open(db_conn)
    with pytest.raises(ValueError, match="open"):
        resolve(db_conn, item.id, "open")
    with pytest.raises(ReviewItemNotFoundError):
        resolve(db_conn, item.id + 1000, "rejected")


def test_sync_open_items(db_conn: Connection, listing_ids: list[UUID]) -> None:
    milk, cold_cuts, _ = listing_ids
    enqueue(db_conn, milk, "unknown_key_attribute")
    enqueue(db_conn, cold_cuts, "unrecognized_staple_word")

    created, fixed = sync_open_items(
        db_conn, {milk: {"ambiguous_offer"}, cold_cuts: {"unrecognized_staple_word"}}
    )

    assert (created, fixed) == (1, 1)
    assert {(i.listing_id, i.reason) for i in list_open(db_conn)} == {
        (milk, "ambiguous_offer"),
        (cold_cuts, "unrecognized_staple_word"),
    }
    assert [i.reason for i in list_items(db_conn, status="fixed")] == ["unknown_key_attribute"]
    assert sync_open_items(db_conn, {}) == (0, 0)
