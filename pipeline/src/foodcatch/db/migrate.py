"""Programmatic Alembic commands used by the CLI and tests.

Migrations are located inside the package, so they work from any working directory and from an
installed wheel.
"""

from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory

from foodcatch.db.engine import normalize_database_url

MIGRATIONS_DIR = Path(__file__).parent / "migrations"


def alembic_config(database_url: str | None = None) -> Config:
    """Alembic config pointing at the packaged migrations (and ``database_url`` if given)."""
    cfg = Config()
    cfg.set_main_option("script_location", str(MIGRATIONS_DIR))
    cfg.set_main_option("path_separator", "os")
    if database_url:
        # ConfigParser interpolation: escape '%' (URL-encoded passwords)
        url = normalize_database_url(database_url).replace("%", "%%")
        cfg.set_main_option("sqlalchemy.url", url)
    return cfg


def upgrade(database_url: str | None = None, revision: str = "head") -> None:
    """Upgrade the database to ``revision``."""
    command.upgrade(alembic_config(database_url), revision)


def downgrade(database_url: str | None = None, revision: str = "-1") -> None:
    """Downgrade the database to ``revision`` (default: one step)."""
    command.downgrade(alembic_config(database_url), revision)


def current_head() -> str | None:
    """The head revision of the packaged migrations."""
    return ScriptDirectory.from_config(alembic_config()).get_current_head()
