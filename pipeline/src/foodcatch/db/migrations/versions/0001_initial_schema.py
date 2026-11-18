"""Initial schema: tables, seed data, `api` views and the `web_readonly` role.

Revision ID: 0001
Revises:
Create Date: 2026-11-18

Creates every table of architecture §5, seeds `chain` and the first `matcher_release`, creates
the read-only web contract (schema `api`, architecture §7) and grants it to the NOLOGIN role
`web_readonly`. The role is cluster-wide and therefore not dropped on downgrade.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

WEB_ROLE = "web_readonly"
INITIAL_MATCHER_VERSION = "2026.11.1"

# (id, display name, Tjek dealer id, Salling brand)
CHAINS: list[tuple[str, str, str | None, str | None]] = [
    ("netto", "Netto", "9ba51", "netto"),
    ("rema1000", "REMA 1000", "11deC", None),
    ("lidl", "Lidl", "71c90", None),
    ("foetex", "føtex", "bdf5A", "foetex"),
    ("bilka", "Bilka", "93f13", "bilka"),
    ("365discount", "365discount", "DWZE1w", None),
    ("superbrugsen", "SuperBrugsen", "0b1e8", None),
    ("kvickly", "Kvickly", "c1edq", None),
    ("meny", "MENY", "267e1m", None),
    ("loevbjerg", "Løvbjerg", "65caN", None),
    ("spar", "SPAR", "88ddE", None),
]

# Classifications produced by the current matcher release.
_CURRENT_CLASSIFICATION = """
    public.classification c
    JOIN public.matcher_release mr ON mr.version = c.matcher_version AND mr.is_current
