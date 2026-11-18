"""Helpers to create and drop throw-away test databases (used by conftest and migration tests)."""

from __future__ import annotations

import os

from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

from foodcatch.db.engine import normalize_database_url

DEFAULT_ADMIN_URL = "postgresql+psycopg://foodcatch:foodcatch@localhost:5432/postgres"


def admin_url() -> str:
    """Admin connection used to create/drop test databases (``TEST_DATABASE_ADMIN_URL``)."""
    return normalize_database_url(os.environ.get("TEST_DATABASE_ADMIN_URL", DEFAULT_ADMIN_URL))


def create_database(name: str) -> str:
    """Create database ``name`` on the admin server and return its URL."""
    admin = create_engine(admin_url(), isolation_level="AUTOCOMMIT")
    try:
        with admin.connect() as conn:
            conn.execute(text(f'CREATE DATABASE "{name}"'))
    finally:
        admin.dispose()
    return make_url(admin_url()).set(database=name).render_as_string(hide_password=False)


def drop_database(name: str) -> None:
    """Drop database ``name`` (terminating leftover connections)."""
    admin = create_engine(admin_url(), isolation_level="AUTOCOMMIT")
    try:
        with admin.connect() as conn:
            conn.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
    finally:
        admin.dispose()
