/**
 * Links to where a price comes from, so it can be checked (docs/ui.md §1.1 and §5.4). Only URL
 * templates that were verified with real requests are used; when no rule matches, nothing is
 * shown (no dead links, no invented Salling pages).
 */

import { ETILBUDSAVIS_SLUGS } from "./chains";

export interface SourceLink {
  /** Null for a plain-text note (expired offer, food waste without a product page). */
  href: string | null;
  label: string;
}

/** The facts of a listing that its source link is built from. */
export interface SourceRow {
  /** `tjek`, `rema` or `salling_food_waste`. */
  source: string | null;
  chainId: string;
  sourceItemId: string | null;
  catalogId: string | null;
  validTo: string | null;
}

export const FOOD_WASTE_SOURCE_TEXT = "Fra Salling Groups madspildsdata – ingen vareside";

const REMA_PRODUCT_ID = /^\d+$/;
const EAN = /^(?:\d{8}|\d{12,14})$/;

const nonEmpty = (value: string | null | undefined): value is string =>
  typeof value === "string" && value.trim() !== "";

function isPast(validTo: string | null, now: Date): boolean {
  if (validTo == null) return false;
  const end = Date.parse(validTo);
  return Number.isFinite(end) && end < now.getTime();
}

/** The source link of a listing as seen at `now`, or null when no verified link exists. */
export function sourceLink(row: SourceRow, now: Date): SourceLink | null {
  switch (row.source) {
    case "tjek": {
      if (isPast(row.validTo, now)) return { href: null, label: "Tilbuddet er udløbet" };
      const slug = ETILBUDSAVIS_SLUGS[row.chainId];
      if (!slug || !nonEmpty(row.catalogId) || !nonEmpty(row.sourceItemId)) return null;
      const params = new URLSearchParams({
        publication: row.catalogId.trim(),
        offer: row.sourceItemId.trim(),
      });
      return {
        href: `https://etilbudsavis.dk/${encodeURIComponent(slug)}?${params.toString()}`,
        label: "Se tilbuddet i avisen",
      };
    }
    case "rema": {
      const id = row.sourceItemId?.trim();
      if (!id || !REMA_PRODUCT_ID.test(id)) return null;
      return {
        href: `https://shop.rema1000.dk/varer/${encodeURIComponent(id)}`,
        label: isPast(row.validTo, now)
          ? "Se varen hos REMA 1000 (viser dagens pris)"
          : "Se varen hos REMA 1000",
      };
    }
    case "salling_food_waste":
      return { href: null, label: FOOD_WASTE_SOURCE_TEXT };
    default:
      return null;
  }
}

/** The Open Food Facts page of a product, for a weight that came from there. */
export function openFoodFactsLink(ean: string | null | undefined): SourceLink | null {
  const code = ean?.trim();
  if (!code || !EAN.test(code)) return null;
  return {
    href: `https://world.openfoodfacts.org/product/${encodeURIComponent(code)}`,
    label: "Vægt ifølge Open Food Facts",
  };
}

/** The product page on Open Food Facts, shown for every item with an EAN. */
export function openFoodFactsProductLink(ean: string | null | undefined): SourceLink | null {
  const link = openFoodFactsLink(ean);
  return link ? { ...link, label: "Varen på Open Food Facts" } : null;
}

/** The eTilbudsavis page of a Tjek store (`/{slug}/butikker/{id}`), or null. */
export function storePageLink(store: {
  chainId: string;
  source: string | null;
  sourceStoreId: string | null;
}): SourceLink | null {
  const slug = ETILBUDSAVIS_SLUGS[store.chainId];
  if (store.source !== "tjek" || !slug || !nonEmpty(store.sourceStoreId)) return null;
  return {
    href: `https://etilbudsavis.dk/${encodeURIComponent(slug)}/butikker/${encodeURIComponent(store.sourceStoreId.trim())}`,
    label: "Butikkens side",
  };
}

/** Directions to a point in Google Maps (documented Maps URLs API; a navigation aid only). */
export function routeLink(lat: number, lon: number): string {
  const params = new URLSearchParams({ api: "1", destination: `${lat},${lon}` });
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/**
 * A store in Google Maps (documented Maps URLs API, opens a new tab): searched by name and
 * address when the address is known, otherwise by its coordinates.
 */
export function storeMapsLink(store: {
  name: string;
  street?: string | null;
  zip?: string | null;
  city?: string | null;
  lat: number;
  lon: number;
}): string {
  const place = [store.street, [store.zip, store.city].filter(nonEmpty).join(" ")]
    .filter(nonEmpty)
    .join(", ");
  const query = place ? `${store.name}, ${place}` : `${store.lat},${store.lon}`;
  const params = new URLSearchParams({ api: "1", query });
  return `https://www.google.com/maps/search/?${params.toString()}`;
}
