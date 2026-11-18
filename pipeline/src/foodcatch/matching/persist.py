"""Persisting recognition results: ``classification`` rows, overrides and the review queue.

Public functions (signatures are a contract; called by the job hooks and the CLI):

* :func:`classify_pending` - classify the listings a run touched plus every listing not yet
  processed with ``version``.
* :func:`reclassify_all` - classify every listing with ``version``, make it the current
  ``matcher_release`` and prune classifications of all but the two most recent versions.

How a listing is classified:

* The text is ``listing.title`` + ``listing.description``; Salling food-waste listings also pass
  their product's ``source_category`` as the category hint.
* A ``classification_override`` matching ``(listing.source, normalize(listing.title))`` wins:
  ``reject`` yields no rows, ``force`` yields the variants of ``forced_result`` (see
  :class:`ForcedVariant`; a single object or a list of them).
* Every recognized variant becomes one row (``variant_index`` 0..n-1) with all
  :class:`~foodcatch.matching.Match` fields and ``is_healthy = is_healthy_staple(m)``. A listing
  without a recognized variant gets no rows.
* Doubtful rule-based results are queued in ``review_item`` (:mod:`foodcatch.review`):
  ``unrecognized_staple_word`` (nothing recognized, but the text mentions a staple word),
  ``unknown_key_attribute`` (a healthy match that is not exact) and ``ambiguous_offer`` (a match
  whose offer also covers other products). Open items whose reason disappears on
  re-classification (or that an override settles) are closed as ``fixed``.

Each processed listing records ``{"version", "fingerprint"}`` under ``listing.extra["matcher"]``.
The fingerprint covers everything the result depends on (texts, category hint, override), so
re-ingested listings are only re-classified when their input changed, and listings without any
recognized variant are not re-classified on every run. Rows are only rewritten when the result
changed, so unchanged listings keep their ``deal`` rows.

Both functions run inside the caller's transaction (never commit).
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Collection, Iterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError
from sqlalchemy import (
    ColumnElement,
    Connection,
    any_,
    bindparam,
    delete,
    func,
    insert,
    or_,
    select,
    true,
    update,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.dialects.postgresql import insert as pg_insert

from foodcatch.db.tables import (
    classification,
    classification_override,
    listing,
    matcher_release,
    product,
)
from foodcatch.logging import get_logger
from foodcatch.matching import MATCHER_VERSION
from foodcatch.matching.compare import contains_staple_word, is_healthy_staple
from foodcatch.matching.model import Match
from foodcatch.matching.normalize import normalize
from foodcatch.matching.recognize import classify
from foodcatch.matching.salling_categories import SALLING_NON_STAPLE, category_leaf
from foodcatch.matching.taxonomy import UnknownProductTypeError, get_type
from foodcatch.review import ReviewReason, sync_open_items

_log = get_logger(__name__)

BATCH_SIZE = 1000
"""Listings loaded, classified and written per round trip."""

KEPT_VERSIONS = 2
"""Classifications of this many most recent matcher versions are kept (plus the current one)."""

MARKER_KEY = "matcher"
"""Key in ``listing.extra`` recording the version and input fingerprint of the last run."""

FOOD_WASTE_SOURCE = "salling_food_waste"
"""Listings of this source use their product's category path as the category hint."""

NOTE_OVERRIDE = "manuelt fastsat"
"""Note on every variant forced by a ``classification_override`` (Danish, shown to humans)."""


