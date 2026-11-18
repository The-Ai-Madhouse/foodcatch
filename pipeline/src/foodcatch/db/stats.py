"""Database size reporting (``foodcatch db stats``; Neon free plan budget, architecture §4)."""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import Connection, text

from foodcatch.jobs.quality import DB_SIZE_WARN_FRACTION, database_size_bytes


@dataclass(frozen=True, slots=True)
class TableSize:
    """Size of one table including indexes and TOAST."""

    name: str
    row_estimate: int
    total_bytes: int


@dataclass(frozen=True, slots=True)
class DatabaseStats:
    """Database size against the configured budget."""

    database_bytes: int
    budget_bytes: int
    tables: list[TableSize]

    @property
    def used_fraction(self) -> float:
        """Share of the budget in use (0-1+)."""
        return self.database_bytes / self.budget_bytes

    @property
    def over_warning_threshold(self) -> bool:
        """Whether usage exceeds the warning threshold (70 %)."""
        return self.used_fraction > DB_SIZE_WARN_FRACTION


_TABLE_SIZES = text(
    """
    SELECT c.relname AS name,
           greatest(c.reltuples, 0)::bigint AS row_estimate,
           pg_total_relation_size(c.oid) AS total_bytes
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
    ORDER BY total_bytes DESC, name
    """
)


def collect_stats(conn: Connection, budget_mb: int) -> DatabaseStats:
    """Collect table sizes of schema ``public`` and the total database size."""
    tables = [
        TableSize(name=r.name, row_estimate=int(r.row_estimate), total_bytes=int(r.total_bytes))
        for r in conn.execute(_TABLE_SIZES)
    ]
    return DatabaseStats(
        database_bytes=database_size_bytes(conn),
        budget_bytes=budget_mb * 1024 * 1024,
        tables=tables,
    )
