from __future__ import annotations

import importlib.util
from collections.abc import Iterator
from decimal import Decimal
from pathlib import Path
from types import ModuleType
from uuid import uuid4

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import Connection, Engine, create_engine, inspect, text
from sqlalchemy.exc import IntegrityError

from api_contract import (
    ADDED_IN_0007,
    ADDED_IN_0008,
    API_COLUMNS,
    CREATED_IN_0008,
    api_columns,
    columns_before,
)
from dbtools import create_database, drop_database
from foodcatch.db import migrate
from foodcatch.db.engine import normalize_database_url
from foodcatch.db.product_key import PRODUCT_KEY_SQL
from foodcatch.db.tables import metadata
from foodcatch.deals.compute import PIECE_TYPE_IDS

API_VIEWS = {
    "stores",
    "current_deals",
    "current_netto_deals",
    "products",
    "product_price_history",
    "food_waste_near",
    "class_price_history",
    "pipeline_status",
    "review_queue_summary",
}


@pytest.fixture
def empty_database() -> Iterator[str]:
    name = f"foodcatch_migtest_{uuid4().hex[:12]}"
    url = create_database(name)
    try:
        yield url
    finally:
        drop_database(name)


def _public_tables(engine: Engine) -> set[str]:
    return set(inspect(engine).get_table_names(schema="public"))


def test_upgrade_and_downgrade_on_empty_database(empty_database: str) -> None:
    engine = create_engine(normalize_database_url(empty_database))
    try:
        migrate.upgrade(empty_database)
        assert _public_tables(engine) >= set(metadata.tables)
        assert set(inspect(engine).get_view_names(schema="api")) == API_VIEWS

        migrate.downgrade(empty_database, "base")
        assert _public_tables(engine) == {"alembic_version"}
        assert "api" not in inspect(engine).get_schema_names()

        migrate.upgrade(empty_database)  # and back up again
        assert set(inspect(engine).get_view_names(schema="api")) == API_VIEWS
    finally:
        engine.dispose()


def test_migrations_match_table_definitions(db_engine: Engine) -> None:
    with db_engine.connect() as conn:
        context = MigrationContext.configure(
            conn, opts={"compare_type": True, "compare_server_default": True}
        )
        diff = compare_metadata(context, metadata)
    assert diff == []


def test_single_head() -> None:
    assert migrate.current_head() == "0009"


def test_seed_data(db_engine: Engine) -> None:
    with db_engine.connect() as conn:
        chains = {
            r.id: (r.tjek_dealer_id, r.salling_brand)
            for r in conn.execute(text("SELECT * FROM chain"))
        }
        current = conn.execute(
            text("SELECT version FROM matcher_release WHERE is_current")
        ).scalar_one()
    assert len(chains) == 11
    assert chains["netto"] == ("9ba51", "netto")
    assert chains["rema1000"] == ("11deC", None)
    assert chains["spar"] == ("88ddE", None)
    assert {k for k, (_, brand) in chains.items() if brand} == {"netto", "foetex", "bilka"}
    assert current == "2026.11.1"


def test_web_readonly_role_can_read_api_but_not_tables(db_engine: Engine) -> None:
    with db_engine.connect() as conn:
        conn.execute(text("SET LOCAL ROLE web_readonly"))
        for view in sorted(API_VIEWS):
            conn.execute(text(f"SELECT * FROM api.{view} LIMIT 1")).all()
        with pytest.raises(Exception, match="permission denied"):
            conn.execute(text("SELECT * FROM public.listing LIMIT 1"))
        conn.rollback()


def test_only_one_current_matcher_release(db_conn: Connection) -> None:
    with pytest.raises(IntegrityError):
        db_conn.execute(
            text("INSERT INTO matcher_release (version, is_current) VALUES ('x', true)")
        )


