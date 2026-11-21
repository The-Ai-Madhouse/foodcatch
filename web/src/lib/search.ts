/**
 * Item search ("Søg vare", docs/ui.md §16): the query a user types becomes up to
 * {@link MAX_TERMS} words that must all occur in an item's name (case-insensitive substrings,
 * as SQL `ILIKE` patterns). Hits are items (`api.products`, one per product key) whose price
 * history the user can open. Pure and unit tested.
 */

import type { ProductInfo } from "./product";

/** A query shorter than this (after trimming) is not searched. */
export const MIN_QUERY_LENGTH = 2;
/** Longer queries are cut. */
export const MAX_QUERY_LENGTH = 60;
/** At most this many words are matched. */
export const MAX_TERMS = 5;
/** At most this many items are shown. */
export const MAX_RESULTS = 60;

/** The `q` search parameter as a clean query: one line, single spaces, at most 60 characters. */
export function parseSearchQuery(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return (raw ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH).trim();
}

/** The words of a query (lower case, distinct, at most {@link MAX_TERMS}); empty when too short. */
export function searchTerms(query: string): string[] {
  if (query.length < MIN_QUERY_LENGTH) return [];
  const words = query
    .toLocaleLowerCase("da-DK")
    .split(" ")
    .map((w) => w.trim())
    .filter(Boolean);
  return [...new Set(words)].slice(0, MAX_TERMS);
}

/** An `ILIKE` pattern matching `term` anywhere, with `\`, `%` and `_` escaped. */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** One search hit: the item and how many prices its history holds. */
export interface SearchHit extends ProductInfo {
  latestKind: string | null;
  latestUnitPriceMin: number | null;
  latestUnitPriceMax: number | null;
  priceCount: number;
  /** Source ids of the latest price, for the link to where it comes from (search only). */
  latestSourceItemId?: string | null;
  latestCatalogId?: string | null;
}

/** Whether the item's latest price applies now or later (not only in the past). */
export function isCurrent(hit: Pick<SearchHit, "latestValidTo">, now: Date): boolean {
  return hit.latestValidTo == null || Date.parse(hit.latestValidTo) >= now.getTime();
}

/**
 * Hits in display order: items with a current price first, then the most recently priced, then
 * by name.
 */
export function sortHits<T extends SearchHit>(hits: readonly T[], now: Date): T[] {
  const started = (h: T) => (h.latestValidFrom ? Date.parse(h.latestValidFrom) : 0);
  return [...hits].sort(
    (a, b) =>
      Number(isCurrent(b, now)) - Number(isCurrent(a, now)) ||
      started(b) - started(a) ||
      a.label.localeCompare(b.label, "da-DK"),
  );
}

/** When a hit's latest price applies: now, later (an upcoming offer) or only in the past. */
export type HitTiming = "now" | "later" | "past";

export function hitTiming(
  hit: Pick<SearchHit, "latestValidFrom" | "latestValidTo">,
  now: Date,
): HitTiming {
  if (!isCurrent(hit, now)) return "past";
  if (hit.latestValidFrom && Date.parse(hit.latestValidFrom) > now.getTime()) return "later";
  return "now";
}

/** A hit's comparable unit price (the cheapest pack's), or null. */
export function hitUnitPrice(hit: Pick<SearchHit, "latestUnitPriceMin" | "latestUnitPriceMax">) {
  return hit.latestUnitPriceMin ?? hit.latestUnitPriceMax ?? null;
}

/** The most common unit among hits with a unit price (ties: kg, l, stk), or null. */
export function commonUnit(
  hits: readonly Pick<SearchHit, "latestUnit" | "latestUnitPriceMin" | "latestUnitPriceMax">[],
): string | null {
  const counts = new Map<string, number>();
  for (const h of hits) {
    if (h.latestUnit && hitUnitPrice(h) != null) {
      counts.set(h.latestUnit, (counts.get(h.latestUnit) ?? 0) + 1);
    }
  }
  const order = ["kg", "l", "stk"];
  return (
    [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]),
    )[0]?.[0] ?? null
  );
}

/**
 * Where an item is cheapest (docs/ui.md §21): hits priced now, those in `unit` by unit price,
 * cheapest first; chains with a store near the user before the others; hits in another unit
 * or without a unit price last (they cannot be compared).
 */
export function cheapestFirst<T extends SearchHit>(
  hits: readonly T[],
  unit: string | null,
  nearbyChains: ReadonlySet<string>,
): T[] {
  const comparable = (h: T) => (unit != null && h.latestUnit === unit ? hitUnitPrice(h) : null);
  return [...hits].sort((a, b) => {
    const ua = comparable(a);
    const ub = comparable(b);
    return (
      Number(nearbyChains.has(b.chainId)) - Number(nearbyChains.has(a.chainId)) ||
      Number(ua == null) - Number(ub == null) ||
      (ua ?? 0) - (ub ?? 0) ||
      (a.latestPrice ?? Infinity) - (b.latestPrice ?? Infinity) ||
      a.label.localeCompare(b.label, "da-DK")
    );
  });
}

/** Hits of exactly the same kind of item (one class), cheapest first. */
export interface HitGroup<T extends SearchHit> {
  key: string;
  /** The class label ("Hakket oksekød, 8-12%"), or the item's name when it has no exact class. */
  label: string;
  /** The unit the hits are compared in, or null. */
  unit: string | null;
  hits: T[];
  /** Whether the first hit is the cheapest comparable price at a chain near the user. */
  cheapestNearby: boolean;
}

/**
 * Hits grouped by exact class, so "cheapest" only ever compares the same item (hakket grisekød
 * is never "cheaper" than hakket oksekød). Items without an exact class are compared by name.
 * Groups with a comparable nearby price first, then the bigger groups.
 */
export function groupHits<T extends SearchHit>(
  hits: readonly T[],
  nearbyChains: ReadonlySet<string>,
): HitGroup<T>[] {
  const byKey = new Map<string, { label: string; hits: T[] }>();
  for (const h of hits) {
    const exact = h.isExact === true && h.classKey;
    const key = exact ? `c:${h.classKey}` : `n:${h.label.trim().toLocaleLowerCase("da-DK")}`;
    const label = exact && h.classLabel ? h.classLabel : h.label;
    const group = byKey.get(key);
    if (group) group.hits.push(h);
    else byKey.set(key, { label, hits: [h] });
  }
  return [...byKey.entries()]
    .map(([key, g]) => {
      const unit = commonUnit(g.hits);
      const sorted = cheapestFirst(g.hits, unit, nearbyChains);
      const first = sorted[0];
      const cheapestNearby = Boolean(
        sorted.length > 1 &&
        first &&
        nearbyChains.has(first.chainId) &&
        unit != null &&
        first.latestUnit === unit &&
        hitUnitPrice(first) != null,
      );
      return { key, label: g.label, unit, hits: sorted, cheapestNearby };
    })
    .sort(
      (a, b) =>
        Number(b.cheapestNearby) - Number(a.cheapestNearby) ||
        b.hits.length - a.hits.length ||
        a.label.localeCompare(b.label, "da-DK"),
    );
}

/** The `/soeg` URL of a query. */
export function searchHref(query: string): string {
  const q = parseSearchQuery(query);
  return q ? `/soeg?${new URLSearchParams({ q }).toString()}` : "/soeg";
}
