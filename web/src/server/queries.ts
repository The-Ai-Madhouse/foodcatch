import "server-only";

import { connection } from "next/server";
import type { DealRow } from "@/lib/deals";
import { parseReferences } from "@/lib/deals";
import { EARTH_RADIUS_KM, boundingBox, type Coordinates } from "@/lib/geo";
import type { FoodWasteItem } from "@/lib/foodwaste";
import type { PriceHistoryRow } from "@/lib/history";
import type { ProductHistoryRow, ProductInfo } from "@/lib/product";
import type { PipelineRun } from "@/lib/status";
import type { ReferenceDetail } from "@/lib/deals";
import { dedupeStores, type NearbyStore } from "@/lib/stores";
import { db, readOnlyDb } from "./db";

/**
 * Typed queries against the read-only web contract (schema `api`, architecture §7).
 *
 * Numeric columns are cast to float8 in SQL (postgres returns `numeric` as strings) and
 * timestamps are returned as ISO strings. Every query waits for a request (`connection()`), so
 * nothing is read from the database at build time.
 */

export interface SearchArea extends Coordinates {
  radiusKm: number;
}

export interface ReviewQueueEntry {
  reason: string;
  openCount: number;
}

const toIso = (value: Date | string | null): string | null =>
  value == null ? null : value instanceof Date ? value.toISOString() : value;

const toIsoRequired = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : value;

/** Great-circle distance (km) from a point to the row's `lat`/`lon`, as a SQL fragment. */
function distanceKm(center: Coordinates) {
  const sql = db();
  return sql`(2 * ${EARTH_RADIUS_KM}::float8 * asin(least(1.0, sqrt(
      power(sin(radians(lat - ${center.lat}::float8) / 2), 2)
      + cos(radians(${center.lat}::float8)) * cos(radians(lat))
        * power(sin(radians(lon - ${center.lon}::float8) / 2), 2)))))`;
}

/** Bounding-box pre-filter on `lat`/`lon` (cheap) before the exact distance. */
function withinBox(area: SearchArea) {
  const sql = db();
  const box = boundingBox(area, area.radiusKm);
  return sql`lat BETWEEN ${box.minLat}::float8 AND ${box.maxLat}::float8
    AND lon BETWEEN ${box.minLon}::float8 AND ${box.maxLon}::float8`;
}

interface StoreSqlRow {
  id: string;
  chainId: string;
  chainName: string;
  name: string;
  street: string | null;
  zip: string | null;
  city: string | null;
  lat: number;
  lon: number;
  source: string | null;
  sourceStoreId: string | null;
  distanceKm: number;
}

/**
 * Stores within the radius, one row per physical store (Salling rows for Netto, føtex and
 * Bilka, Tjek rows otherwise; docs/ui.md §5.5), nearest first.
 */
export async function getNearbyStores(area: SearchArea): Promise<NearbyStore[]> {
  await connection();
  const sql = await readOnlyDb();
  const rows = await sql<StoreSqlRow[]>`
    SELECT * FROM (
      SELECT id::text AS id, chain_id AS "chainId", chain_name AS "chainName", name, street, zip,
             city, lat::float8 AS lat, lon::float8 AS lon, source,
             source_store_id AS "sourceStoreId", ${distanceKm(area)}::float8 AS "distanceKm"
      FROM api.stores
      WHERE ${withinBox(area)}
    ) s
    WHERE "distanceKm" <= ${area.radiusKm}::float8
    ORDER BY "distanceKm", name
  `;
  return dedupeStores(rows.map((r) => ({ ...r })));
}

/** The nearest store of a chain regardless of the radius (for "nearest is 6.3 km away"). */
export async function getNearestStore(
  center: Coordinates,
  chainId: string,
): Promise<NearbyStore | null> {
  await connection();
  const sql = await readOnlyDb();
  const rows = await sql<StoreSqlRow[]>`
    SELECT id::text AS id, chain_id AS "chainId", chain_name AS "chainName", name, street, zip,
           city, lat::float8 AS lat, lon::float8 AS lon, source,
           source_store_id AS "sourceStoreId", ${distanceKm(center)}::float8 AS "distanceKm"
    FROM api.stores
    WHERE chain_id = ${chainId}
    ORDER BY "distanceKm", name
    LIMIT 1
  `;
  const row = rows[0];
  return row ? { ...row } : null;
}