def test_0002_moves_matcher_marker_and_back(empty_database: str) -> None:
    engine = create_engine(normalize_database_url(empty_database))
    marker = '{"matcher": {"version": "2026.11.1", "fingerprint": "abc"}, "stock": 2}'
    try:
        migrate.upgrade(empty_database, "0001")
        with engine.begin() as conn:
            conn.execute(
                text(
                    """
                    INSERT INTO fetch_run (id, job, source, status)
                    VALUES ('00000000-0000-0000-0000-000000000001', 'tjek-offers', 'tjek',
                            'succeeded');
                    INSERT INTO raw_object (id, fetch_run_id, source, endpoint, storage_key,
                                            sha256, bytes)
                    VALUES ('00000000-0000-0000-0000-000000000002',
                            '00000000-0000-0000-0000-000000000001', 'tjek', 'offers', 'k',
                            'x', 1);
                    """
                )
            )
            for item, extra in (("with-marker", marker), ("garbage", '{"matcher": "x"}')):
                conn.execute(
                    text(
                        """
                        INSERT INTO listing (source, source_item_id, chain_id, kind, title,
                                             price, valid_from, raw_object_id, extra)
                        VALUES ('tjek', :item, 'netto', 'offer', 'Mælk', 10, now(),
                                '00000000-0000-0000-0000-000000000002', CAST(:extra AS jsonb))
                        """
                    ),
                    {"item": item, "extra": extra},
                )

        migrate.upgrade(empty_database, "0002")
        with engine.connect() as conn:
            rows = {
                r.source_item_id: r
                for r in conn.execute(
                    text(
                        "SELECT source_item_id, extra, classified_version, classified_fingerprint"
                        " FROM listing"
                    )
                )
            }
        assert rows["with-marker"].extra == {"stock": 2}
        assert rows["with-marker"].classified_version == "2026.11.1"
        assert rows["with-marker"].classified_fingerprint == "abc"
        assert rows["garbage"].extra == {}
        assert rows["garbage"].classified_version is None

        migrate.downgrade(empty_database, "0001")
        with engine.connect() as conn:
            extras = dict(conn.execute(text("SELECT source_item_id, extra FROM listing")).all())
            columns = {c["name"] for c in inspect(conn).get_columns("review_item")}
        assert extras["with-marker"] == {
            "matcher": {"version": "2026.11.1", "fingerprint": "abc"},
            "stock": 2,
        }
        assert extras["garbage"] == {}
        assert "note" not in columns
    finally:
        engine.dispose()


def _web_role_can_select(conn: Connection, view: str) -> bool:
    return bool(
        conn.execute(
            text("SELECT has_table_privilege('web_readonly', :view, 'SELECT')"),
            {"view": f"api.{view}"},
        ).scalar_one()
    )


def _view_definitions(conn: Connection) -> dict[str, str]:
    rows = conn.execute(
        text("SELECT viewname, definition FROM pg_catalog.pg_views WHERE schemaname = 'api'")
    ).all()
    return {row.viewname: row.definition for row in rows}


def test_0007_appends_view_columns_and_back(empty_database: str) -> None:
    """Up and down on a fresh database: only appended columns change, grants survive."""
    engine = create_engine(normalize_database_url(empty_database))
    at_0007 = columns_before(API_COLUMNS, ADDED_IN_0008, CREATED_IN_0008)
    before_0007 = columns_before(at_0007, ADDED_IN_0007)
    views_0007 = API_VIEWS - set(CREATED_IN_0008)
    try:
        migrate.upgrade(empty_database, "0006")
        with engine.connect() as conn:
            assert api_columns(conn) == before_0007
            definitions = _view_definitions(conn)

        migrate.upgrade(empty_database, "0007")
        with engine.connect() as conn:
            assert api_columns(conn) == at_0007
            assert all(_web_role_can_select(conn, view) for view in views_0007)

        migrate.downgrade(empty_database, "0006")
        with engine.connect() as conn:
            assert _view_definitions(conn) == definitions
            assert all(_web_role_can_select(conn, view) for view in views_0007)

        migrate.upgrade(empty_database, "0007")  # and back up again
        with engine.connect() as conn:
            assert api_columns(conn) == at_0007
    finally:
        engine.dispose()


