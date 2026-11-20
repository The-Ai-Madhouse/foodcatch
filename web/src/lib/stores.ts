/**
 * Stores near the user (docs/ui.md §5.5): deduplication of Salling and Tjek rows of the same
 * physical store, display names, the nearest stores per chain and grouping of food waste by
 * store. Pure and unit tested.
 */

import { chainName } from "./chains";

/** A row of `api.stores` with its distance from the user. */
export interface NearbyStore {
  id: string;
  chainId: string;
  chainName: string;
  name: string;
  street: string | null;
  zip: string | null;
  city: string | null;
  lat: number;
  lon: number;
  /** `salling` or `tjek`. */
  source: string | null;
  sourceStoreId: string | null;
  distanceKm: number;
}

/**
 * Chains whose stores come from Salling as well as Tjek. Food waste refers to the Salling ids,
 * so their Salling rows are kept.
 */
export const SALLING_CHAINS: ReadonlySet<string> = new Set(["netto", "foetex", "bilka"]);

const collator = new Intl.Collator("da-DK");

/** Nearest first; ties by name, so the order is stable. */
export function compareByDistance(
  a: Pick<NearbyStore, "distanceKm" | "name">,
  b: Pick<NearbyStore, "distanceKm" | "name">,
): number {
  return a.distanceKm - b.distanceKm || collator.compare(a.name, b.name);
}

/**
 * One row per physical store, nearest first. `api.stores` lists Netto, føtex and Bilka twice
 * (Salling and Tjek): for those chains only the Salling rows are kept, unless a chain has no
 * Salling row at all (then its Tjek rows are better than nothing). Other chains keep their Tjek
 * rows.
 */
export function dedupeStores<
  T extends Pick<NearbyStore, "chainId" | "source" | "distanceKm" | "name">,
>(stores: readonly T[]): T[] {
  const sallingChains = new Set(
    stores
      .filter((s) => s.source === "salling" && SALLING_CHAINS.has(s.chainId))
      .map((s) => s.chainId),
  );
  return stores
    .filter((s) => !sallingChains.has(s.chainId) || s.source === "salling")
    .sort(compareByDistance);
}

/**
 * A store's name with its chain: the name when it already starts with the chain name, otherwise
 * `"{chain} {name}"` (Lidl's "Kbh., Vesterbro, Fisketorvet" -> "Lidl Kbh., Vesterbro, …").
 */
export function storeDisplayName(
  name: string,
  chainId: string,
  chain = chainName(chainId),
): string {
  const clean = name.trim();
  if (!clean) return chain;
  if (clean.toLocaleLowerCase("da-DK").startsWith(chain.toLocaleLowerCase("da-DK"))) return clean;
  return `${chain} ${clean}`;
}

/** A store's name without its chain prefix ("Netto Rådhuspladsen" -> "Rådhuspladsen"). */
export function shortStoreName(name: string, chainId: string, chain = chainName(chainId)): string {
  const clean = name.trim();
  if (clean.toLocaleLowerCase("da-DK").startsWith(chain.toLocaleLowerCase("da-DK"))) {
    const rest = clean.slice(chain.length).replace(/^[\s,.\-–]+/, "");
    if (rest) return rest;
  }
  return clean || chain;
}

/** `"Vestergade 39, 1456 København K"`; null when nothing is known. */
export function storeAddress(store: Pick<NearbyStore, "street" | "zip" | "city">): string | null {
  const town = [store.zip, store.city].filter(Boolean).join(" ");
  const text = [store.street, town].filter(Boolean).join(", ");
  return text || null;
}

/** The stores of each chain, nearest first. Chains are in the order of their nearest store. */
export function nearestByChain<T extends Pick<NearbyStore, "chainId" | "distanceKm" | "name">>(
  stores: readonly T[],
): Map<string, T[]> {
  const byChain = new Map<string, T[]>();
  for (const store of [...stores].sort(compareByDistance)) {
    const list = byChain.get(store.chainId);
    if (list) list.push(store);
    else byChain.set(store.chainId, [store]);
  }
  return byChain;
}