/** Stores by id (e.g. the stores of food-waste rows in a price history), with no distance. */
export async function getStoresByIds(ids: readonly string[]): Promise<Map<string, NearbyStore>> {
  if (ids.length === 0) return new Map();
  await connection();
  const sql = await readOnlyDb();
  const rows = await sql<StoreSqlRow[]>`
    SELECT id::text AS id, chain_id AS "chainId", chain_name AS "chainName", name, street, zip,
           city, lat::float8 AS lat, lon::float8 AS lon, source,
           source_store_id AS "sourceStoreId", 0::float8 AS "distanceKm"
    FROM api.stores
    WHERE id = ANY(${[...new Set(ids)]}::uuid[])
  `;
  return new Map(rows.map((r) => [r.id, { ...r }]));
}

interface DealSqlRow {
  listingId: string;
  variantIndex: number;
  chainId: string;
  chainName: string;
  title: string;
  description: string | null;
  price: number;
  unit: string | null;
  unitPriceMin: number | null;
  unitPriceMax: number | null;
  validFrom: Date;
  validTo: Date | null;
  typeId: string;
  typeLabel: string;
  groupName: string;
  classKey: string;
  classLabel: string;
  isExact: boolean;
  notes: string[] | null;
  priceApplies: boolean | null;
  targetUnitPriceWorst: number | null;
  targetUnitPriceBest: number | null;
  references: unknown;
  memberOnly: boolean;
  source: string | null;
  sourceItemId: string | null;
  catalogId: string | null;
  sizeMin: number | null;
  sizeMax: number | null;
  maxPerCustomer: number | null;
  productKey: string | null;
}

/**
 * Current and upcoming offers of healthy staples of every chain (one row per recognized
 * variant), optionally of one chain only.
 */
export async function getCurrentDeals(chainId?: string): Promise<DealRow[]> {
  await connection();
  const sql = await readOnlyDb();
  const rows = await sql<DealSqlRow[]>`
    SELECT listing_id::text AS "listingId", variant_index::int AS "variantIndex",
           chain_id AS "chainId", chain_name AS "chainName", title, description,
           price::float8 AS price, unit,
           unit_price_min::float8 AS "unitPriceMin", unit_price_max::float8 AS "unitPriceMax",
           valid_from AS "validFrom", valid_to AS "validTo",
           type_id AS "typeId", type_label AS "typeLabel", group_name AS "groupName",
           class_key AS "classKey", class_label AS "classLabel", is_exact AS "isExact", notes,
           price_applies AS "priceApplies",
           target_unit_price_worst::float8 AS "targetUnitPriceWorst",
           target_unit_price_best::float8 AS "targetUnitPriceBest",
           "references", member_only AS "memberOnly", source,
           source_item_id AS "sourceItemId", catalog_id AS "catalogId",
           size_min::float8 AS "sizeMin", size_max::float8 AS "sizeMax",
           max_per_customer::int AS "maxPerCustomer", product_key AS "productKey"
    FROM api.current_deals
    ${chainId ? sql`WHERE chain_id = ${chainId}` : sql``}
    ORDER BY valid_from, title, variant_index
  `;
  return rows.map((r) => ({
    listingId: r.listingId,
    variantIndex: r.variantIndex,
    chainId: r.chainId,
    chainName: r.chainName,
    title: r.title,
    description: r.description ?? "",
    price: r.price,
    unit: r.unit,
    unitPriceMin: r.unitPriceMin,
    unitPriceMax: r.unitPriceMax,
    validFrom: toIsoRequired(r.validFrom),
    validTo: toIso(r.validTo),
    typeId: r.typeId,
    typeLabel: r.typeLabel,
    groupName: r.groupName,
    classKey: r.classKey,
    classLabel: r.classLabel,
    isExact: r.isExact,
    notes: r.notes ?? [],
    priceApplies: r.priceApplies,
    targetUnitPriceWorst: r.targetUnitPriceWorst,
    targetUnitPriceBest: r.targetUnitPriceBest,
    references: parseReferences(r.references),
    memberOnly: r.memberOnly,
    source: r.source,
    sourceItemId: r.sourceItemId,
    catalogId: r.catalogId,
    sizeMin: r.sizeMin,
    sizeMax: r.sizeMax,
    maxPerCustomer: r.maxPerCustomer,
    productKey: r.productKey,
  }));
}

interface FoodWasteSqlRow extends Omit<
  FoodWasteItem,
  "validTo" | "lastSeenAt" | "sourceFetchedAt" | "references"
