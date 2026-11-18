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

from pydantic import TypeAdapter

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


_REFERENCES_ADAPTER: TypeAdapter[list[Reference]] = TypeAdapter(list[Reference])


def parse_references(data: object) -> tuple[Reference, ...]:
    """Validate a ``deal.references`` JSON array into :class:`Reference` objects.

    Raises:
        pydantic.ValidationError: ``data`` is not an array of reference objects.
    """
    return tuple(_REFERENCES_ADAPTER.validate_python(data))


def counted_references(deal: DealInput, nearby_chains: Collection[str]) -> list[Reference]:
    """The references that count for a user near ``nearby_chains``.

    ``offer`` and ``regular`` references count only from a nearby chain; ``history`` and
    ``ean_reference`` count regardless of distance.
    """
    nearby = frozenset(nearby_chains)
    return [
        r for r in deal.references if r.kind in LOCATION_INDEPENDENT_KINDS or r.chain_id in nearby
    ]


def _result(v: Verdict, cheapest: float | None = None, count: int = 0) -> VerdictResult:
    return VerdictResult(verdict=v, cheapest_unit_price=cheapest, reference_count=count)


def verdict(deal: DealInput, nearby_chains: Collection[str]) -> VerdictResult:
    """Compute the verdict for ``deal`` given the chains with a store near the user.

    Netto is judged at its worst (highest) unit price against the cheapest counted reference;
    a missing ``netto_unit_price_best`` falls back to the worst price.
    """
    worst = deal.netto_unit_price_worst
    if worst is None:
        return _result("no_price")
    if not deal.price_applies:
        return _result("ambiguous_offer")
    if not deal.is_exact:
        return _result("not_exact")
    counted = counted_references(deal, nearby_chains)
    if not counted:
        return _result("no_reference")
    cheapest = min(r.unit_price for r in counted)
    best = worst if deal.netto_unit_price_best is None else deal.netto_unit_price_best
    if worst <= cheapest:
        v: Verdict = "good_deal"
    elif best > cheapest:
        v = "cheaper_elsewhere"
    else:
        v = "undecided"
    return _result(v, cheapest, len(counted))
