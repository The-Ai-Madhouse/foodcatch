from __future__ import annotations

from collections.abc import Iterator
from uuid import uuid4

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import Connection, Engine, create_engine, inspect, text
from sqlalchemy.exc import IntegrityError

from dbtools import create_database, drop_database
from foodcatch.db import migrate
from foodcatch.db.engine import normalize_database_url
from foodcatch.db.tables import metadata

API_VIEWS = {
    "stores",
    "current_netto_deals",
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
    assert migrate.current_head() == "0005"


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