"""

API_VIEWS: dict[str, str] = {
    "stores": """
        SELECT s.id, s.chain_id, ch.name AS chain_name, s.name, s.street, s.zip, s.city,
               s.lat, s.lon
        FROM public.store s
        JOIN public.chain ch ON ch.id = s.chain_id
        WHERE s.lat IS NOT NULL AND s.lon IS NOT NULL
    """,
    "current_netto_deals": f"""
        SELECT l.id AS listing_id, c.variant_index, l.title, l.description, l.price, l.unit,
               l.unit_price_min, l.unit_price_max, l.valid_from, l.valid_to,
               c.type_id, c.type_label, c.group_name, c.class_key, c.class_label, c.attrs,
               c.is_exact, c.notes,
               d.price_applies, d.netto_unit_price_worst, d.netto_unit_price_best,
               COALESCE(d."references", '[]'::jsonb) AS "references"
        FROM public.listing l
        JOIN {_CURRENT_CLASSIFICATION} ON c.listing_id = l.id
        LEFT JOIN public.deal d
               ON d.listing_id = c.listing_id
              AND d.variant_index = c.variant_index
              AND d.matcher_version = c.matcher_version
        WHERE l.chain_id = 'netto'
          AND l.kind = 'offer'
          AND c.is_healthy
          AND (l.valid_to IS NULL OR l.valid_to >= now())
    """,
    # Clearances seen by the latest finished food-waste run (sold-out items disappear).
    "food_waste_near": f"""
        SELECT DISTINCT ON (l.id)
               l.id AS listing_id, l.store_id, l.chain_id, s.name AS store_name, s.street,
               s.zip, s.city, s.lat, s.lon, l.title, p.ean, l.price, l.reference_price,
               CASE WHEN l.reference_price > 0
                    THEN round((1 - l.price / l.reference_price) * 100, 1)
               END AS discount_pct,
               l.unit, l.unit_price_min AS unit_price, l.valid_to,
               CASE WHEN jsonb_typeof(l.extra -> 'stock') = 'number'
                    THEN (l.extra ->> 'stock')::numeric
               END AS stock,
               l.extra ->> 'stock_unit' AS stock_unit,
               c.type_label, c.class_label, c.is_exact
        FROM public.listing l
        JOIN public.store s ON s.id = l.store_id
        LEFT JOIN public.product p ON p.id = l.product_id
        JOIN {_CURRENT_CLASSIFICATION} ON c.listing_id = l.id
        WHERE l.source = 'salling_food_waste'
          AND l.kind = 'clearance'
          AND c.is_healthy
          AND (l.valid_to IS NULL OR l.valid_to >= now())
          AND l.last_seen_at >= COALESCE(
                (SELECT max(r.started_at) FROM public.fetch_run r
                  WHERE r.job = 'salling-food-waste'
                    AND r.status IN ('succeeded', 'degraded')),
                '-infinity'::timestamptz)
        ORDER BY l.id, c.variant_index
    """,
    "class_price_history": f"""
        SELECT c.class_key, c.class_label, l.kind, l.chain_id, ch.name AS chain_name,
               l.id AS listing_id, l.title, l.unit, l.unit_price_min, l.unit_price_max,
               l.valid_from, l.valid_to
        FROM public.listing l
        JOIN public.chain ch ON ch.id = l.chain_id
        JOIN {_CURRENT_CLASSIFICATION} ON c.listing_id = l.id
    """,
    "pipeline_status": """
        SELECT DISTINCT ON (r.job) r.job, r.status, r.started_at, r.finished_at, r.stats, r.error
        FROM public.fetch_run r
        ORDER BY r.job, r.started_at DESC
    """,
    "review_queue_summary": """
        SELECT r.reason, count(*)::integer AS open_count
        FROM public.review_item r
        WHERE r.status = 'open'
        GROUP BY r.reason
    """,
}


def _create_web_contract() -> None:
    op.execute("CREATE SCHEMA api")
    for name, query in API_VIEWS.items():
        op.execute(f"CREATE VIEW api.{name} AS {query}")
    # CREATE ROLE is cluster-wide: tolerate a concurrent creator (parallel test databases).
    op.execute(
        f"""
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '{WEB_ROLE}') THEN
                CREATE ROLE {WEB_ROLE} NOLOGIN;
            END IF;
        EXCEPTION WHEN duplicate_object OR unique_violation THEN
            NULL;
        END
        $$
        """
    )
    op.execute(f"GRANT USAGE ON SCHEMA api TO {WEB_ROLE}")
    op.execute(f"GRANT SELECT ON ALL TABLES IN SCHEMA api TO {WEB_ROLE}")
    op.execute(f"ALTER DEFAULT PRIVILEGES IN SCHEMA api GRANT SELECT ON TABLES TO {WEB_ROLE}")


def _drop_web_contract() -> None:
    op.execute(
        f"""
        DO $$
        BEGIN
            IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '{WEB_ROLE}') THEN
                ALTER DEFAULT PRIVILEGES IN SCHEMA api REVOKE SELECT ON TABLES FROM {WEB_ROLE};
                REVOKE ALL ON SCHEMA api FROM {WEB_ROLE};
            END IF;
        END
        $$
        """
    )
    op.execute("DROP SCHEMA api CASCADE")


def _seed() -> None:
    chain = sa.table(
        "chain",
        sa.column("id", sa.Text),
        sa.column("name", sa.Text),
        sa.column("tjek_dealer_id", sa.Text),
        sa.column("salling_brand", sa.Text),
    )
    op.bulk_insert(
        chain,
        [{"id": i, "name": n, "tjek_dealer_id": t, "salling_brand": b} for i, n, t, b in CHAINS],
    )
    matcher_release = sa.table(
        "matcher_release", sa.column("version", sa.Text), sa.column("is_current", sa.Boolean)
    )
    op.bulk_insert(matcher_release, [{"version": INITIAL_MATCHER_VERSION, "is_current": True}])


def upgrade() -> None:
    op.create_table(
        "chain",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("tjek_dealer_id", sa.Text(), nullable=True),
        sa.Column("salling_brand", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_chain")),
        sa.UniqueConstraint("salling_brand", name=op.f("uq_chain_salling_brand")),
        sa.UniqueConstraint("tjek_dealer_id", name=op.f("uq_chain_tjek_dealer_id")),
    )
    op.create_table(
        "classification_override",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("match_title_normalized", sa.Text(), nullable=False),
        sa.Column("action", sa.Text(), nullable=False),
        sa.Column("forced_result", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "action <> 'force' OR forced_result IS NOT NULL",
            name=op.f("ck_classification_override_force_has_result"),
        ),
        sa.CheckConstraint(
            "action IN ('reject', 'force')", name=op.f("ck_classification_override_action")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_classification_override")),
        sa.UniqueConstraint(
            "source",
            "match_title_normalized",
            name=op.f("uq_classification_override_source_match_title_normalized"),
        ),
    )
    op.create_table(
        "fetch_run",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("job", sa.Text(), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), server_default="running", nullable=False),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("git_sha", sa.Text(), nullable=True),
        sa.Column(
            "stats",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("error", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "status IN ('running', 'succeeded', 'degraded', 'failed')",
            name=op.f("ck_fetch_run_status"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_fetch_run")),
    )
    op.create_index(
        op.f("ix_fetch_run_job_started_at"), "fetch_run", ["job", "started_at"], unique=False
    )
    op.create_table(
        "matcher_release",
        sa.Column("version", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("is_current", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.PrimaryKeyConstraint("version", name=op.f("pk_matcher_release")),
    )
    op.create_index(
        "uq_matcher_release_is_current",
        "matcher_release",
        ["is_current"],
        unique=True,
        postgresql_where=sa.text("is_current"),
    )
    op.create_table(
        "product",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("ean", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=True),
        sa.Column("brand", sa.Text(), nullable=True),
        sa.Column("source_category", sa.Text(), nullable=True),
        sa.Column("quantity_text", sa.Text(), nullable=True),
        sa.Column("net_quantity", sa.Numeric(), nullable=True),
        sa.Column("net_unit", sa.Text(), nullable=True),
        sa.Column("nova_group", sa.SmallInteger(), nullable=True),
        sa.Column("nutriscore_grade", sa.Text(), nullable=True),
        sa.Column("off_checked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "first_seen_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "net_unit IS NULL OR net_unit IN ('kg', 'l', 'stk')", name=op.f("ck_product_net_unit")
        ),
        sa.CheckConstraint(
            "nutriscore_grade IS NULL OR nutriscore_grade IN ('a', 'b', 'c', 'd', 'e')",
            name=op.f("ck_product_nutriscore_grade"),
        ),
        sa.CheckConstraint(
            "nova_group IS NULL OR nova_group BETWEEN 1 AND 4", name=op.f("ck_product_nova_group")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_product")),
        sa.UniqueConstraint("ean", name=op.f("uq_product_ean")),
    )
    op.create_table(
        "product_reference_price",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("product_id", sa.UUID(), nullable=False),
        sa.Column("chain_id", sa.Text(), nullable=False),
        sa.Column("price", sa.Numeric(precision=10, scale=2), nullable=False),
        sa.Column(
            "first_seen_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("observations", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.CheckConstraint(
            "observations >= 1", name=op.f("ck_product_reference_price_observations_positive")
        ),
        sa.CheckConstraint(
            "price >= 0", name=op.f("ck_product_reference_price_price_non_negative")
        ),
        sa.ForeignKeyConstraint(
            ["chain_id"], ["chain.id"], name=op.f("fk_product_reference_price_chain_id_chain")
        ),
        sa.ForeignKeyConstraint(
            ["product_id"],
            ["product.id"],
            name=op.f("fk_product_reference_price_product_id_product"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_product_reference_price")),
        sa.UniqueConstraint(
            "product_id",
            "chain_id",
            "price",
            "first_seen_at",
            name="uq_product_reference_price_observation",
        ),
    )
    op.create_table(
        "raw_object",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("fetch_run_id", sa.UUID(), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("endpoint", sa.Text(), nullable=False),
        sa.Column(
            "params",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("storage_key", sa.Text(), nullable=False),
        sa.Column("sha256", sa.Text(), nullable=False),
        sa.Column("bytes", sa.Integer(), nullable=False),
        sa.Column(
            "fetched_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("bytes >= 0", name=op.f("ck_raw_object_bytes_non_negative")),
        sa.ForeignKeyConstraint(
            ["fetch_run_id"],
            ["fetch_run.id"],
            name=op.f("fk_raw_object_fetch_run_id_fetch_run"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_raw_object")),
        sa.UniqueConstraint("storage_key", name=op.f("uq_raw_object_storage_key")),
    )
    op.create_index(
        op.f("ix_raw_object_fetch_run_id"), "raw_object", ["fetch_run_id"], unique=False
    )
    op.create_index(
        op.f("ix_raw_object_source_fetched_at"),
        "raw_object",
        ["source", "fetched_at"],
        unique=False,
    )
    op.create_table(
        "store",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("chain_id", sa.Text(), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("source_store_id", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=True),
        sa.Column("street", sa.Text(), nullable=True),
        sa.Column("zip", sa.Text(), nullable=True),
        sa.Column("city", sa.Text(), nullable=True),
        sa.Column("lat", sa.Double, nullable=True),
        sa.Column("lon", sa.Double, nullable=True),
        sa.Column(
            "first_seen_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("source IN ('salling', 'tjek')", name=op.f("ck_store_source")),
        sa.CheckConstraint(
            "lat IS NULL OR lat BETWEEN -90 AND 90", name=op.f("ck_store_lat_range")
        ),
        sa.CheckConstraint(
            "lon IS NULL OR lon BETWEEN -180 AND 180", name=op.f("ck_store_lon_range")
        ),
        sa.ForeignKeyConstraint(["chain_id"], ["chain.id"], name=op.f("fk_store_chain_id_chain")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_store")),
        sa.UniqueConstraint(
            "source", "source_store_id", name=op.f("uq_store_source_source_store_id")
        ),
    )
    op.create_index(op.f("ix_store_chain_id"), "store", ["chain_id"], unique=False)
    op.create_table(
        "listing",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("source_item_id", sa.Text(), nullable=False),
        sa.Column("chain_id", sa.Text(), nullable=False),
        sa.Column("store_id", sa.UUID(), nullable=True),
        sa.Column("catalog_id", sa.Text(), nullable=True),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), server_default="", nullable=False),
        sa.Column("product_id", sa.UUID(), nullable=True),
        sa.Column("price", sa.Numeric(precision=10, scale=2), nullable=False),
        sa.Column("reference_price", sa.Numeric(precision=10, scale=2), nullable=True),
        sa.Column("unit", sa.Text(), nullable=True),
        sa.Column("size_min", sa.Numeric(), nullable=True),
        sa.Column("size_max", sa.Numeric(), nullable=True),
        sa.Column("unit_price_min", sa.Numeric(precision=12, scale=4), nullable=True),
        sa.Column("unit_price_max", sa.Numeric(precision=12, scale=4), nullable=True),
        sa.Column("member_only", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("max_per_customer", sa.Integer(), nullable=True),
        sa.Column("valid_from", sa.DateTime(timezone=True), nullable=False),
        sa.Column("valid_to", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "first_seen_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("raw_object_id", sa.UUID(), nullable=False),
        sa.Column(
            "extra",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "kind IN ('offer', 'regular', 'clearance')", name=op.f("ck_listing_kind")
        ),
        sa.CheckConstraint(
            "source <> 'salling_food_waste' OR store_id IS NOT NULL",
            name=op.f("ck_listing_food_waste_has_store"),
        ),
        sa.CheckConstraint(
            "source IN ('tjek', 'rema', 'salling_food_waste')", name=op.f("ck_listing_source")
        ),
        sa.CheckConstraint(
            "unit IS NULL OR unit IN ('kg', 'l', 'stk')", name=op.f("ck_listing_unit")
        ),
        sa.CheckConstraint("price >= 0", name=op.f("ck_listing_price_non_negative")),
        sa.CheckConstraint(
            "size_min IS NULL OR size_max IS NULL OR size_min <= size_max",
            name=op.f("ck_listing_size_range"),
        ),
        sa.CheckConstraint(
            "unit_price_min IS NULL OR unit_price_max IS NULL OR unit_price_min <= unit_price_max",
            name=op.f("ck_listing_unit_price_range"),
        ),
        sa.CheckConstraint(
            "valid_to IS NULL OR valid_to >= valid_from", name=op.f("ck_listing_validity_range")
        ),
        sa.ForeignKeyConstraint(["chain_id"], ["chain.id"], name=op.f("fk_listing_chain_id_chain")),
        sa.ForeignKeyConstraint(
            ["product_id"], ["product.id"], name=op.f("fk_listing_product_id_product")
        ),
        sa.ForeignKeyConstraint(
            ["raw_object_id"],
            ["raw_object.id"],
            name=op.f("fk_listing_raw_object_id_raw_object"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(["store_id"], ["store.id"], name=op.f("fk_listing_store_id_store")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_listing")),
        sa.UniqueConstraint(
            "source",
            "source_item_id",
            "valid_from",
            "price",
            name=op.f("uq_listing_source_source_item_id_valid_from_price"),
        ),
    )
    op.create_index(
        op.f("ix_listing_chain_id_kind_valid_to"),
        "listing",
        ["chain_id", "kind", "valid_to"],
        unique=False,
    )
    op.create_index(op.f("ix_listing_product_id"), "listing", ["product_id"], unique=False)
    op.create_index(op.f("ix_listing_raw_object_id"), "listing", ["raw_object_id"], unique=False)
    op.create_index(op.f("ix_listing_store_id"), "listing", ["store_id"], unique=False)
    op.create_table(
        "classification",
        sa.Column("listing_id", sa.UUID(), nullable=False),
        sa.Column("matcher_version", sa.Text(), nullable=False),
        sa.Column("variant_index", sa.SmallInteger(), nullable=False),
        sa.Column("type_id", sa.Text(), nullable=False),
        sa.Column("type_label", sa.Text(), nullable=False),
        sa.Column("group_name", sa.Text(), nullable=False),
        sa.Column(
            "attrs",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("class_key", sa.Text(), nullable=False),
        sa.Column("class_label", sa.Text(), nullable=False),
        sa.Column("is_exact", sa.Boolean(), nullable=False),
        sa.Column("is_healthy", sa.Boolean(), nullable=False),
        sa.Column("offer_variants", sa.SmallInteger(), server_default=sa.text("1"), nullable=False),
        sa.Column(
            "same_class_variants", sa.SmallInteger(), server_default=sa.text("1"), nullable=False
        ),
        sa.Column(
            "notes",
            postgresql.ARRAY(sa.Text()),
            server_default=sa.text("'{}'::text[]"),
            nullable=False,
        ),
        sa.Column("source_hint", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "same_class_variants >= 1 AND same_class_variants <= offer_variants",
            name=op.f("ck_classification_variant_counts"),
        ),
        sa.CheckConstraint(
            "variant_index >= 0", name=op.f("ck_classification_variant_index_non_negative")
        ),
        sa.ForeignKeyConstraint(
            ["listing_id"],
            ["listing.id"],
            name=op.f("fk_classification_listing_id_listing"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["matcher_version"],
            ["matcher_release.version"],
            name=op.f("fk_classification_matcher_version_matcher_release"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint(
            "listing_id", "matcher_version", "variant_index", name=op.f("pk_classification")
        ),
    )
    op.create_index(
        op.f("ix_classification_matcher_version_class_key"),
        "classification",
        ["matcher_version", "class_key"],
        unique=False,
    )
    op.create_table(
        "review_item",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("listing_id", sa.UUID(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), server_default="open", nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "reason IN ('unrecognized_staple_word', 'unknown_key_attribute', 'ambiguous_offer')",
            name=op.f("ck_review_item_reason"),
        ),
        sa.CheckConstraint(
            "status IN ('open', 'accepted', 'rejected', 'fixed')",
            name=op.f("ck_review_item_status"),
        ),
        sa.ForeignKeyConstraint(
            ["listing_id"],
            ["listing.id"],
            name=op.f("fk_review_item_listing_id_listing"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_review_item")),
        sa.UniqueConstraint("listing_id", "reason", name=op.f("uq_review_item_listing_id_reason")),
    )
    op.create_index(
        op.f("ix_review_item_status_reason"), "review_item", ["status", "reason"], unique=False
    )
    op.create_table(
        "deal",
        sa.Column("listing_id", sa.UUID(), nullable=False),
        sa.Column("variant_index", sa.SmallInteger(), nullable=False),
        sa.Column("matcher_version", sa.Text(), nullable=False),
        sa.Column("class_key", sa.Text(), nullable=False),
        sa.Column("netto_unit_price_worst", sa.Numeric(precision=12, scale=4), nullable=True),
        sa.Column("netto_unit_price_best", sa.Numeric(precision=12, scale=4), nullable=True),
        sa.Column("price_applies", sa.Boolean(), nullable=False),
        sa.Column(
            "references",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "computed_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "jsonb_typeof(\"references\") = 'array'", name=op.f("ck_deal_references_is_array")
        ),
        sa.CheckConstraint(
            "netto_unit_price_best IS NULL OR netto_unit_price_worst IS NULL"
            " OR netto_unit_price_best <= netto_unit_price_worst",
            name=op.f("ck_deal_unit_price_order"),
        ),
        sa.ForeignKeyConstraint(
            ["listing_id", "matcher_version", "variant_index"],
            [
                "classification.listing_id",
                "classification.matcher_version",
                "classification.variant_index",
            ],
            name="fk_deal_classification",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["matcher_version"],
            ["matcher_release.version"],
            name=op.f("fk_deal_matcher_version_matcher_release"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint(
            "listing_id", "variant_index", "matcher_version", name=op.f("pk_deal")
        ),
    )
    op.create_index(
        op.f("ix_deal_matcher_version_class_key"),
        "deal",
        ["matcher_version", "class_key"],
        unique=False,
    )
    _seed()
    _create_web_contract()


def downgrade() -> None:
    _drop_web_contract()
    op.drop_index(op.f("ix_deal_matcher_version_class_key"), table_name="deal")
    op.drop_table("deal")
    op.drop_index(op.f("ix_review_item_status_reason"), table_name="review_item")
    op.drop_table("review_item")
    op.drop_index(op.f("ix_classification_matcher_version_class_key"), table_name="classification")
    op.drop_table("classification")
    op.drop_index(op.f("ix_listing_store_id"), table_name="listing")
    op.drop_index(op.f("ix_listing_raw_object_id"), table_name="listing")
    op.drop_index(op.f("ix_listing_product_id"), table_name="listing")
    op.drop_index(op.f("ix_listing_chain_id_kind_valid_to"), table_name="listing")
    op.drop_table("listing")
    op.drop_index(op.f("ix_store_chain_id"), table_name="store")
    op.drop_table("store")
    op.drop_index(op.f("ix_raw_object_source_fetched_at"), table_name="raw_object")
    op.drop_index(op.f("ix_raw_object_fetch_run_id"), table_name="raw_object")
    op.drop_table("raw_object")
    op.drop_table("product_reference_price")
    op.drop_table("product")
    op.drop_index(
        "uq_matcher_release_is_current",
        table_name="matcher_release",
        postgresql_where=sa.text("is_current"),
    )
    op.drop_table("matcher_release")
    op.drop_index(op.f("ix_fetch_run_job_started_at"), table_name="fetch_run")
    op.drop_table("fetch_run")
    op.drop_table("classification_override")
    op.drop_table("chain")
