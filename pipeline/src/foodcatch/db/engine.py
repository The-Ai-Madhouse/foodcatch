"""Engine helpers.

The pipeline uses SQLAlchemy Core with the psycopg 3 driver. URLs in the libpq form that hosting
providers hand out (``postgres://`` / ``postgresql://``) are normalized to
``postgresql+psycopg://``.
"""

from __future__ import annotations

from sqlalchemy import Engine, create_engine

from foodcatch.config import Settings, get_settings

_DRIVER = "postgresql+psycopg"


def normalize_database_url(url: str) -> str:
    """Return ``url`` using the psycopg 3 driver (``postgresql+psycopg://``)."""
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return _DRIVER + "://" + url[len(prefix) :]
    return url


def make_engine(url: str | None = None, *, settings: Settings | None = None) -> Engine:
    """Create an engine for ``url`` (default: ``DATABASE_URL``)."""
    target = url or (settings or get_settings()).database_url
    return create_engine(
        normalize_database_url(target),
        pool_pre_ping=True,
        pool_size=2,
        max_overflow=2,
    )