class ForcedVariant(BaseModel):
    """One variant of a ``classification_override.forced_result``.

    Example: ``{"type_id": "mælk", "attrs": {"mælketype": "letmælk", "øko": "nej",
    "laktosefri": "nej"}}``. Key attributes missing from ``attrs`` are unknown (``?``).
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    type_id: str
    attrs: dict[str, str] = Field(default_factory=dict[str, str])
    notes: list[str] = Field(default_factory=list[str])


_FORCED_RESULT: TypeAdapter[ForcedVariant | list[ForcedVariant]] = TypeAdapter(
    ForcedVariant | list[ForcedVariant]
)


class InvalidOverrideError(ValueError):
    """A ``classification_override.forced_result`` is not a valid forced classification."""


def parse_forced_result(value: object, *, title: str = "") -> list[Match]:
    """Turn a ``forced_result`` JSON value into matches (``source_hint = "override"``).

    Args:
        value: a :class:`ForcedVariant` object or a non-empty list of them.
        title: the listing title, recorded as each match's ``variant_text``.

    Raises:
        InvalidOverrideError: the value does not validate or names an unknown product type.
    """
    try:
        parsed = _FORCED_RESULT.validate_python(value)
    except ValidationError as exc:
        raise InvalidOverrideError(f"invalid forced_result: {exc}") from exc
    variants = parsed if isinstance(parsed, list) else [parsed]
    if not variants:
        raise InvalidOverrideError("forced_result must name at least one variant")
    matches: list[Match] = []
    for variant in variants:
        try:
            product_type = get_type(variant.type_id)
        except UnknownProductTypeError as exc:
            raise InvalidOverrideError(f"unknown type_id {variant.type_id!r}") from exc
        matches.append(
            Match(
                type_id=product_type.id,
                type_label=product_type.label,
                group_name=product_type.group,
                attrs=dict(variant.attrs),
                key_attrs=product_type.key_attrs,
                variant_text=normalize(title),
                source_hint="override",
                notes=[NOTE_OVERRIDE, *variant.notes],
            )
        )
    return _count_variants(matches)


def _count_variants(matches: list[Match]) -> list[Match]:
    """Keep the first match per class and record the offer's variant counts on each."""
    per_class: dict[str, int] = {}
    for m in matches:
        per_class[m.class_key] = per_class.get(m.class_key, 0) + 1
    out: list[Match] = []
    for m in matches:
        if any(o.class_key == m.class_key for o in out):
            continue
        m.offer_variants, m.same_class_variants = len(matches), per_class[m.class_key]
        out.append(m)
    return out


def review_reasons(
    matches: Sequence[Match], *, title: str, description: str, category_hint: str | None
) -> set[ReviewReason]:
    """Why a rule-based result needs a human (empty: it does not).

    * ``unrecognized_staple_word`` - nothing recognized, the text mentions a staple word and no
      category hint marks the product as a known non-staple.
    * ``unknown_key_attribute`` - a healthy match is not exact.
    * ``ambiguous_offer`` - a match's offer also covers other products.
    """
    reasons: set[ReviewReason] = set()
    if not matches:
        non_staple = (
            category_hint is not None and category_leaf(category_hint) in SALLING_NON_STAPLE
        )
        text = f"{title} {description}"
        if not non_staple and (contains_staple_word(text) or contains_staple_word(normalize(text))):
            reasons.add("unrecognized_staple_word")
        return reasons
    if any(is_healthy_staple(m) and not m.is_exact for m in matches):
        reasons.add("unknown_key_attribute")
    if any(not m.offer_is_homogeneous for m in matches):
        reasons.add("ambiguous_offer")
    return reasons


# ----------------------------------------------------------------------------- data access


@dataclass(frozen=True, slots=True)
class _Override:
    action: str
    forced_result: Any

    def fingerprint_part(self) -> list[Any]:
        return [self.action, self.forced_result]


@dataclass(frozen=True, slots=True)
class _ListingInput:
    """What recognition needs of a listing (plus the marker of its last classification)."""

    id: UUID
    source: str
    title: str
    description: str
    marker_version: str | None
    marker_fingerprint: str | None
    category_hint: str | None


@dataclass(frozen=True, slots=True)
class _Outcome:
    matches: list[Match]
    reasons: set[ReviewReason]
    fingerprint: str


type _ClassRow = tuple[Any, ...]


def _load_overrides(conn: Connection) -> dict[tuple[str, str], _Override]:
    rows = conn.execute(
        select(
            classification_override.c.source,
            classification_override.c.match_title_normalized,
            classification_override.c.action,
            classification_override.c.forced_result,
        )
    )
    return {
        (row.source, row.match_title_normalized): _Override(row.action, row.forced_result)
        for row in rows
    }


def ensure_release(conn: Connection, version: str) -> bool:
    """Insert the ``matcher_release`` row for ``version`` (not current) if missing.

    Returns:
        Whether a new release row was created.
    """
    created = conn.execute(
        pg_insert(matcher_release)
        .values(version=version, is_current=False)
        .on_conflict_do_nothing(index_elements=["version"])
        .returning(matcher_release.c.version)
    ).first()
    return created is not None