> {
  validTo: Date | null;
  lastSeenAt: Date | null;
  sourceFetchedAt: Date | null;
  references: unknown;
}

/** Food-waste clearances of healthy staples within the radius, largest discount first. */
export async function getFoodWasteNear(area: SearchArea, limit = 300): Promise<FoodWasteItem[]> {
  await connection();
  const sql = await readOnlyDb();
  const rows = await sql<FoodWasteSqlRow[]>`
    SELECT * FROM (
      SELECT listing_id AS "listingId", store_id AS "storeId", chain_id AS "chainId",
             store_name AS "storeName", street, zip, city,
             ${distanceKm(area)}::float8 AS "distanceKm",
             title, ean, price::float8 AS price, reference_price::float8 AS "referencePrice",
             discount_pct::float8 AS "discountPct", unit, unit_price::float8 AS "unitPrice",
             valid_to AS "validTo", stock::float8 AS stock, stock_unit AS "stockUnit",
             type_label AS "typeLabel", class_label AS "classLabel", is_exact AS "isExact",
             lat::float8 AS lat, lon::float8 AS lon, size::float8 AS size,
             image_url AS "imageUrl", product_quantity_text AS "productQuantityText",
             product_net_quantity::float8 AS "productNetQuantity",
             product_net_unit AS "productNetUnit", last_seen_at AS "lastSeenAt",
             product_key AS "productKey", source_item_id AS "sourceItemId",
             salling_store_id AS "sallingStoreId", source_fetched_at AS "sourceFetchedAt",
             salling_percent_discount::float8 AS "sallingPercentDiscount",
             offer_ean AS "offerEan", product_code AS "productCode", class_key AS "classKey",
             food_waste_references AS "references", beats_competitors AS "beatsCompetitors"
      FROM api.food_waste_near
      WHERE ${withinBox(area)}
    ) f
    WHERE "distanceKm" <= ${area.radiusKm}::float8
    ORDER BY "discountPct" DESC NULLS LAST, "distanceKm", title
    LIMIT ${limit}::int
  `;
  return rows.map((r) => ({
    ...r,
    validTo: toIso(r.validTo),
    lastSeenAt: toIso(r.lastSeenAt),
    sourceFetchedAt: toIso(r.sourceFetchedAt),
    references: parseReferences(r.references),
  }));
}

interface HistorySqlRow extends Omit<PriceHistoryRow, "validFrom" | "validTo"> {
  validFrom: Date;
  validTo: Date | null;
}

/** Every classified listing of one product class, oldest first. */
export async function getClassPriceHistory(classKey: string): Promise<PriceHistoryRow[]> {
  await connection();
  const sql = await readOnlyDb();
  const rows = await sql<HistorySqlRow[]>`
    SELECT class_key AS "classKey", class_label AS "classLabel", kind, chain_id AS "chainId",
           chain_name AS "chainName", listing_id AS "listingId", title, unit,
           unit_price_min::float8 AS "unitPriceMin", unit_price_max::float8 AS "unitPriceMax",
           valid_from AS "validFrom", valid_to AS "validTo", price_applies AS "priceApplies",
           member_only AS "memberOnly", source, source_item_id AS "sourceItemId",
           catalog_id AS "catalogId", store_id::text AS "storeId", price::float8 AS price,
           description, size_min::float8 AS "sizeMin", size_max::float8 AS "sizeMax",
           product_key AS "productKey"
    FROM api.class_price_history
    WHERE class_key = ${classKey}
    ORDER BY valid_from, chain_name, title
  `;
  return rows.map((r) => ({
    ...r,
    validFrom: toIsoRequired(r.validFrom),
    validTo: toIso(r.validTo),
  }));
}

interface ProductHistorySqlRow extends Omit<ProductHistoryRow, "validFrom" | "validTo"> {
  validFrom: Date;
  validTo: Date | null;
}

/** Every price of one item (`api.product_price_history`), oldest first. */
export async function getProductHistory(productKey: string): Promise<ProductHistoryRow[]> {
  await connection();
  const sql = await readOnlyDb();
  const rows = await sql<ProductHistorySqlRow[]>`
    SELECT product_key AS "productKey", product_label AS "productLabel", chain_id AS "chainId",
           kind, price::float8 AS price, unit,
           unit_price_min::float8 AS "unitPriceMin", unit_price_max::float8 AS "unitPriceMax",
           size_min::float8 AS "sizeMin", size_max::float8 AS "sizeMax",
           valid_from AS "validFrom", valid_to AS "validTo", source,
           source_item_id AS "sourceItemId", catalog_id AS "catalogId",
           store_id::text AS "storeId", coalesce(member_only, false) AS "memberOnly",
           listing_id::text AS "listingId", title
    FROM api.product_price_history
    WHERE product_key = ${productKey}
    ORDER BY valid_from, kind, chain_id
  `;
  return rows.map((r) => ({
    ...r,
    validFrom: toIsoRequired(r.validFrom),
    validTo: toIso(r.validTo),
  }));
}

