import { describe, expect, it } from "vitest";
import {
  dedupeStores,
  groupByStore,
  nearestByChain,
  shortStoreName,
  storeAddress,
  storeDisplayName,
  toMapStore,
  type NearbyStore,
} from "./stores";

function store(overrides: Partial<NearbyStore>): NearbyStore {
  return {
    id: "s",
    chainId: "netto",
    chainName: "Netto",
    name: "Netto Rådhuspladsen",
    street: "Vestergade 39",
    zip: "1456",
    city: "København K",
    lat: 55.676,
    lon: 12.568,
    source: "salling",
    sourceStoreId: "x",
    distanceKm: 0.08,
    ...overrides,
  };
}

describe("dedupeStores", () => {
  it("keeps Salling rows for Salling chains and Tjek rows for the others, nearest first", () => {
    const rows = [
      store({ id: "netto-tjek", source: "tjek", distanceKm: 0.08 }),
      store({ id: "netto-salling", source: "salling", distanceKm: 0.08 }),
      store({
        id: "rema",
        chainId: "rema1000",
        name: "REMA 1000 Vesterbro",
        source: "tjek",
        distanceKm: 0.33,
      }),
      store({
        id: "lidl",
        chainId: "lidl",
        name: "Kbh., Fisketorvet",
        source: "tjek",
        distanceKm: 0.2,
      }),
    ];
    expect(dedupeStores(rows).map((s) => s.id)).toEqual(["netto-salling", "lidl", "rema"]);
  });

  it("falls back to Tjek rows when a Salling chain has no Salling row", () => {
    const rows = [store({ id: "bilka-tjek", chainId: "bilka", source: "tjek" })];
    expect(dedupeStores(rows).map((s) => s.id)).toEqual(["bilka-tjek"]);
  });
});

describe("store names", () => {
  it("prefixes the chain when the name lacks it", () => {
    expect(storeDisplayName("Kbh., Vesterbro, Fisketorvet", "lidl")).toBe(
      "Lidl Kbh., Vesterbro, Fisketorvet",
    );
    expect(storeDisplayName("Netto Rådhuspladsen", "netto")).toBe("Netto Rådhuspladsen");
    expect(storeDisplayName("føtex Food Virum", "foetex")).toBe("føtex Food Virum");
    expect(storeDisplayName("FØTEX Vesterbro", "foetex")).toBe("FØTEX Vesterbro");
    expect(storeDisplayName(" ", "meny")).toBe("MENY");
  });

  it("drops the chain prefix for the where line", () => {
    expect(shortStoreName("Netto Rådhuspladsen", "netto")).toBe("Rådhuspladsen");
    expect(shortStoreName("REMA 1000 - Vesterbrogade", "rema1000")).toBe("Vesterbrogade");
    expect(shortStoreName("Kbh., Fisketorvet", "lidl")).toBe("Kbh., Fisketorvet");
    expect(shortStoreName("Netto", "netto")).toBe("Netto");
  });

  it("formats the address", () => {
    expect(storeAddress(store({}))).toBe("Vestergade 39, 1456 København K");
    expect(storeAddress(store({ street: null }))).toBe("1456 København K");
    expect(storeAddress(store({ street: null, zip: null, city: null }))).toBeNull();
  });
});

describe("nearestByChain", () => {
  it("lists each chain's stores nearest first, chains by their nearest store", () => {
    const byChain = nearestByChain([
      store({ id: "n2", distanceKm: 1.5 }),
      store({ id: "r1", chainId: "rema1000", distanceKm: 0.3 }),
      store({ id: "n1", distanceKm: 0.08 }),
    ]);
    expect([...byChain.keys()]).toEqual(["netto", "rema1000"]);
    expect(byChain.get("netto")?.map((s) => s.id)).toEqual(["n1", "n2"]);
  });
});

describe("groupByStore", () => {
  const item = (
    storeId: string,
    distanceKm: number,
    discountPct: number | null,
    title: string,
  ) => ({
    storeId,
    distanceKm,
    discountPct,
    title,
  });

  it("puts the nearest store first and the largest discount first within a store", () => {
    const groups = groupByStore([
      item("far", 2, 70, "A"),
      item("near", 0.1, 30, "B"),
      item("near", 0.1, 80, "C"),
      item("near", 0.1, null, "D"),
    ]);
    expect(groups.map((g) => g.storeId)).toEqual(["near", "far"]);
    expect(groups[0]?.items.map((i) => i.title)).toEqual(["C", "B", "D"]);
  });
});

describe("toMapStore", () => {
  it("passes plain JSON with the display name and counts", () => {
    expect(
      toMapStore(store({ id: "l", chainId: "lidl", name: "Kbh., Fisketorvet", source: "tjek" }), {
        cheaperCount: 3,
      }),
    ).toMatchObject({
      id: "l",
      name: "Lidl Kbh., Fisketorvet",
      foodWasteCount: 0,
      cheaperCount: 3,
    });
  });
});