def _listing_batches(
    conn: Connection, condition: ColumnElement[bool]
) -> Iterator[list[_ListingInput]]:
    """Listings matching ``condition`` with their category path, in id order, batch by batch."""
    after: UUID | None = None
    while True:
        query = (
            select(
                listing.c.id,
                listing.c.source,
                listing.c.title,
                listing.c.description,
                listing.c.extra[MARKER_KEY]["version"].astext.label("marker_version"),
                listing.c.extra[MARKER_KEY]["fingerprint"].astext.label("marker_fingerprint"),
                product.c.source_category,
            )
            .select_from(listing.outerjoin(product, product.c.id == listing.c.product_id))
            .where(condition)
            .order_by(listing.c.id)
            .limit(BATCH_SIZE)
        )
        if after is not None:
            query = query.where(listing.c.id > after)
        rows = [
            _ListingInput(
                id=row.id,
                source=row.source,
                title=row.title,
                description=row.description or "",
                marker_version=row.marker_version,
                marker_fingerprint=row.marker_fingerprint,
                category_hint=row.source_category if row.source == FOOD_WASTE_SOURCE else None,
            )
            for row in conn.execute(query)
        ]
        if not rows:
            return
        yield rows
        after = rows[-1].id


def _fingerprint(row: _ListingInput, override: _Override | None) -> str:
    payload = [
        row.source,
        row.title,
        row.description,
        row.category_hint,
        override.fingerprint_part() if override else None,
    ]
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(encoded.encode()).hexdigest()[:32]


def _classify_row(row: _ListingInput, override: _Override | None, fingerprint: str) -> _Outcome:
    title, description, category_hint = row.title, row.description, row.category_hint
    if override is not None and override.action == "reject":
        return _Outcome([], set(), fingerprint)
    if override is not None and override.action == "force":
        try:
            return _Outcome(
                parse_forced_result(override.forced_result, title=title), set(), fingerprint
            )
        except InvalidOverrideError as exc:
            # A broken manual row must not stop data collection: fall back to the rules.
            _log.error(
                "invalid classification override; using rules",
                listing_id=str(row.id),
                source=row.source,
                error=str(exc),
            )
    matches = classify(title, description, category_hint)
    reasons = review_reasons(
        matches, title=title, description=description, category_hint=category_hint
    )
    return _Outcome(matches, reasons, fingerprint)


def _class_row(listing_id: UUID, version: str, index: int, m: Match) -> dict[str, Any]:
    return {
        "listing_id": listing_id,
        "matcher_version": version,
        "variant_index": index,
        "type_id": m.type_id,
        "type_label": m.type_label,
        "group_name": m.group_name,
        "attrs": dict(m.attrs),
        "class_key": m.class_key,
        "class_label": m.class_label,
        "is_exact": m.is_exact,
        "is_healthy": is_healthy_staple(m),
        "offer_variants": m.offer_variants,
        "same_class_variants": m.same_class_variants,
        "notes": list(m.notes),
        "source_hint": m.source_hint,
    }


_COMPARED_COLUMNS = (
    "variant_index",
    "type_id",
    "type_label",
    "group_name",
    "attrs",
    "class_key",
    "class_label",
    "is_exact",
    "is_healthy",
    "offer_variants",
    "same_class_variants",
    "notes",
    "source_hint",
)


def _comparable(row: Mapping[Any, Any]) -> _ClassRow:
    return tuple(
        json.dumps(row[c], sort_keys=True, ensure_ascii=False) if c == "attrs" else row[c]
        for c in _COMPARED_COLUMNS
    )


def _existing_rows(
    conn: Connection, listing_ids: Collection[UUID], version: str
) -> dict[UUID, list[_ClassRow]]:
    rows = conn.execute(
        select(classification)
        .where(
            classification.c.matcher_version == version,
            classification.c.listing_id == any_(_uuid_array(listing_ids)),
        )
        .order_by(classification.c.listing_id, classification.c.variant_index)
    ).mappings()
    existing: dict[UUID, list[_ClassRow]] = {}
    for row in rows:
        existing.setdefault(row["listing_id"], []).append(_comparable(row))
    return existing


def _uuid_array(ids: Collection[UUID]) -> Any:
    return bindparam(None, list(ids), type_=ARRAY(PG_UUID(as_uuid=True)))


