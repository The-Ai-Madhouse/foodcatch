"""The web contract (architecture §7): every column of every `api` view, in order, with its type.

Shared by the contract test (head) and the migration tests (which check each step's columns).
Columns are only ever appended; changing or removing one breaks the web.
"""

from __future__ import annotations

from sqlalchemy import Connection, text

_TS = "timestamp with time zone"

API_COLUMNS: dict[str, list[tuple[str, str]]] = {
    "stores": [
        ("id", "uuid"),
        ("chain_id", "text"),
        ("chain_name", "text"),
        ("name", "text"),
        ("street", "text"),
        ("zip", "text"),
        ("city", "text"),
        ("lat", "double precision"),
        ("lon", "double precision"),
        # added in 0007
        ("source", "text"),
        ("source_store_id", "text"),
    ],
    "current_netto_deals": [
        ("listing_id", "uuid"),
        ("variant_index", "smallint"),
        ("title", "text"),
        ("description", "text"),
        ("price", "numeric"),
        ("unit", "text"),
        ("unit_price_min", "numeric"),
        ("unit_price_max", "numeric"),
        ("valid_from", _TS),
        ("valid_to", _TS),
        ("type_id", "text"),
        ("type_label", "text"),
        ("group_name", "text"),
        ("class_key", "text"),
        ("class_label", "text"),
        ("attrs", "jsonb"),
        ("is_exact", "boolean"),
        ("notes", "ARRAY"),
        ("price_applies", "boolean"),
        ("netto_unit_price_worst", "numeric"),
        ("netto_unit_price_best", "numeric"),
        ("references", "jsonb"),
        ("member_only", "boolean"),
        # added in 0007
        ("source", "text"),
        ("source_item_id", "text"),
        ("catalog_id", "text"),
        ("size_min", "numeric"),
        ("size_max", "numeric"),
        ("max_per_customer", "integer"),
    ],
    "food_waste_near": [
        ("listing_id", "uuid"),
        ("store_id", "uuid"),
        ("chain_id", "text"),
        ("store_name", "text"),
        ("street", "text"),
        ("zip", "text"),
        ("city", "text"),
        ("lat", "double precision"),
        ("lon", "double precision"),
        ("title", "text"),
        ("ean", "text"),
        ("price", "numeric"),
        ("reference_price", "numeric"),
        ("discount_pct", "numeric"),
        ("unit", "text"),
        ("unit_price", "numeric"),
        ("valid_to", _TS),
        ("stock", "numeric"),
        ("stock_unit", "text"),
        ("type_label", "text"),
        ("class_label", "text"),
        ("is_exact", "boolean"),
        # added in 0007
        ("size", "numeric"),
        ("image_url", "text"),
        ("product_quantity_text", "text"),
        ("product_net_quantity", "numeric"),
        ("product_net_unit", "text"),
        ("last_seen_at", _TS),
    ],
    "class_price_history": [
        ("class_key", "text"),
        ("class_label", "text"),
        ("kind", "text"),
        ("chain_id", "text"),
        ("chain_name", "text"),
        ("listing_id", "uuid"),
        ("title", "text"),
        ("unit", "text"),
        ("unit_price_min", "numeric"),
        ("unit_price_max", "numeric"),
        ("valid_from", _TS),
        ("valid_to", _TS),
        ("price_applies", "boolean"),
        ("member_only", "boolean"),
        # added in 0007
        ("source", "text"),
        ("source_item_id", "text"),
        ("catalog_id", "text"),
        ("store_id", "uuid"),
        ("price", "numeric"),
        ("description", "text"),
        ("size_min", "numeric"),
        ("size_max", "numeric"),
    ],
    "pipeline_status": [
        ("job", "text"),
        ("status", "text"),
        ("started_at", _TS),
        ("finished_at", _TS),
        ("stats", "jsonb"),
        ("error", "text"),
    ],
    "review_queue_summary": [("reason", "text"), ("open_count", "integer")],
}


def api_columns(conn: Connection) -> dict[str, list[tuple[str, str]]]:
    """Columns of every `api` view, in order, as ``(name, information_schema data type)``."""
    rows = conn.execute(
        text(
            """
            SELECT table_name, column_name, data_type
            FROM information_schema.columns
            WHERE table_schema = 'api'
            ORDER BY table_name, ordinal_position
            """
        )
    ).all()
    columns: dict[str, list[tuple[str, str]]] = {}
    for view, column, data_type in rows:
        columns.setdefault(view, []).append((column, data_type))
    return columns


# Columns appended by migration 0007 (docs/ui.md §8), per view.
ADDED_IN_0007: dict[str, list[str]] = {
    "stores": ["source", "source_store_id"],
    "current_netto_deals": [
        "source",
        "source_item_id",
        "catalog_id",
        "size_min",
        "size_max",
        "max_per_customer",
    ],
    "food_waste_near": [
        "size",
        "image_url",
        "product_quantity_text",
        "product_net_quantity",
        "product_net_unit",
        "last_seen_at",
    ],
    "class_price_history": [
        "source",
        "source_item_id",
        "catalog_id",
        "store_id",
        "price",
        "description",
        "size_min",
        "size_max",
    ],
}
