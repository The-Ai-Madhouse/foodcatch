"""Post-fetch hooks with the real matcher and deal computation (no stubs)."""

from __future__ import annotations

import itertools
import json
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any
from uuid import UUID

from sqlalchemy import Connection, insert, select, update

from foodcatch.db.tables import classification, deal, listing, matcher_release
from foodcatch.deals.compute import recompute_deals
from foodcatch.ingest import RawPayload
from foodcatch.jobs.context import PipelineState
from foodcatch.jobs.hooks import run_post_fetch_hooks
from foodcatch.matching import MATCHER_VERSION, Match, classify, comparability
from foodcatch.matching.persist import (
    classify_pending,
    prune_classifications,
    set_current_release,
)
from foodcatch.matching.taxonomy import get_type

NOW = datetime.now(UTC)
SNAPSHOT = Path(__file__).parents[1] / "matching" / "data" / "offer_texts_snapshot.jsonl"


def _offer(
    conn: Connection, raw_object_id: UUID, *, chain: str, title: str, unit_price: str
) -> UUID:
    return conn.execute(
        insert(listing)
        .values(
            source="tjek",
            source_item_id=f"{chain}-{title}",
            chain_id=chain,
            kind="offer",
            title=title,
            description="500 g",
            price=Decimal(unit_price) / 2,
            unit="kg",
            size_min=Decimal("0.5"),
            size_max=Decimal("0.5"),
            unit_price_min=Decimal(unit_price),
            unit_price_max=Decimal(unit_price),
            valid_from=NOW - timedelta(days=1),
            valid_to=NOW + timedelta(days=5),
            raw_object_id=raw_object_id,
        )
        .returning(listing.c.id)
    ).scalar_one()


def _scenario(
    db_conn: Connection, raw_payload: Callable[..., RawPayload]
) -> tuple[UUID, UUID, PipelineState]:
    raw_object_id = raw_payload("tjek", "offers", []).raw_object_id
    netto = _offer(
        db_conn, raw_object_id, chain="netto", title="Hakket grisekød 8-12%", unit_price="33.33"
    )
    lidl = _offer(
        db_conn, raw_object_id, chain="lidl", title="Hakket grisekød 8-12%", unit_price="39.00"
    )
    return netto, lidl, PipelineState(listing_ids={netto, lidl})


def test_hooks_classify_then_compute_deals(
    db_conn: Connection, raw_payload: Callable[..., RawPayload]
) -> None:
    netto, lidl, state = _scenario(db_conn, raw_payload)

    run_post_fetch_hooks(db_conn, state)

    assert state.stats["classification_changed"] == 2
    assert state.stats["deals"] == 1
    row = db_conn.execute(select(deal).where(deal.c.listing_id == netto)).one()
    assert row.matcher_version == MATCHER_VERSION
    assert row.price_applies is True
    assert [(r["kind"], r["listing_id"]) for r in row.references] == [("offer", str(lidl))]

    # a second run with nothing new changes nothing
    again = PipelineState()
    run_post_fetch_hooks(db_conn, again)
    assert again.stats["classification_changed"] == 0
    assert again.stats.get("deals", 0) == 0


def test_competitor_price_change_recomputes_deals_without_reclassifying(
    db_conn: Connection, raw_payload: Callable[..., RawPayload]
) -> None:
    netto, lidl, state = _scenario(db_conn, raw_payload)
    run_post_fetch_hooks(db_conn, state)
    db_conn.execute(update(listing).where(listing.c.id == lidl).values(unit_price_min=30))

    changed = PipelineState(listing_ids={lidl})  # what ingest reports for the price change
    run_post_fetch_hooks(db_conn, changed)

    assert changed.stats["classification_changed"] == 0
    assert changed.stats["deals"] == 1
    refs = db_conn.execute(select(deal.c.references).where(deal.c.listing_id == netto)).scalar_one()
    assert refs[0]["unit_price"] == 30.0


def test_first_run_after_a_matcher_upgrade_promotes_the_release(
    db_conn: Connection, raw_payload: Callable[..., RawPayload]
) -> None:
    db_conn.execute(update(matcher_release).values(is_current=False))
    db_conn.execute(insert(matcher_release).values(version="2026.10.9", is_current=True))
    netto, _, state = _scenario(db_conn, raw_payload)

    run_post_fetch_hooks(db_conn, state)

    current = db_conn.execute(
        select(matcher_release.c.version).where(matcher_release.c.is_current)
    ).scalar_one()
    assert current == MATCHER_VERSION
    assert state.stats["matcher_promoted"] == 1
    assert db_conn.execute(select(deal.c.listing_id)).scalars().all() == [netto]
    versions = set(db_conn.execute(select(classification.c.matcher_version)).scalars())
    assert versions == {MATCHER_VERSION}


def test_rollback_to_an_older_matcher_version_recomputes_every_deal(
    db_conn: Connection, raw_payload: Callable[..., RawPayload]
) -> None:
    """Regression (finding C7): V1 -> V2 -> V1 must leave the deal rows in place."""
    netto, _, state = _scenario(db_conn, raw_payload)
    run_post_fetch_hooks(db_conn, state)  # V1 = MATCHER_VERSION is current
    newer = "2099.1.1"
    classify_pending(db_conn, version=newer)
    set_current_release(db_conn, newer)  # V2 deployed: its run deletes every V1 deal row
    prune_classifications(db_conn)
    recompute_deals(db_conn)
    assert db_conn.execute(select(deal.c.matcher_version)).scalars().all() == [newer]

    rollback = PipelineState()  # the first run after redeploying V1: nothing new was fetched
    run_post_fetch_hooks(db_conn, rollback)

    assert rollback.stats["matcher_promoted"] == 1
    rows = db_conn.execute(select(deal.c.listing_id, deal.c.matcher_version)).all()
    assert [tuple(r) for r in rows] == [(netto, MATCHER_VERSION)]


def _rebuild(m: Match) -> Match:
    """A match as deals see it: rebuilt from a classification row (type_id + attrs)."""
    product_type = get_type(m.type_id)
    return Match(
        type_id=m.type_id,
        type_label=product_type.label,
        group_name=product_type.group,
        attrs=dict(m.attrs),
        key_attrs=product_type.key_attrs,
    )


def test_same_class_rows_are_exactly_the_comparable_ones() -> None:
    """``deals.compute`` treats equal ``class_key`` + both exact as the same product.

    That must be ``comparability(a, b) == "same"`` for every pair of real matches rebuilt from
    their classification rows (via ``taxonomy.get_type(type_id).key_attrs``).
    """
    lines = SNAPSHOT.read_text(encoding="utf-8").splitlines()
    texts: list[dict[str, Any]] = [json.loads(line) for line in lines]
    matches = [_rebuild(m) for t in texts for m in classify(t["title"], t.get("description") or "")]
    assert len(matches) > 500
    by_type: dict[str, list[Match]] = {}
    for m in matches:
        by_type.setdefault(m.type_id, []).append(m)
    pairs = 0
    for group in by_type.values():
        for a, b in itertools.combinations(group[:60], 2):
            same_row = a.class_key == b.class_key and a.is_exact and b.is_exact
            assert (comparability(a, b) == "same") == same_row, (a.class_key, b.class_key)
            pairs += 1
    assert pairs > 1000