def _process(
    conn: Connection,
    rows: Sequence[_ListingInput],
    version: str,
    *,
    force: bool,
    overrides: Mapping[tuple[str, str], _Override],
) -> tuple[int, list[UUID]]:
    """Classify one batch; returns ``(processed, ids of listings whose rows changed)``."""
    outcomes: dict[UUID, _Outcome] = {}
    for row in rows:
        override = overrides.get((row.source, normalize(row.title)))
        fingerprint = _fingerprint(row, override)
        if not force and row.marker_version == version and row.marker_fingerprint == fingerprint:
            continue
        outcomes[row.id] = _classify_row(row, override, fingerprint)
    if not outcomes:
        return 0, []

    existing = _existing_rows(conn, outcomes.keys(), version)
    changed: list[UUID] = []
    new_rows: list[dict[str, Any]] = []
    for listing_id, outcome in outcomes.items():
        rows_for_listing = [
            _class_row(listing_id, version, i, m) for i, m in enumerate(outcome.matches)
        ]
        if [_comparable(r) for r in rows_for_listing] != existing.get(listing_id, []):
            changed.append(listing_id)
            new_rows.extend(rows_for_listing)
    if changed:
        conn.execute(
            delete(classification).where(
                classification.c.matcher_version == version,
                classification.c.listing_id == any_(_uuid_array(changed)),
            )
        )
    if new_rows:
        conn.execute(insert(classification), new_rows)

    conn.execute(
        update(listing)
        .where(listing.c.id == bindparam("target_id"))
        .values(
            extra=listing.c.extra.op("||")(
                func.jsonb_build_object(MARKER_KEY, bindparam("marker", type_=JSONB))
            )
        ),
        [
            {
                "target_id": listing_id,
                "marker": {"version": version, "fingerprint": outcome.fingerprint},
            }
            for listing_id, outcome in outcomes.items()
        ],
    )
    sync_open_items(conn, {listing_id: o.reasons for listing_id, o in outcomes.items()})
    return len(outcomes), changed


def _run(
    conn: Connection, condition: ColumnElement[bool], version: str, *, force: bool
) -> tuple[int, list[UUID]]:
    overrides = _load_overrides(conn)
    processed = 0
    changed: list[UUID] = []
    for rows in _listing_batches(conn, condition):
        count, batch_changed = _process(conn, rows, version, force=force, overrides=overrides)
        processed += count
        changed.extend(batch_changed)
    return processed, changed


# ------------------------------------------------------------------------------ public API


def classify_pending(
    conn: Connection, *, version: str, listing_ids: Collection[UUID] | None = None
) -> list[UUID]:
    """Classify listings whose classification for ``version`` is missing or outdated.

    Candidates are the listings in ``listing_ids`` (those a run inserted or changed) plus every
    listing not yet processed with ``version``. A candidate is re-classified when its input
    (title, description, category hint or matching override) changed since it was last
    processed with ``version``. Inserts the ``matcher_release`` row for ``version`` if missing
    (not current).

    Returns:
        Ids of the listings whose classification rows changed (written, replaced or removed),
        i.e. the listings whose deals need recomputing.
    """
    ensure_release(conn, version)
    not_processed = func.coalesce(listing.c.extra[MARKER_KEY]["version"].astext, "") != version
    condition: ColumnElement[bool] = not_processed
    if listing_ids:
        condition = or_(listing.c.id == any_(_uuid_array(listing_ids)), not_processed)
    processed, changed = _run(conn, condition, version, force=False)
    _log.info(
        "classified pending listings", version=version, processed=processed, changed=len(changed)
    )
    return changed


def reclassify_all(conn: Connection, *, version: str = MATCHER_VERSION) -> int:
    """Re-classify all listings with ``version``, make it current and prune old versions.

    Inserts the ``matcher_release`` row if ``version`` is new and marks it the only current
    release. Classification rows (and through them deals) of versions other than the
    :data:`KEPT_VERSIONS` most recent releases and the current one are deleted.

    Returns:
        Number of listings processed.
    """
    created = ensure_release(conn, version)
    conn.execute(
        update(matcher_release)
        .where(matcher_release.c.is_current, matcher_release.c.version != version)
        .values(is_current=False)
    )
    conn.execute(
        update(matcher_release).where(matcher_release.c.version == version).values(is_current=True)
    )
    processed, changed = _run(conn, true(), version, force=True)
    pruned = prune_classifications(conn)
    _log.info(
        "reclassified all listings",
        version=version,
        new_release=created,
        processed=processed,
        changed=len(changed),
        pruned_rows=pruned,
    )
    return processed


def prune_classifications(conn: Connection, *, keep: int = KEPT_VERSIONS) -> int:
    """Delete classification rows of all but the ``keep`` most recent releases and the current one.

    Returns:
        Number of deleted classification rows.
    """
    recent = (
        select(matcher_release.c.version)
        .order_by(matcher_release.c.created_at.desc(), matcher_release.c.version.desc())
        .limit(keep)
    )
    current = select(matcher_release.c.version).where(matcher_release.c.is_current)
    result = conn.execute(
        delete(classification).where(
            classification.c.matcher_version.not_in(recent),
            classification.c.matcher_version.not_in(current),
        )
    )
    return result.rowcount