interface ProductSqlRow extends Omit<ProductInfo, "latestValidFrom" | "latestValidTo"> {
  latestValidFrom: Date | null;
  latestValidTo: Date | null;
}

/** One item (`api.products`), or null when the key is unknown. */
export async function getProduct(productKey: string): Promise<ProductInfo | null> {
  await connection();
  const sql = await readOnlyDb();
  const rows = await sql<ProductSqlRow[]>`
    SELECT product_key AS "productKey", label, chain_id AS "chainId", chain_name AS "chainName",
           class_key AS "classKey", class_label AS "classLabel", is_exact AS "isExact", ean,
           latest_source AS "latestSource", latest_price::float8 AS "latestPrice",
           latest_unit AS "latestUnit", latest_size_min::float8 AS "latestSizeMin",
           latest_size_max::float8 AS "latestSizeMax", latest_valid_from AS "latestValidFrom",
           latest_valid_to AS "latestValidTo"
    FROM api.products
    WHERE product_key = ${productKey}
  `;
  const row = rows[0];
  return row
    ? {
        ...row,
        latestValidFrom: toIso(row.latestValidFrom),
        latestValidTo: toIso(row.latestValidTo),
      }
    : null;
}

interface PipelineSqlRow {
  job: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  stats: unknown;
  error: string | null;
}

/** The latest run of every pipeline job. */
export async function getPipelineStatus(): Promise<PipelineRun[]> {
  await connection();
  const sql = await readOnlyDb();
  const rows = await sql<PipelineSqlRow[]>`
    SELECT job, status, started_at AS "startedAt", finished_at AS "finishedAt", stats, error
    FROM api.pipeline_status
    ORDER BY job
  `;
  return rows.map((r) => ({
    job: r.job,
    status: r.status,
    startedAt: toIsoRequired(r.startedAt),
    finishedAt: toIso(r.finishedAt),
    stats:
      typeof r.stats === "object" && r.stats !== null && !Array.isArray(r.stats)
        ? (r.stats as Record<string, unknown>)
        : {},
    error: r.error,
  }));
}

/** The latest run of one pipeline job, or null when it never ran. */
export async function getLatestRun(job: string): Promise<PipelineRun | null> {
  const runs = await getPipelineStatus();
  return runs.find((r) => r.job === job) ?? null;
}

interface ReferenceDetailSqlRow extends Omit<ReferenceDetail, "validTo"> {
  validTo: Date | null;
}

/**
 * Size, pack price and source ids of the listings that deals refer to (`deal.references` carry
 * only unit prices), keyed by listing id.
 */
export async function getReferenceDetails(
  listingIds: readonly string[],
): Promise<Map<string, ReferenceDetail>> {
  const ids = [...new Set(listingIds)];
  if (ids.length === 0) return new Map();
  await connection();
  const sql = await readOnlyDb();
  const rows = await sql<ReferenceDetailSqlRow[]>`
    SELECT DISTINCT ON (listing_id)
           listing_id::text AS "listingId", source, source_item_id AS "sourceItemId",
           catalog_id AS "catalogId", chain_id AS "chainId", price::float8 AS price,
           description, unit, size_min::float8 AS "sizeMin", size_max::float8 AS "sizeMax",
           valid_to AS "validTo", product_key AS "productKey"
    FROM api.class_price_history
    WHERE listing_id = ANY(${ids}::uuid[])
    ORDER BY listing_id
  `;
  return new Map(rows.map((r) => [r.listingId, { ...r, validTo: toIso(r.validTo) }]));
}

/** Open review items per reason. */
export async function getReviewQueueSummary(): Promise<ReviewQueueEntry[]> {
  await connection();
  const sql = await readOnlyDb();
  const rows = await sql<ReviewQueueEntry[]>`
    SELECT reason, open_count::int AS "openCount"
    FROM api.review_queue_summary
    ORDER BY open_count DESC, reason
  `;
  return rows.map((r) => ({ ...r }));
}