/** A food-waste clearance as needed for grouping. */
export interface StoreItem {
  storeId: string;
  distanceKm: number;
  discountPct: number | null;
  title: string;
}

export interface StoreGroup<T extends StoreItem> {
  storeId: string;
  distanceKm: number;
  items: T[];
}

/** Largest discount first (unknown discounts last), then by title. */
export function compareByDiscount(a: StoreItem, b: StoreItem): number {
  const da = a.discountPct ?? Number.NEGATIVE_INFINITY;
  const db = b.discountPct ?? Number.NEGATIVE_INFINITY;
  return db - da || a.distanceKm - b.distanceKm || collator.compare(a.title, b.title);
}

/** Clearances grouped by store: nearest store first, largest discount first within a store. */
export function groupByStore<T extends StoreItem>(items: readonly T[]): StoreGroup<T>[] {
  const groups = new Map<string, StoreGroup<T>>();
  for (const item of items) {
    const group = groups.get(item.storeId);
    if (group) group.items.push(item);
    else
      groups.set(item.storeId, {
        storeId: item.storeId,
        distanceKm: item.distanceKm,
        items: [item],
      });
  }
  return [...groups.values()]
    .map((g) => ({ ...g, items: [...g.items].sort(compareByDiscount) }))
    .sort((a, b) => a.distanceKm - b.distanceKm || a.storeId.localeCompare(b.storeId));
}

/** A store as passed to the map and the store lists (plain JSON, docs/ui.md §7). */
export interface MapStore {
  id: string;
  chainId: string;
  /** Display name with the chain ({@link storeDisplayName}). */
  name: string;
  street: string | null;
  zip: string | null;
  city: string | null;
  lat: number;
  lon: number;
  distanceKm: number;
  /** Food-waste clearances in this store. */
  foodWasteCount: number;
  /** This week's compared offers of other chains that this store's chain has cheaper. */
  cheaperCount: number;
  source: string | null;
  sourceStoreId: string | null;
}

/** The map form of a store. */
export function toMapStore(
  store: NearbyStore,
  counts: { foodWasteCount?: number; cheaperCount?: number } = {},
): MapStore {
  return {
    id: store.id,
    chainId: store.chainId,
    name: storeDisplayName(store.name, store.chainId),
    street: store.street,
    zip: store.zip,
    city: store.city,
    lat: store.lat,
    lon: store.lon,
    distanceKm: store.distanceKm,
    foodWasteCount: counts.foodWasteCount ?? 0,
    cheaperCount: counts.cheaperCount ?? 0,
    source: store.source,
    sourceStoreId: store.sourceStoreId,
  };
}

/**
 * A store as shown in the store popover ({@link storePin}): plain JSON for client components.
 * `name` includes the chain ({@link storeDisplayName}).
 */
export interface StorePin {
  id: string;
  chainId: string;
  name: string;
  street: string | null;
  zip: string | null;
  city: string | null;
  lat: number;
  lon: number;
  distanceKm: number;
}

/** The popover form of a store. */
export function storePin(
  store: Pick<
    NearbyStore,
    "id" | "chainId" | "name" | "street" | "zip" | "city" | "lat" | "lon" | "distanceKm"
  >,
): StorePin {
  return {
    id: store.id,
    chainId: store.chainId,
    name: storeDisplayName(store.name, store.chainId),
    street: store.street,
    zip: store.zip,
    city: store.city,
    lat: store.lat,
    lon: store.lon,
    distanceKm: store.distanceKm,
  };
}

/** How many of a chain's nearest stores the popover lists. */
export const POPOVER_STORES = 3;

/** The popover stores of a chain: its nearest few within the radius (empty when none). */
export function chainPins(
  storesByChain: ReadonlyMap<string, readonly NearbyStore[]>,
  chainId: string,
): { pins: StorePin[]; total: number } {
  const list = storesByChain.get(chainId) ?? [];
  return { pins: list.slice(0, POPOVER_STORES).map(storePin), total: list.length };
}
