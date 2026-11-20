import { describe, expect, it } from "vitest";
import { evaluateDeals, groupByListing, type DealRow } from "./deals";
import type { FoodWasteItem } from "./foodwaste";
import { TYPE_IDS } from "./groups";
import {
  MAX_STAPLES,
  STAPLE_CATALOGUE,
  TYPE_STAPLES,
  normalizeStapleText,
  resolveStaple,
  searchStaples,
  textStapleId,
  withStaple,
} from "./staple-catalogue";
import {
  MAX_OFFERS_PER_STAPLE,
  type TextOffer,
  parseStaples,
  serializeStaples,
  stapleMatches,
  textStapleTerms,
} from "./staples";

function row(overrides: Partial<DealRow>): DealRow {
  return {
    listingId: "l1",
    variantIndex: 0,
    chainId: "netto",
    chainName: "Netto",
    title: "Frilandsæg 10 stk.",
    description: "",
    price: 25,
    unit: "stk",
    unitPriceMin: 2.5,
    unitPriceMax: 2.5,
    validFrom: "2026-11-16T23:00:00Z",
    validTo: "2026-11-22T22:59:59Z",
    typeId: "æg",
    typeLabel: "Æg",
    groupName: "Æg",
    classKey: "æg|produktion=frilands",
    classLabel: "Æg, frilands",
    isExact: true,
    notes: [],
    priceApplies: true,
    targetUnitPriceWorst: 2.5,
    targetUnitPriceBest: 2.5,
    references: [{ kind: "regular", chain_id: "rema1000", unit_price: 3 }],
    memberOnly: false,
    source: "tjek",
    sourceItemId: null,
    catalogId: null,
    sizeMin: 10,
    sizeMax: 10,
    maxPerCustomer: null,
    productKey: null,
    ...overrides,
  };
}

const NEARBY = new Set(["netto", "rema1000", "lidl"]);
const listings = (rows: DealRow[]) => groupByListing(evaluateDeals(rows, NEARBY));

const waste = (overrides: Partial<FoodWasteItem>) =>
  ({
    listingId: "w1",
    classKey: "æg|x",
    discountPct: 40,
    distanceKm: 1,
    ...overrides,
  }) as FoodWasteItem;

describe("staple selection", () => {
  it("parses known ids in the stored order without duplicates", () => {
    expect(parseStaples("maelk,aeg,ukendt,aeg")).toEqual(["maelk", "aeg"]);
    expect(parseStaples("")).toEqual([]);
    expect(parseStaples(undefined)).toEqual([]);
    expect(parseStaples("%E0%A4%A,aeg")).toEqual(["aeg"]); // malformed escape is skipped
  });

  it("serializes only known ids, URI-encoded, and round-trips", () => {
    expect(serializeStaples(["havregryn", "x", 3, "aeg"])).toEqual("havregryn,aeg");
    const ids = ["t:kyllingebryst", "q:rugbrød", "aeg"];
    const value = serializeStaples(ids);
    expect(value).toBe("t%3Akyllingebryst,q%3Arugbr%C3%B8d,aeg");
    expect(parseStaples(value)).toEqual(ids);
  });

  it("caps the number of staples", () => {
    const many = [
      ...TYPE_STAPLES.map((o) => o.id),
      ...Array.from({ length: 10 }, (_, i) => `q:vare ${i}`),
    ];
    expect(many.length).toBeGreaterThan(MAX_STAPLES);
    expect(parseStaples(serializeStaples(many))).toHaveLength(MAX_STAPLES);
  });

  it("only offers staples of the taxonomy, every type exactly once", () => {
    for (const o of STAPLE_CATALOGUE) for (const t of o.types) expect(TYPE_IDS).toContain(t);
    const types = STAPLE_CATALOGUE.flatMap((o) => o.types);
    expect(new Set(types).size).toBe(types.length);
    expect([...types].sort()).toEqual([...TYPE_IDS].sort());
  });

  it("resolves suggestions, types and free text", () => {
    expect(resolveStaple("aeg")).toMatchObject({ kind: "types", label: "Æg", types: ["æg"] });
    expect(resolveStaple("t:linser")).toMatchObject({ kind: "types", label: "Linser" });
    expect(resolveStaple("t:æg")).toBeNull(); // covered by the suggestion "aeg"
    expect(resolveStaple("q:rugbrød")).toEqual({
      kind: "text",
      id: "q:rugbrød",
      label: "Rugbrød",
      text: "rugbrød",
    });
    expect(resolveStaple("q:Rugbrød")).toBeNull(); // not normalized
    expect(resolveStaple("q:x")).toBeNull();
  });

  it("normalizes free text", () => {
    expect(normalizeStapleText("  Faxe,  KONDI ")).toBe("faxe kondi");
    expect(normalizeStapleText("a")).toBeNull();
    expect(normalizeStapleText(3)).toBeNull();
    expect(textStapleId("Rugbrød")).toBe("q:rugbrød");
    expect(normalizeStapleText("x".repeat(80))).toHaveLength(40);
  });

  it("adds a staple at the end once", () => {
    expect(withStaple(["aeg"], "t:linser")).toEqual(["aeg", "t:linser"]);
    expect(withStaple(["aeg"], "aeg")).toEqual(["aeg"]);
    expect(withStaple(["aeg"], "nope")).toEqual(["aeg"]);
  });

  it("searches the catalogue by label, label starts first, without selected ones", () => {
    expect(searchStaples("kylling", []).map((o) => o.id)).toEqual([
      "t:kyllingeinderfilet",
      "t:kyllingebryst",
      "t:kyllingelår",
      "t:hakket_kylling",
      "t:hel_kylling",
    ]);
    expect(searchStaples("YOG", ["yoghurt"]).map((o) => o.id)).toEqual([]);
    expect(searchStaples("hakket okse", []).map((o) => o.label)).toEqual([
      "Hakket okse- og grisekød",
      "Hakket oksekød",
    ]);
    expect(searchStaples("   ", [])).toEqual([]);
  });
});

