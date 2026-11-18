"""Alembic environment.

The database URL is taken, in order, from: a connection passed in
``config.attributes["connection"]`` (tests), the ``sqlalchemy.url`` main option (set by
:mod:`foodcatch.db.migrate`), or ``DATABASE_URL`` from settings.
"""

from __future__ import annotations

from alembic import context
from sqlalchemy import Connection

from foodcatch.db.engine import make_engine
from foodcatch.db.tables import metadata

config = context.config
target_metadata = metadata


def _include_object(
    obj: object, name: str | None, type_: str, reflected: bool, compare_to: object
) -> bool:
    # Views in schema `api` are managed by hand-written SQL in migrations.
    schema = getattr(obj, "schema", None)
    return schema in (None, "public")


def _configure_and_run(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        include_object=_include_object,
        compare_type=True,
        compare_server_default=True,
        transaction_per_migration=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_offline() -> None:
    """Emit SQL to stdout (``alembic upgrade head --sql``)."""
    context.configure(
        url=config.get_main_option("sqlalchemy.url") or None,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        dialect_name="postgresql",
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations against a live database."""
    connection = config.attributes.get("connection")
    if isinstance(connection, Connection):
        _configure_and_run(connection)
        return
    engine = make_engine(config.get_main_option("sqlalchemy.url") or None)
    try:
        with engine.connect() as conn:
            _configure_and_run(conn)
            conn.commit()
    finally:
        engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
