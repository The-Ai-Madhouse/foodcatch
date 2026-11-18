"""Database schema: the single source of truth for table definitions (architecture §5).

SQLAlchemy Core tables in schema ``public``. Enumerations are ``text`` columns with CHECK
constraints. Alembic migrations in ``db/migrations`` must produce exactly this schema
(``tests/db/test_migrations.py`` verifies it). The read-only ``api`` views (architecture §7) are
defined in migrations only.

Conventions: timestamps are ``timestamptz`` (UTC), money ``numeric(10,2)`` DKK, unit prices
``numeric(12,4)``.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    Double,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    MetaData,
    Numeric,
    PrimaryKeyConstraint,
    SmallInteger,
    Table,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID

NAMING_CONVENTION = {
    "ix": "ix_%(table_name)s_%(column_0_N_name)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}

metadata = MetaData(naming_convention=NAMING_CONVENTION)

# --- allowed values of text "enums" (keep in sync with CHECK constraints) -----------------
FETCH_RUN_STATUSES = ("running", "succeeded", "degraded", "failed")
STORE_SOURCES = ("salling", "tjek")
LISTING_SOURCES = ("tjek", "rema", "salling_food_waste")
LISTING_KINDS = ("offer", "regular", "clearance")
UNITS = ("kg", "l", "stk")
OVERRIDE_ACTIONS = ("reject", "force")
REVIEW_REASONS = ("unrecognized_staple_word", "unknown_key_attribute", "ambiguous_offer")
REVIEW_STATUSES = ("open", "accepted", "rejected", "fixed")
NUTRISCORE_GRADES = ("a", "b", "c", "d", "e")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


def _uuid_pk() -> Column[Any]:
    return Column("id", UUID(as_uuid=True), primary_key=True, server_default=func.gen_random_uuid())


def _ts(name: str, *, nullable: bool = False, default_now: bool = True) -> Column[Any]:
    return Column(
        name,
        DateTime(timezone=True),
        nullable=nullable,
        server_default=func.now() if default_now else None,
    )


MONEY = Numeric(10, 2)
UNIT_PRICE = Numeric(12, 4)

fetch_run = Table(
    "fetch_run",
    metadata,
    _uuid_pk(),
    Column("job", Text, nullable=False),
    Column("source", Text, nullable=False),
    Column("status", Text, nullable=False, server_default="running"),
    _ts("started_at"),
    _ts("finished_at", nullable=True, default_now=False),
    Column("git_sha", Text),
    Column("stats", JSONB, nullable=False, server_default=text("'{}'::jsonb")),
    Column("error", Text),
    CheckConstraint(_in("status", FETCH_RUN_STATUSES), name="status"),
    Index(None, "job", "started_at"),
)

raw_object = Table(
    "raw_object",
    metadata,
    _uuid_pk(),
    Column(
        "fetch_run_id",
        UUID(as_uuid=True),
        ForeignKey("fetch_run.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    ),
    Column("source", Text, nullable=False),
    Column("endpoint", Text, nullable=False),
    Column("params", JSONB, nullable=False, server_default=text("'{}'::jsonb")),
    Column("storage_key", Text, nullable=False, unique=True),
    Column("sha256", Text, nullable=False),
    Column("bytes", Integer, nullable=False),
    _ts("fetched_at"),
    CheckConstraint("bytes >= 0", name="bytes_non_negative"),
    Index(None, "source", "fetched_at"),
)

chain = Table(
    "chain",
    metadata,
    Column("id", Text, primary_key=True),
    Column("name", Text, nullable=False),
    Column("tjek_dealer_id", Text, unique=True),
    Column("salling_brand", Text, unique=True),
)

store = Table(
    "store",
    metadata,
    _uuid_pk(),
    Column("chain_id", Text, ForeignKey("chain.id"), nullable=False, index=True),
    Column("source", Text, nullable=False),
    Column("source_store_id", Text, nullable=False),
    Column("name", Text),
    Column("street", Text),
    Column("zip", Text),
    Column("city", Text),
    Column("lat", Double),
    Column("lon", Double),
    _ts("first_seen_at"),
    _ts("last_seen_at"),
    UniqueConstraint("source", "source_store_id"),
    CheckConstraint(_in("source", STORE_SOURCES), name="source"),
    CheckConstraint("lat IS NULL OR lat BETWEEN -90 AND 90", name="lat_range"),
    CheckConstraint("lon IS NULL OR lon BETWEEN -180 AND 180", name="lon_range"),
)

product = Table(
    "product",
    metadata,
    _uuid_pk(),
    Column("ean", Text, nullable=False, unique=True),
    Column("name", Text),
    Column("brand", Text),
    Column("source_category", Text),
    Column("quantity_text", Text),
    Column("net_quantity", Numeric),
    Column("net_unit", Text),
    Column("nova_group", SmallInteger),
    Column("nutriscore_grade", Text),
    _ts("off_checked_at", nullable=True, default_now=False),
    _ts("first_seen_at"),
    _ts("last_seen_at"),
    CheckConstraint(f"net_unit IS NULL OR {_in('net_unit', UNITS)}", name="net_unit"),
    CheckConstraint("nova_group IS NULL OR nova_group BETWEEN 1 AND 4", name="nova_group"),
    CheckConstraint(
        f"nutriscore_grade IS NULL OR {_in('nutriscore_grade', NUTRISCORE_GRADES)}",
        name="nutriscore_grade",
    ),
)

product_reference_price = Table(
    "product_reference_price",
    metadata,
    Column("id", BigInteger, primary_key=True, autoincrement=True),
    Column(
        "product_id",
        UUID(as_uuid=True),
        ForeignKey("product.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("chain_id", Text, ForeignKey("chain.id"), nullable=False),
    Column("price", MONEY, nullable=False),
    _ts("first_seen_at"),
    _ts("last_seen_at"),
    Column("observations", Integer, nullable=False, server_default=text("1")),
    UniqueConstraint(
        "product_id",
        "chain_id",
        "price",
        "first_seen_at",
        name="uq_product_reference_price_observation",
    ),
    CheckConstraint("price >= 0", name="price_non_negative"),
    CheckConstraint("observations >= 1", name="observations_positive"),
)

listing = Table(
    "listing",
    metadata,
    _uuid_pk(),
    Column("source", Text, nullable=False),
    Column("source_item_id", Text, nullable=False),
    Column("chain_id", Text, ForeignKey("chain.id"), nullable=False),
    Column("store_id", UUID(as_uuid=True), ForeignKey("store.id"), index=True),
    Column("catalog_id", Text),
    Column("kind", Text, nullable=False),
    Column("title", Text, nullable=False),
    Column("description", Text, nullable=False, server_default=""),
    Column("product_id", UUID(as_uuid=True), ForeignKey("product.id"), index=True),
    Column("price", MONEY, nullable=False),
    Column("reference_price", MONEY),
    Column("unit", Text),
    Column("size_min", Numeric),
    Column("size_max", Numeric),
    Column("unit_price_min", UNIT_PRICE),
    Column("unit_price_max", UNIT_PRICE),
    Column("member_only", Boolean, nullable=False, server_default=text("false")),
    Column("max_per_customer", Integer),
    Column("valid_from", DateTime(timezone=True), nullable=False),
    Column("valid_to", DateTime(timezone=True)),
    _ts("first_seen_at"),
    _ts("last_seen_at"),
    Column(
        "raw_object_id",
        UUID(as_uuid=True),
        ForeignKey("raw_object.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    ),
    Column("extra", JSONB, nullable=False, server_default=text("'{}'::jsonb")),
    UniqueConstraint("source", "source_item_id", "valid_from", "price"),
    CheckConstraint(_in("source", LISTING_SOURCES), name="source"),
    CheckConstraint(_in("kind", LISTING_KINDS), name="kind"),
    CheckConstraint(f"unit IS NULL OR {_in('unit', UNITS)}", name="unit"),
    CheckConstraint("price >= 0", name="price_non_negative"),
    CheckConstraint(
        "source <> 'salling_food_waste' OR store_id IS NOT NULL", name="food_waste_has_store"
    ),
    CheckConstraint(
        "size_min IS NULL OR size_max IS NULL OR size_min <= size_max", name="size_range"
    ),
    CheckConstraint(
        "unit_price_min IS NULL OR unit_price_max IS NULL OR unit_price_min <= unit_price_max",
        name="unit_price_range",
    ),
    CheckConstraint("valid_to IS NULL OR valid_to >= valid_from", name="validity_range"),
    Index(None, "chain_id", "kind", "valid_to"),
)

matcher_release = Table(
    "matcher_release",
    metadata,
    Column("version", Text, primary_key=True),
    _ts("created_at"),
    Column("is_current", Boolean, nullable=False, server_default=text("false")),
    # at most one current release
    Index(
        "uq_matcher_release_is_current",
        "is_current",
        unique=True,
        postgresql_where=text("is_current"),
    ),
)

classification = Table(
    "classification",
    metadata,
    Column(
        "listing_id",
        UUID(as_uuid=True),
        ForeignKey("listing.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column(
        "matcher_version",
        Text,
        ForeignKey("matcher_release.version", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("variant_index", SmallInteger, nullable=False),
    Column("type_id", Text, nullable=False),
    Column("type_label", Text, nullable=False),
    Column("group_name", Text, nullable=False),
    Column("attrs", JSONB, nullable=False, server_default=text("'{}'::jsonb")),
    Column("class_key", Text, nullable=False),
    Column("class_label", Text, nullable=False),
    Column("is_exact", Boolean, nullable=False),
    Column("is_healthy", Boolean, nullable=False),
    Column("offer_variants", SmallInteger, nullable=False, server_default=text("1")),
    Column("same_class_variants", SmallInteger, nullable=False, server_default=text("1")),
    Column("notes", ARRAY(Text), nullable=False, server_default=text("'{}'::text[]")),
    Column("source_hint", Text),
    PrimaryKeyConstraint("listing_id", "matcher_version", "variant_index"),
    CheckConstraint("variant_index >= 0", name="variant_index_non_negative"),
    CheckConstraint(
        "same_class_variants >= 1 AND same_class_variants <= offer_variants",
        name="variant_counts",
    ),
    Index(None, "matcher_version", "class_key"),
)

classification_override = Table(
    "classification_override",
    metadata,
    Column("id", BigInteger, primary_key=True, autoincrement=True),
    Column("source", Text, nullable=False),
    Column("match_title_normalized", Text, nullable=False),
    Column("action", Text, nullable=False),
    Column("forced_result", JSONB),
    Column("note", Text),
    _ts("created_at"),
    UniqueConstraint("source", "match_title_normalized"),
    CheckConstraint(_in("action", OVERRIDE_ACTIONS), name="action"),
    CheckConstraint("action <> 'force' OR forced_result IS NOT NULL", name="force_has_result"),
)

review_item = Table(
    "review_item",
    metadata,
    Column("id", BigInteger, primary_key=True, autoincrement=True),
    Column(
        "listing_id",
        UUID(as_uuid=True),
        ForeignKey("listing.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("reason", Text, nullable=False),
    Column("status", Text, nullable=False, server_default="open"),
    _ts("created_at"),
    _ts("resolved_at", nullable=True, default_now=False),
    UniqueConstraint("listing_id", "reason"),
    CheckConstraint(_in("reason", REVIEW_REASONS), name="reason"),
    CheckConstraint(_in("status", REVIEW_STATUSES), name="status"),
    Index(None, "status", "reason"),
)

deal = Table(
    "deal",
    metadata,
    Column("listing_id", UUID(as_uuid=True), nullable=False),
    Column("variant_index", SmallInteger, nullable=False),
    Column(
        "matcher_version",
        Text,
        ForeignKey("matcher_release.version", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("class_key", Text, nullable=False),
    Column("netto_unit_price_worst", UNIT_PRICE),
    Column("netto_unit_price_best", UNIT_PRICE),
    Column("price_applies", Boolean, nullable=False),
    Column("references", JSONB, nullable=False, server_default=text("'[]'::jsonb")),
    _ts("computed_at"),
    PrimaryKeyConstraint("listing_id", "variant_index", "matcher_version"),
    # a deal always belongs to an existing classified variant
    ForeignKeyConstraint(
        ["listing_id", "matcher_version", "variant_index"],
        [
            "classification.listing_id",
            "classification.matcher_version",
            "classification.variant_index",
        ],
        name="fk_deal_classification",
        ondelete="CASCADE",
    ),
    CheckConstraint(
        "netto_unit_price_best IS NULL OR netto_unit_price_worst IS NULL"
        " OR netto_unit_price_best <= netto_unit_price_worst",
        name="unit_price_order",
    ),
    CheckConstraint("jsonb_typeof(\"references\") = 'array'", name="references_is_array"),
    Index(None, "matcher_version", "class_key"),
)

__all__ = [
    "FETCH_RUN_STATUSES",
    "LISTING_KINDS",
    "LISTING_SOURCES",
    "NAMING_CONVENTION",
    "OVERRIDE_ACTIONS",
    "REVIEW_REASONS",
    "REVIEW_STATUSES",
    "STORE_SOURCES",
    "UNITS",
    "chain",
    "classification",
    "classification_override",
    "deal",
    "fetch_run",
    "listing",
    "matcher_release",
    "metadata",
    "product",
    "product_reference_price",
    "raw_object",
    "review_item",
    "store",
]