def _migration_0008() -> ModuleType:
    path = (
        Path(migrate.__file__).parent
        / "migrations/versions/0008_all_chain_deals_and_product_history.py"
    )
    spec = importlib.util.spec_from_file_location("migration_0008", path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_0008_frozen_rules_match_the_code() -> None:
    """The migration's frozen SQL copies equal the rules the pipeline applies today."""
    module = _migration_0008()
    assert module.PRODUCT_KEY_SQL == PRODUCT_KEY_SQL
    assert module.PIECE_TYPE_IDS == PIECE_TYPE_IDS


_SEED_0007 = """
INSERT INTO fetch_run (id, job, source, status)
VALUES ('00000000-0000-0000-0000-000000000001', 'tjek-offers', 'tjek', 'succeeded');
INSERT INTO raw_object (id, fetch_run_id, source, endpoint, storage_key, sha256, bytes)
VALUES ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001',
        'tjek', 'offers', 'k', 'x', 1);
INSERT INTO listing (id, source, source_item_id, chain_id, kind, title, description, price,
                     valid_from, valid_to, raw_object_id)
VALUES ('00000000-0000-0000-0000-00000000000a', 'tjek', 'l1', 'lidl', 'offer',
        'Hakket grisekød', '500 g. Pr. kg 47,44 Fast  lav pris', 23.72, now() - interval '1 day',
        now() + interval '30 days', '00000000-0000-0000-0000-000000000002'),
       ('00000000-0000-0000-0000-00000000000b', 'tjek', 'l2', 'lidl', 'offer',
        'Hakket grisekød', 'Super tilbud', 20, now() - interval '1 day',
        now() + interval '3 days', '00000000-0000-0000-0000-000000000002'),
       ('00000000-0000-0000-0000-00000000000c', 'tjek', 'n1', 'netto', 'offer',
        'Hakket GRISEKØD 8-12%', 'Fast lav pris', 25, now() - interval '1 day',
        now() + interval '3 days', '00000000-0000-0000-0000-000000000002');
INSERT INTO classification (listing_id, matcher_version, variant_index, type_id, type_label,
                            group_name, attrs, class_key, class_label, is_exact, is_healthy)
VALUES ('00000000-0000-0000-0000-00000000000c', '2026.11.1', 0, 'hakket_grisekød',
        'Hakket grisekød', 'Kød', '{}', 'k', 'K', true, true);
INSERT INTO deal (listing_id, variant_index, matcher_version, class_key, netto_unit_price_worst,
                  netto_unit_price_best, price_applies)
VALUES ('00000000-0000-0000-0000-00000000000c', 0, '2026.11.1', 'k', 50, 45, true);
"""


def test_0008_backfills_kinds_keys_and_deal_columns_and_back(empty_database: str) -> None:
    """Up and down with data: Lidl "Fast lav pris", product keys, renamed deal columns."""
    engine = create_engine(normalize_database_url(empty_database))
    kinds_sql = text("SELECT source_item_id, kind FROM listing ORDER BY source_item_id")
    try:
        migrate.upgrade(empty_database, "0007")
        with engine.begin() as conn:
            conn.execute(text(_SEED_0007))
        with engine.connect() as conn:
            definitions = _view_definitions(conn)
            kinds_0007 = conn.execute(kinds_sql).all()

        migrate.upgrade(empty_database, "0008")
        with engine.connect() as conn:
            assert api_columns(conn) == API_COLUMNS
            assert all(_web_role_can_select(conn, view) for view in API_VIEWS)
            kinds = dict(conn.execute(kinds_sql).all())
            # only Lidl's text is read as a shelf price
            assert kinds == {"l1": "regular", "l2": "offer", "n1": "offer"}
            keys = dict(conn.execute(text("SELECT source_item_id, product_key FROM listing")).all())
            assert keys["n1"] == "offer:netto:hakket grisekød 8 12"
            deal_row = conn.execute(
                text(
                    "SELECT netto_unit_price_worst, netto_unit_price_best, product_key"
                    " FROM api.current_netto_deals"
                )
            ).one()
            assert deal_row == (Decimal(50), Decimal(45), "offer:netto:hakket grisekød 8 12")
            assert conn.execute(text("SELECT count(*) FROM api.current_deals")).scalar() == 1

        migrate.downgrade(empty_database, "0007")
        with engine.connect() as conn:
            assert _view_definitions(conn) == definitions
            assert conn.execute(kinds_sql).all() == kinds_0007
            assert "product_key" not in {c["name"] for c in inspect(conn).get_columns("listing")}
            assert conn.execute(
                text("SELECT netto_unit_price_worst FROM api.current_netto_deals")
            ).scalar_one() == Decimal(50)

        migrate.upgrade(empty_database, "0008")  # and back up again
        with engine.connect() as conn:
            assert api_columns(conn) == API_COLUMNS
    finally:
        engine.dispose()


def test_0009_adds_tjek_catalog_fetch_and_back(empty_database: str) -> None:
    engine = create_engine(normalize_database_url(empty_database))
    try:
        migrate.upgrade(empty_database, "0008")
        assert "tjek_catalog_fetch" not in _public_tables(engine)
        migrate.upgrade(empty_database, "0009")
        assert "tjek_catalog_fetch" in _public_tables(engine)
        with engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO tjek_catalog_fetch"
                    " (catalog_id, chain_id, fingerprint, offer_count, offers_fetched_at)"
                    " VALUES ('c1', 'netto', 'abc', 10, now())"
                )
            )
        migrate.downgrade(empty_database, "0008")
        assert "tjek_catalog_fetch" not in _public_tables(engine)
        migrate.upgrade(empty_database, "0009")  # and back up again
        assert "tjek_catalog_fetch" in _public_tables(engine)
    finally:
        engine.dispose()
