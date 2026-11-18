"""Review queue helpers (``review_item``; owned by the matching module).

Recognition queues doubtful listings for a human (see :mod:`foodcatch.matching.persist`):

* ``unrecognized_staple_word`` - nothing recognized, but the text mentions a staple word,
* ``unknown_key_attribute`` - a healthy match with an unknown key attribute (not exact),
* ``ambiguous_offer`` - a match whose offer also covers other products.

An item exists at most once per ``(listing_id, reason)``. A resolved item is never reopened;
an open item whose reason no longer applies after re-classification (or that a
``classification_override`` settles) is closed as ``fixed``.

All functions run inside the caller's transaction (never commit).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Set
from dataclasses import dataclass
from datetime import datetime
from typing import Literal, cast
from uuid import UUID

from sqlalchemy import Connection, func, select, update
from sqlalchemy.dialects.postgresql import insert

from foodcatch.db.tables import listing, review_item
from foodcatch.logging import get_logger

type ReviewReason = Literal["unrecognized_staple_word", "unknown_key_attribute", "ambiguous_offer"]
type ReviewStatus = Literal["open", "accepted", "rejected", "fixed"]

_log = get_logger("review")


class ReviewItemNotFoundError(LookupError):
    """Raised when resolving a review item that does not exist."""


@dataclass(frozen=True, slots=True)
class ReviewItem:
    """A queued listing with the context a reviewer needs."""

    id: int
    listing_id: UUID
    reason: ReviewReason
    status: ReviewStatus
    created_at: datetime
    source: str
    chain_id: str
    title: str
    description: str


def enqueue(conn: Connection, listing_id: UUID, reason: ReviewReason) -> bool:
    """Queue ``listing_id`` for ``reason``; returns whether a new item was created."""
    return enqueue_many(conn, [(listing_id, reason)]) == 1


def enqueue_many(conn: Connection, items: Iterable[tuple[UUID, ReviewReason]]) -> int:
    """Queue several ``(listing_id, reason)`` pairs; returns how many items were created.

    Existing items (open or resolved) are left untouched.
    """
    rows = [{"listing_id": lid, "reason": reason} for lid, reason in dict.fromkeys(items)]
    if not rows:
        return 0
    stmt = (
        insert(review_item)
        .on_conflict_do_nothing(index_elements=["listing_id", "reason"])
        .returning(review_item.c.id)
    )
    return len(conn.execute(stmt, rows).all())


def sync_open_items(conn: Connection, wanted: Mapping[UUID, Set[ReviewReason]]) -> tuple[int, int]:
    """Make the queue reflect a fresh classification of the listings in ``wanted``.

    Every ``(listing, reason)`` in ``wanted`` is enqueued; open items of those listings whose
    reason is no longer wanted are resolved as ``fixed``.

    Returns:
        ``(created, fixed)`` item counts.
    """
    if not wanted:
        return 0, 0
    created = enqueue_many(
        conn, [(listing_id, reason) for listing_id, reasons in wanted.items() for reason in reasons]
    )
    open_items = conn.execute(
        select(review_item.c.id, review_item.c.listing_id, review_item.c.reason).where(
            review_item.c.status == "open", review_item.c.listing_id.in_(list(wanted))
        )
    ).all()
    stale = [row.id for row in open_items if row.reason not in wanted[row.listing_id]]
    if stale:
        conn.execute(
            update(review_item)
            .where(review_item.c.id.in_(stale))
            .values(status="fixed", resolved_at=func.now())
        )
    return created, len(stale)


def list_items(
    conn: Connection,
    *,
    status: ReviewStatus = "open",
    reason: ReviewReason | None = None,
    limit: int = 50,
) -> list[ReviewItem]:
    """Queued items with ``status`` (optionally only ``reason``), oldest first."""
    stmt = (
        select(
            review_item.c.id,
            review_item.c.listing_id,
            review_item.c.reason,
            review_item.c.status,
            review_item.c.created_at,
            listing.c.source,
            listing.c.chain_id,
            listing.c.title,
            listing.c.description,
        )
        .join(listing, listing.c.id == review_item.c.listing_id)
        .where(review_item.c.status == status)
        .order_by(review_item.c.created_at, review_item.c.id)
        .limit(limit)
    )
    if reason is not None:
        stmt = stmt.where(review_item.c.reason == reason)
    return [
        ReviewItem(
            id=row.id,
            listing_id=row.listing_id,
            reason=cast(ReviewReason, row.reason),
            status=cast(ReviewStatus, row.status),
            created_at=row.created_at,
            source=row.source,
            chain_id=row.chain_id,
            title=row.title,
            description=row.description,
        )
        for row in conn.execute(stmt)
    ]


def list_open(
    conn: Connection, reason: ReviewReason | None = None, *, limit: int = 50
) -> list[ReviewItem]:
    """Open items (optionally only ``reason``), oldest first."""
    return list_items(conn, status="open", reason=reason, limit=limit)


def resolve(conn: Connection, item_id: int, status: ReviewStatus, note: str | None = None) -> None:
    """Resolve item ``item_id`` as ``accepted``, ``rejected`` or ``fixed``.

    ``note`` is written to the log only: ``review_item`` has no column for it yet.

    Raises:
        ValueError: ``status`` is ``open``.
        ReviewItemNotFoundError: no item ``item_id`` exists.
    """
    if status == "open":
        raise ValueError("an item cannot be resolved as 'open'")
    result = conn.execute(
        update(review_item)
        .where(review_item.c.id == item_id)
        .values(status=status, resolved_at=func.now())
        .returning(review_item.c.listing_id, review_item.c.reason)
    ).one_or_none()
    if result is None:
        raise ReviewItemNotFoundError(item_id)
    _log.info(
        "review item resolved",
        item_id=item_id,
        listing_id=str(result.listing_id),
        reason=result.reason,
        status=status,
        note=note,
    )
