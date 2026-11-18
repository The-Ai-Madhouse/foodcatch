"""Deal verdict (architecture §6) - Python mirror of ``web/src/lib/verdict.ts``.

Both implementations must pass the shared cases in ``fixtures/verdict_cases.json`` (repo root;
load them in tests with the ``shared_fixture`` pytest fixture). Rules, in order:

* ``no_price`` - ``netto_unit_price_worst`` is unknown.
* ``ambiguous_offer`` - ``price_applies`` is false.
* ``not_exact`` - the variant has unknown key attributes.
* ``no_reference`` - no reference from a nearby chain (``history`` and ``ean_reference``
  count regardless of distance).
* ``good_deal`` - ``netto_unit_price_worst <= min(reference unit_price)``.
* ``cheaper_elsewhere`` - ``netto_unit_price_best > min(reference unit_price)``.
* ``undecided`` - otherwise.

``cheapest_unit_price`` / ``reference_count`` describe the references that counted (``None`` /
0 for the first four verdicts).
"""

from __future__ import annotations

from collections.abc import Collection, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal

type Verdict = Literal[
    "no_price",
    "ambiguous_offer",
    "not_exact",
    "no_reference",
    "good_deal",
    "cheaper_elsewhere",
    "undecided",
]
type ReferenceKind = Literal["offer", "regular", "history", "ean_reference"]

LOCATION_INDEPENDENT_KINDS: frozenset[ReferenceKind] = frozenset({"history", "ean_reference"})


@dataclass(frozen=True, slots=True)
class Reference:
    """One same-class reference price (an element of ``deal.references``)."""

    kind: ReferenceKind
    chain_id: str
    unit_price: float
    listing_id: str | None = None
    title: str | None = None
    unit: str | None = None
    valid_from: datetime | None = None
    valid_to: datetime | None = None


@dataclass(frozen=True, slots=True)
class DealInput:
    """The verdict-relevant part of a ``api.current_netto_deals`` row."""

    netto_unit_price_worst: float | None
    netto_unit_price_best: float | None
    price_applies: bool
    is_exact: bool
    references: Sequence[Reference] = field(default_factory=tuple[Reference, ...])


@dataclass(frozen=True, slots=True)
class VerdictResult:
    """Verdict plus the facts behind it."""

    verdict: Verdict
    cheapest_unit_price: float | None
    reference_count: int


def verdict(deal: DealInput, nearby_chains: Collection[str]) -> VerdictResult:
    """Compute the verdict for ``deal`` given the chains with a store near the user."""
    raise NotImplementedError
