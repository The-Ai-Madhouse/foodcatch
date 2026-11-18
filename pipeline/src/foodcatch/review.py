"""Review queue helpers (``review_item``; owned by the matching module).

Expected public functions:

* :func:`enqueue` - add a listing to the queue for a reason (idempotent on
  ``(listing_id, reason)``; a resolved item is not reopened).
* :func:`list_items` - items joined with their listing (for ``foodcatch review list``).
* :func:`resolve` - set the status (``accepted`` | ``rejected`` | ``fixed``) and ``resolved_at``.

All run inside the caller's transaction (never commit).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal
from uuid import UUID

from sqlalchemy import Connection

type ReviewReason = Literal["unrecognized_staple_word", "unknown_key_attribute", "ambiguous_offer"]
type ReviewStatus = Literal["open", "accepted", "rejected", "fixed"]


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
    raise NotImplementedError


def list_items(
    conn: Connection,
    *,
    status: ReviewStatus = "open",
    reason: ReviewReason | None = None,
    limit: int = 50,
) -> list[ReviewItem]:
    """Queued items, oldest first."""
    raise NotImplementedError


def resolve(conn: Connection, item_id: int, *, status: ReviewStatus) -> None:
    """Resolve an item (``status`` other than ``open``)."""
    raise NotImplementedError
