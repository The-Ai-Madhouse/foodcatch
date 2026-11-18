"""Command line interface: ``foodcatch ...`` (the only layer that prints).

Exit codes: 0 success, 1 failure, 2 usage error, 3 job finished ``degraded``.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Annotated

import typer

from foodcatch import __version__
from foodcatch.config import get_settings
from foodcatch.db import migrate
from foodcatch.db.engine import make_engine
from foodcatch.db.stats import collect_stats
from foodcatch.db.tables import REVIEW_REASONS
from foodcatch.deals.compute import recompute_deals
from foodcatch.jobs import UnknownJobError, list_jobs
from foodcatch.jobs.runner import run_job
from foodcatch.logging import configure_logging
from foodcatch.matching.persist import reclassify_all
from foodcatch.monitoring import init_sentry
from foodcatch.rawindex import reindex
from foodcatch.reprocess import reprocess
from foodcatch.review import (
    ReviewItemNotFoundError,
    ReviewStatus,
    list_items,
    resolve,
)
from foodcatch.sources import RAW_SOURCES
from foodcatch.storage.raw import from_url as raw_store_from_url

EXIT_FAILED = 1
EXIT_DEGRADED = 3

app = typer.Typer(
    name="foodcatch",
    help="FoodCatch data pipeline.",
    no_args_is_help=True,
    pretty_exceptions_enable=False,
    add_completion=False,
)
db_app = typer.Typer(help="Database migrations and statistics.", no_args_is_help=True)
jobs_app = typer.Typer(help="Registered collection jobs.", no_args_is_help=True)
review_app = typer.Typer(help="Review queue of doubtful classifications.", no_args_is_help=True)
deals_app = typer.Typer(help="Deal computation.", no_args_is_help=True)
raw_app = typer.Typer(help="Raw store maintenance.", no_args_is_help=True)
app.add_typer(db_app, name="db")
app.add_typer(jobs_app, name="jobs")
app.add_typer(review_app, name="review")
app.add_typer(deals_app, name="deals")
app.add_typer(raw_app, name="raw")

RESOLVED_STATUSES: tuple[ReviewStatus, ...] = ("accepted", "rejected", "fixed")
DATE_FORMATS = ["%Y-%m-%d"]


def _version(value: bool) -> None:
    if value:
        typer.echo(f"foodcatch {__version__}")
        raise typer.Exit


@app.callback()
def _main(
    version: Annotated[
        bool, typer.Option("--version", callback=_version, is_eager=True, help="Show version.")
    ] = False,
) -> None:
    """FoodCatch data pipeline."""
    settings = get_settings()
    configure_logging(settings.log_level, settings.log_format)
    init_sentry(settings)


def _fail(message: str, code: int = EXIT_FAILED) -> typer.Exit:
    typer.secho(message, err=True, fg=typer.colors.RED)
    return typer.Exit(code)


def _day(value: datetime | None) -> date | None:
    return value.date() if value else None


def _check_range(since: date | None, until: date | None) -> None:
    if since is not None and until is not None and until <= since:
        raise _fail("--until must be after --since.", 2)


# ----------------------------------------------------------------------------------------- db
@db_app.command("upgrade")
def db_upgrade(
    revision: Annotated[str, typer.Option(help="Target revision.")] = "head",
) -> None:
    """Apply migrations (default: up to the latest revision)."""
    migrate.upgrade(get_settings().database_url, revision)
    typer.echo(f"Database upgraded to {revision}.")


@db_app.command("downgrade")
def db_downgrade(
    revision: Annotated[str, typer.Option(help="Target revision, e.g. -1 or base.")],
) -> None:
    """Revert migrations down to REVISION."""
    migrate.downgrade(get_settings().database_url, revision)
    typer.echo(f"Database downgraded to {revision}.")


@db_app.command("stats")
def db_stats() -> None:
    """Show table sizes and usage of the database size budget."""
    settings = get_settings()
    engine = make_engine(settings=settings)
    try:
        with engine.connect() as conn:
            stats = collect_stats(conn, settings.db_size_budget_mb)
    finally:
        engine.dispose()
    typer.echo(f"{'table':32} {'rows (est.)':>12} {'size':>10}")
    for t in stats.tables:
        typer.echo(f"{t.name:32} {t.row_estimate:>12,} {t.total_bytes / 1024 / 1024:>8.2f} MB")
    used_mb = stats.database_bytes / 1024 / 1024
    line = (
        f"database: {used_mb:.1f} MB of {settings.db_size_budget_mb} MB budget "
        f"({stats.used_fraction:.0%})"
    )
    if stats.over_warning_threshold:
        typer.secho(line + " - above 70 %!", fg=typer.colors.YELLOW)
    else:
        typer.echo(line)


# --------------------------------------------------------------------------------------- jobs
@jobs_app.command("list")
def jobs_list() -> None:
    """List registered jobs."""
    for spec in list_jobs():
        typer.echo(f"{spec.name:22} {spec.source:14} {spec.description}")


@app.command("collect")
def collect(
    job: Annotated[str, typer.Argument(help="Job name, see `foodcatch jobs list`.")],
) -> None:
    """Run one collection job (fetch, store raw, ingest, classify, deals, quality checks)."""
    try:
        result = run_job(job)
    except UnknownJobError as exc:
        raise _fail(str(exc), code=2) from exc
    except Exception as exc:
        raise _fail(f"Job {job!r} failed: {type(exc).__name__}: {exc}") from exc
    if result.status == "degraded":
        raise _fail(f"Job {job!r} degraded: {result.message}", code=EXIT_DEGRADED)
    typer.echo(f"Job {job!r} succeeded (run {result.run_id}).")


@app.command("reprocess")
def reprocess_cmd(
    source: Annotated[str, typer.Option(help=f"One of: {', '.join(RAW_SOURCES)}.")],
    since: Annotated[
        datetime | None,
        typer.Option(formats=DATE_FORMATS, help="Only raw objects fetched on/after this day."),
    ] = None,
    until: Annotated[
        datetime | None,
        typer.Option(
            formats=DATE_FORMATS, help="Only raw objects fetched before this day (exclusive)."
        ),
    ] = None,
) -> None:
    """Replay raw objects through ingest, classification and deals (one transaction)."""
    if source not in RAW_SOURCES:
        raise _fail(f"Unknown source {source!r}; expected one of {', '.join(RAW_SOURCES)}.", 2)
    _check_range(_day(since), _day(until))
    settings = get_settings()
    engine = make_engine(settings=settings)
    try:
        result = reprocess(
            engine,
            raw_store_from_url(settings.raw_store_url, settings),
            settings,
            source=source,
            since=_day(since),
            until=_day(until),
        )
    finally:
        engine.dispose()
    typer.echo(
        f"Reprocessed {result.objects} raw objects: {result.records} records, "
        f"{result.listings} listings."
    )


@app.command("reclassify")
def reclassify() -> None:
    """Re-run recognition for all listings with the current matcher, then recompute deals."""
    engine = make_engine()
    try:
        with engine.begin() as conn:
            count = reclassify_all(conn)
            deals = recompute_deals(conn)
    finally:
        engine.dispose()
    typer.echo(f"Reclassified {count} listings; {deals} deals recomputed.")


# ------------------------------------------------------------------------------------- review
@review_app.command("list")
def review_list(
    reason: Annotated[
        str | None, typer.Option(help=f"Filter by reason: {', '.join(REVIEW_REASONS)}.")
    ] = None,
    status: Annotated[
        str, typer.Option(help="Items with this status (open, accepted, rejected, fixed).")
    ] = "open",
    limit: Annotated[int, typer.Option(min=1, max=1000)] = 50,
) -> None:
    """List review items (default: open ones, oldest first)."""
    if reason is not None and reason not in REVIEW_REASONS:
        raise _fail(f"Unknown reason {reason!r}; expected one of {', '.join(REVIEW_REASONS)}.", 2)
    if status not in ("open", *RESOLVED_STATUSES):
        raise _fail(f"Unknown status {status!r}.", 2)
    engine = make_engine()
    try:
        with engine.connect() as conn:
            items = list_items(conn, status=status, reason=reason, limit=limit)
    finally:
        engine.dispose()
    for item in items:
        note = f"  [{item.note}]" if item.note else ""
        typer.echo(f"{item.id:>6} {item.reason:26} {item.chain_id:12} {item.title}{note}")
    typer.echo(f"{len(items)} item(s).")


@review_app.command("resolve")
def review_resolve(
    item_id: Annotated[int, typer.Argument(help="Review item id (see `foodcatch review list`).")],
    status: Annotated[str, typer.Option(help=f"One of: {', '.join(RESOLVED_STATUSES)}.")],
    note: Annotated[str | None, typer.Option(help="Why (stored with the item).")] = None,
) -> None:
    """Resolve a review item as accepted, rejected or fixed."""
    if status not in RESOLVED_STATUSES:
        raise _fail(
            f"Unknown status {status!r}; expected one of {', '.join(RESOLVED_STATUSES)}.", 2
        )
    engine = make_engine()
    try:
        with engine.begin() as conn:
            resolve(conn, item_id, status, note)
    except ReviewItemNotFoundError as exc:
        raise _fail(f"No review item {item_id}.") from exc
    finally:
        engine.dispose()
    typer.echo(f"Review item {item_id} resolved as {status}.")


# -------------------------------------------------------------------------------------- deals
@deals_app.command("recompute")
def deals_recompute() -> None:
    """Recompute all deals for the current matcher version."""
    engine = make_engine()
    try:
        with engine.begin() as conn:
            count = recompute_deals(conn)
    finally:
        engine.dispose()
    typer.echo(f"Recomputed {count} deals.")


# ---------------------------------------------------------------------------------------- raw
@raw_app.command("reindex")
def raw_reindex(
    source: Annotated[
        str | None, typer.Option(help=f"One of: {', '.join(RAW_SOURCES)} (default: all).")
    ] = None,
    since: Annotated[
        datetime | None,
        typer.Option(formats=DATE_FORMATS, help="Only objects dated on/after this day."),
    ] = None,
    until: Annotated[
        datetime | None,
        typer.Option(formats=DATE_FORMATS, help="Only objects dated before this day."),
    ] = None,
    dry_run: Annotated[bool, typer.Option(help="Only count, write nothing.")] = False,
) -> None:
    """Rebuild missing raw_object rows from the raw store (e.g. after a database restore)."""
    if source is not None and source not in RAW_SOURCES:
        raise _fail(f"Unknown source {source!r}; expected one of {', '.join(RAW_SOURCES)}.", 2)
    _check_range(_day(since), _day(until))
    settings = get_settings()
    engine = make_engine(settings=settings)
    try:
        result = reindex(
            engine,
            raw_store_from_url(settings.raw_store_url, settings),
            sources=[source] if source else RAW_SOURCES,
            since=_day(since),
            until=_day(until),
            dry_run=dry_run,
        )
    finally:
        engine.dispose()
    verb = "would be indexed" if dry_run else "indexed"
    typer.echo(
        f"Scanned {result.scanned} raw objects: {result.indexed} {verb}, "
        f"{result.already_indexed} already indexed, {result.skipped} skipped "
        f"(unrecognized key); {result.runs_created} placeholder fetch runs created."
    )


def main() -> None:
    """Console-script entry point."""
    app()
