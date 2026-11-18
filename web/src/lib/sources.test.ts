import { describe, expect, it } from "vitest";
import {
  FOOD_WASTE_SOURCE_TEXT,
  openFoodFactsLink,
  routeLink,
  sourceLink,
  storePageLink,
} from "./sources";

const NOW = new Date("2026-11-18T12:00:00Z");

const tjek = {
  source: "tjek",
  chainId: "netto",
  sourceItemId: "quPV2BQEWPxpWQGWNTYwj",
  catalogId: "40K-WXWp",
  validTo: "2026-11-20T22:59:59Z",
};

describe("sourceLink", () => {
  it("opens a Tjek offer in its leaflet on eTilbudsavis", () => {
    expect(sourceLink(tjek, NOW)).toEqual({
      href: "https://etilbudsavis.dk/Netto?publication=40K-WXWp&offer=quPV2BQEWPxpWQGWNTYwj",
      label: "Se tilbuddet i avisen",
    });
    expect(sourceLink({ ...tjek, chainId: "foetex" }, NOW)?.href).toMatch(
      /^https:\/\/etilbudsavis\.dk\/fotex\?/,
    );
    expect(sourceLink({ ...tjek, validTo: null }, NOW)?.href).toContain("offer=");
  });

  it("encodes the parameters", () => {
    expect(sourceLink({ ...tjek, sourceItemId: "a&b c" }, NOW)?.href).toBe(
      "https://etilbudsavis.dk/Netto?publication=40K-WXWp&offer=a%26b+c",
    );
  });

  it("shows an expired offer as plain text", () => {
    expect(sourceLink({ ...tjek, validTo: "2026-11-17T22:59:59Z" }, NOW)).toEqual({
      href: null,
      label: "Tilbuddet er udløbet",
    });
  });

  it("gives no link without a slug or ids", () => {
    expect(sourceLink({ ...tjek, chainId: "loevbjerg" }, NOW)).toBeNull();
    expect(sourceLink({ ...tjek, catalogId: null }, NOW)).toBeNull();
    expect(sourceLink({ ...tjek, sourceItemId: " " }, NOW)).toBeNull();
  });

  it("opens a REMA 1000 product page, saying when the price period is over", () => {
    const rema = {
      source: "rema",
      chainId: "rema1000",
      sourceItemId: "100004",
      catalogId: null,
      validTo: null,
    };
    expect(sourceLink(rema, NOW)).toEqual({
      href: "https://shop.rema1000.dk/varer/100004",
      label: "Se varen hos REMA 1000",
    });
    expect(sourceLink({ ...rema, validTo: "2026-11-01T00:00:00Z" }, NOW)?.label).toBe(
      "Se varen hos REMA 1000 (viser dagens pris)",
    );
    expect(sourceLink({ ...rema, sourceItemId: "../x" }, NOW)).toBeNull();
  });

  it("never invents a Salling page", () => {
    expect(
      sourceLink(
        {
          source: "salling_food_waste",
          chainId: "netto",
          sourceItemId: "abc:5701234567890",
          catalogId: null,
          validTo: null,
        },
        NOW,
      ),
    ).toEqual({ href: null, label: FOOD_WASTE_SOURCE_TEXT });
    expect(
      sourceLink(
        { source: null, chainId: "netto", sourceItemId: null, catalogId: null, validTo: null },
        NOW,
      ),
    ).toBeNull();
  });
});

describe("other links", () => {
  it("links an Open Food Facts product by EAN", () => {
    expect(openFoodFactsLink("5710328002307")).toEqual({
      href: "https://world.openfoodfacts.org/product/5710328002307",
      label: "Vægt ifølge Open Food Facts",
    });
    expect(openFoodFactsLink("57103280")?.href).toContain("/57103280");
    expect(openFoodFactsLink("12345")).toBeNull();
    expect(openFoodFactsLink("57103280023x")).toBeNull();
    expect(openFoodFactsLink(null)).toBeNull();
  });

  it("links a Tjek store's page only", () => {
    expect(storePageLink({ chainId: "netto", source: "tjek", sourceStoreId: "86d7kOL" })).toEqual({
      href: "https://etilbudsavis.dk/Netto/butikker/86d7kOL",
      label: "Butikkens side",
    });
    expect(storePageLink({ chainId: "netto", source: "salling", sourceStoreId: "x" })).toBeNull();
    expect(storePageLink({ chainId: "loevbjerg", source: "tjek", sourceStoreId: "x" })).toBeNull();
  });

  it("builds directions", () => {
    expect(routeLink(55.6761, 12.5683)).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=55.6761%2C12.5683",
    );
  });
});
