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

/** The `/soeg` URL of a query. */
export function searchHref(query: string): string {
  const q = parseSearchQuery(query);
  return q ? `/soeg?${new URLSearchParams({ q }).toString()}` : "/soeg";
}