describe("stapleMatches", () => {
  it("finds offers and clearances of a chosen staple", () => {
    const [eggs] = stapleMatches(
      ["aeg"],
      listings([row({}), row({ listingId: "l2", typeId: "mælk", unit: "l" })]),
      [waste({}), waste({ listingId: "w2", classKey: "skyr|x" })],
    );
    expect(eggs?.offers.map((l) => l.listingId)).toEqual(["l1"]);
    expect(eggs?.clearances.map((w) => w.listingId)).toEqual(["w1"]);
  });

  it("only shows good and undecided deals, good deals first", () => {
    const [eggs] = stapleMatches(
      ["aeg"],
      listings([
        row({ listingId: "dear", targetUnitPriceWorst: 4, targetUnitPriceBest: 4 }),
        row({
          listingId: "undecided",
          unitPriceMin: 2,
          targetUnitPriceWorst: 3.5,
          targetUnitPriceBest: 2,
        }),
        row({ listingId: "good" }),
        row({ listingId: "uncompared", references: [] }),
      ]),
      [],
    );
    expect(eggs?.offers.map((l) => l.listingId)).toEqual(["good", "undecided"]);
  });

  it("limits the rows per staple but keeps the counts", () => {
    const rows = Array.from({ length: 5 }, (_, i) => row({ listingId: `l${i}` }));
    const [eggs] = stapleMatches(["aeg"], listings(rows), []);
    expect(eggs?.offers).toHaveLength(MAX_OFFERS_PER_STAPLE);
    expect(eggs?.offerCount).toBe(5);
  });

  it("keeps a chosen staple with nothing on offer (shown as such)", () => {
    expect(stapleMatches(["havregryn"], [], [])[0]?.offerCount).toBe(0);
  });
});

describe("free-text staples", () => {
  const now = new Date("2026-11-20T12:00:00Z");
  const offer = (overrides: Partial<TextOffer>): TextOffer => ({
    listingId: "t1",
    productKey: "offer:netto:rugbrød:1kg",
    chainId: "netto",
    title: "Kohberg Rugbrød",
    price: 15,
    unit: "kg",
    unitPriceMin: 15,
    unitPriceMax: 15,
    sizeMin: 1,
    sizeMax: 1,
    validFrom: "2026-11-15T00:00:00Z",
    validTo: "2026-11-21T22:59:59Z",
    memberOnly: false,
    source: "tjek",
    ...overrides,
  });

  it("lists the texts to query", () => {
    expect(textStapleTerms(["aeg", "q:rugbrød", "q:kaffe"])).toEqual(["rugbrød", "kaffe"]);
  });

  it("match offer names containing the text, started and cheapest first", () => {
    const [bread] = stapleMatches(
      ["q:rugbrød"],
      [],
      [],
      [
        offer({ listingId: "dear", unitPriceMin: 30, unitPriceMax: 30 }),
        offer({ listingId: "later", unitPriceMin: 5, validFrom: "2026-11-22T00:00:00Z" }),
        offer({ listingId: "cheap", title: "SCHULSTAD RUGBRØD", unitPriceMin: 12 }),
        offer({ listingId: "coffee", title: "Kaffe" }),
      ],
      now,
    );
    expect(bread?.staple.kind).toBe("text");
    expect(bread?.textOffers.map((o) => o.listingId)).toEqual(["cheap", "dear", "later"]);
    expect(bread?.offerCount).toBe(3);
    expect(bread?.offers).toEqual([]);
  });

  it("matches other taxonomy types like suggestions", () => {
    const [lentils] = stapleMatches(
      ["t:linser"],
      listings([row({ listingId: "l", typeId: "linser", groupName: "Kolonial" })]),
      [waste({ listingId: "w", classKey: "linser|x" })],
    );
    expect(lentils?.offers.map((l) => l.listingId)).toEqual(["l"]);
    expect(lentils?.clearances.map((w) => w.listingId)).toEqual(["w"]);
  });
});
