import { describe, expect, it } from "vitest";
import {
  type DealRow,
  cheaperByChain,
  cleanClassLabel,
  evaluateDeals,
  filterListings,
  groupByListing,
  groupListings,
  groupUpcoming,
  isUpcoming,
  dealsHref,
  genitive,
  memberPriceLabel,
  nearbyDeals,
  parseChainFilter,
  parseDealFilter,
  referenceKindLabel,
  toggleChain,
  parseReferences,
  referenceListingIds,
  referenceViews,
  unitPriceWord,
  verdictBadgeLabel,
  verdictReason,
} from "./deals";

function row(overrides: Partial<DealRow> = {}): DealRow {
  return {
    listingId: "00000000-0000-0000-0000-000000000001",
    variantIndex: 0,
    chainId: "netto",
    chainName: "Netto",
    title: "Hakket grisekød 8-12%",
    description: "",
    price: 25,
    unit: "kg",
    unitPriceMin: 33.33,
    unitPriceMax: 33.33,
    validFrom: "2026-11-14T23:00:00Z",
    validTo: "2026-11-20T22:59:59Z",
    typeId: "hakket_grisekød",
    typeLabel: "Hakket grisekød",
    groupName: "Kød",
    classKey: "hakket_grisekød|fedt=8-12%|øko=nej|forarbejdet=nej",
    classLabel: "Hakket grisekød, 8-12%",
    isExact: true,
    notes: [],
    priceApplies: true,
    targetUnitPriceWorst: 33.33,
    targetUnitPriceBest: 33.33,
    references: [
      { kind: "offer", chain_id: "superbrugsen", unit_price: 39 },
      { kind: "regular", chain_id: "rema1000", unit_price: 49.9 },
    ],
    memberOnly: false,
    source: "tjek",
    sourceItemId: "quPV2BQEWPxpWQGWNTYwj",
    catalogId: "40K-WXWp",
    productKey: "offer:netto:hakket grisekød 8 12",
    sizeMin: 0.3,
    sizeMax: 0.3,
    maxPerCustomer: null,
    ...overrides,
  };
}

describe("parseReferences", () => {
  it("parses valid references and coerces numeric strings", () => {
    expect(
      parseReferences([
        {
          kind: "offer",
          chain_id: "lidl",
          unit_price: "47.44",
          listing_id: "abc",
          title: "Hakket oksekød",
          unit: "kg",
          valid_from: "2026-11-15T00:00:00Z",
          valid_to: null,
        },
      ]),
    ).toEqual([
      {
        kind: "offer",
        chain_id: "lidl",
        unit_price: 47.44,
        listing_id: "abc",
        title: "Hakket oksekød",
        unit: "kg",
        valid_from: "2026-11-15T00:00:00Z",
        valid_to: null,
        member_only: false,
      },
    ]);
  });

  it("keeps the member-price flag of a reference", () => {
    const [ref] = parseReferences([
      { kind: "offer", chain_id: "superbrugsen", unit_price: 35, member_only: true },
    ]);
    expect(ref?.member_only).toBe(true);
  });

  it("drops malformed references", () => {
    expect(
      parseReferences([
        null,
        "x",
        { kind: "rumor", chain_id: "lidl", unit_price: 1 },
        { kind: "offer", unit_price: 1 },
        { kind: "offer", chain_id: "lidl", unit_price: 0 },
        { kind: "offer", chain_id: "lidl", unit_price: "abc" },
      ]),
    ).toEqual([]);
    expect(parseReferences({ kind: "offer" })).toEqual([]);
  });
});

describe("evaluateDeals", () => {
  it("evaluates against the nearby chains", () => {
    const [near] = evaluateDeals([row()], ["superbrugsen"]);
    expect(near?.status).toBe("good_deal");
    expect(near?.result).toEqual({
      verdict: "good_deal",
      cheapest_unit_price: 39,
      reference_count: 1,
    });
    const [far] = evaluateDeals([row()], ["lidl"]);
    expect(far?.status).toBe("no_reference");
  });

  it("marks uncomputed deals as pending", () => {
    const [deal] = evaluateDeals([row({ priceApplies: null, targetUnitPriceWorst: null })], []);
    expect(deal?.status).toBe("pending");
    expect(deal?.result).toBeNull();
  });
});

describe("referenceViews", () => {
  it("sorts by price and marks counted and cheapest references", () => {
    const [deal] = evaluateDeals(
      [
        row({
          references: [
            { kind: "regular", chain_id: "rema1000", unit_price: 49.9 },
            { kind: "offer", chain_id: "lidl", unit_price: 30 },
            { kind: "history", chain_id: "netto", unit_price: 35 },
          ],
          targetUnitPriceWorst: 34,
          targetUnitPriceBest: 34,
        }),
      ],
      ["rema1000"],
    );
    const views = referenceViews(deal!, new Set(["rema1000"]));
    expect(views.map((v) => [v.chain_id, v.counts, v.isCheapest])).toEqual([
      ["lidl", false, false],
      ["netto", true, true],
      ["rema1000", true, false],
    ]);
  });
});

describe("listings, filtering and grouping", () => {
  const deals = evaluateDeals(
    [
      row(),
      row({
        listingId: "2",
        title: "Hakket oksekød 14-18%",
        typeId: "hakket_oksekød",
        typeLabel: "Hakket oksekød",
        targetUnitPriceWorst: 72,
        targetUnitPriceBest: 54,
        references: [{ kind: "offer", chain_id: "meny", unit_price: 49.9 }],
      }),
      row({ listingId: "3", title: "Æg 10 stk", typeId: "æg", groupName: "Æg", unit: "stk" }),
      row({ listingId: "4", title: "Skyr", typeId: "skyr", groupName: "Mejeri" }),
      row({ listingId: "5", groupName: "Snacks", typeId: "x", typeLabel: "X", isExact: false }),
      // One offer, two recognised variants with different verdicts.
      row({
        listingId: "6",
        variantIndex: 0,
        title: "Yoghurt naturel eller græsk",
        groupName: "Mejeri",
        classLabel: "Yoghurt, naturel, fedt?",
        isExact: false,
      }),
      row({
        listingId: "6",
        variantIndex: 1,
        title: "Yoghurt naturel eller græsk",
        groupName: "Mejeri",
        classLabel: "Græsk yoghurt, 10%",
      }),
    ],
    ["superbrugsen", "meny"],
  );
  const listings = groupByListing(deals);

  it("makes one entry per listing with the best variant first", () => {
    expect(listings).toHaveLength(6);
    const yoghurt = listings.find((l) => l.listingId === "6");
    expect(yoghurt?.variants.map((v) => v.variantIndex)).toEqual([1, 0]);
    expect(yoghurt?.status).toBe("good_deal");
    expect(yoghurt?.offer.variantIndex).toBe(0);
  });

  it("filters good deals by default; a listing counts if any variant is good", () => {
    expect(parseDealFilter(undefined)).toBe("gode");
    expect(parseDealFilter("alle")).toBe("alle");
    expect(parseDealFilter(["alle"])).toBe("gode");
    expect(filterListings(listings, "gode").map((l) => l.listingId)).toEqual([
      "00000000-0000-0000-0000-000000000001",
      "3",
      "4",
      "6",
    ]);
    expect(filterListings(listings, "alle")).toHaveLength(6);
  });

  it("groups in shopping order, unknown groups last, good deals first within a group", () => {
    const groups = groupListings(listings);
    expect(groups.map((g) => g.groupName)).toEqual(["Kød", "Æg", "Mejeri", "Snacks"]);
    expect(groups[0]?.listings.map((l) => l.offer.title)).toEqual([
      "Hakket grisekød 8-12%",
      "Hakket oksekød 14-18%",
    ]);
    expect(groups[2]?.listings.map((l) => l.offer.title)).toEqual([
      "Skyr",
      "Yoghurt naturel eller græsk",
    ]);
  });
});

describe("cleanClassLabel", () => {
  it("drops attributes the matcher could not determine", () => {
    expect(cleanClassLabel("Kyllingebryst(filet), tilsat vand?")).toBe("Kyllingebryst(filet)");
    expect(cleanClassLabel("Yoghurt, naturel, fedt?, økologisk")).toBe(
      "Yoghurt, naturel, økologisk",
    );
    expect(cleanClassLabel("Hakket grisekød, 8-12%")).toBe("Hakket grisekød, 8-12%");
  });
});

describe("verdictReason", () => {
  const plain = (s: string) => s.replace(/ /g, " ");
  const nearby = new Set(["superbrugsen", "rema1000"]);
  const distances: Record<string, number> = { superbrugsen: 0.33, rema1000: 1.25 };
  const km = (chainId: string) => distances[chainId] ?? null;

  it("names the runner-up of a good deal", () => {
    const [deal] = evaluateDeals([row()], nearby);
    expect(plain(verdictReason(deal!, nearby, km))).toBe(
      "Billigst i nærheden. Næstbedst: SuperBrugsen 39,00 kr./kg",
    );
  });

  it("names the cheaper chain and its distance", () => {
    const [deal] = evaluateDeals(
      [row({ targetUnitPriceWorst: 60, targetUnitPriceBest: 50 })],
      nearby,
    );
    expect(deal?.status).toBe("cheaper_elsewhere");
    expect(plain(verdictReason(deal!, nearby, km))).toBe(
      "SuperBrugsen har den til 39,00 kr./kg (330 m)",
    );
  });

  it("explains an undecided deal by the pack size", () => {
    const [deal] = evaluateDeals(
      [row({ targetUnitPriceWorst: 60, targetUnitPriceBest: 30 })],
      nearby,
    );
    expect(plain(verdictReason(deal!, nearby, km))).toBe(
      "Afhænger af pakningen – SuperBrugsen har 39,00 kr./kg (330 m)",
    );
  });

  it("speaks of Netto's own past offers without a distance", () => {
    const [deal] = evaluateDeals(
      [
        row({
          targetUnitPriceWorst: 60,
          targetUnitPriceBest: 50,
          references: [{ kind: "history", chain_id: "netto", unit_price: 35 }],
        }),
      ],
      nearby,
    );
    expect(plain(verdictReason(deal!, nearby, km))).toBe(
      "Netto havde den til 35,00 kr./kg i et tidligere tilbud.",
    );
  });

  it("has a fixed reason for every other status", () => {
    const deals = evaluateDeals(
      [
        row({ targetUnitPriceWorst: null }),
        row({ priceApplies: false }),
        row({ isExact: false }),
        row({ references: [] }),
        row({ priceApplies: null }),
      ],
      nearby,
    );
    expect(deals.map((d) => verdictReason(d, nearby, km))).toEqual([
      "Kilden oplyser ikke vægten.",
      "Prisen dækker flere forskellige varer.",
      "Tilbuddet oplyser ikke alle egenskaber (fx fedtprocent).",
      "Ingen butik i nærheden har præcis samme vare.",
      "Sammenligningen er ikke beregnet endnu.",
    ]);
  });

  it("uses the right unit word", () => {
    expect(unitPriceWord("l")).toBe("literpris");
    expect(unitPriceWord("stk")).toBe("stykpris");
    expect(unitPriceWord(null)).toBe("kilopris");
  });
});

describe("cheaperByChain", () => {
  it("lists deals per chain whose cheapest counted price is there", () => {
    const nearby = new Set(["rema1000", "lidl"]);
    const deals = evaluateDeals(
      [
        row({
          listingId: "a",
          title: "B-vare",
          targetUnitPriceWorst: 60,
          targetUnitPriceBest: 50,
          references: [
            { kind: "regular", chain_id: "rema1000", unit_price: 40, listing_id: "r1" },
            { kind: "offer", chain_id: "lidl", unit_price: 45 },
          ],
        }),
        row({
          listingId: "b",
          title: "A-vare",
          targetUnitPriceWorst: 60,
          targetUnitPriceBest: 30,
          references: [{ kind: "offer", chain_id: "rema1000", unit_price: 40 }],
        }),
        // A good deal is not listed.
        row({ listingId: "c", references: [{ kind: "offer", chain_id: "lidl", unit_price: 90 }] }),
        // The cheapest is Netto's own past offer: not "here".
        row({
          listingId: "d",
          targetUnitPriceWorst: 60,
          targetUnitPriceBest: 50,
          references: [{ kind: "history", chain_id: "netto", unit_price: 20 }],
        }),
      ],
      nearby,
    );
    const byChain = cheaperByChain(deals, nearby);
    expect([...byChain.keys()]).toEqual(["rema1000"]);
    expect(byChain.get("rema1000")?.map((e) => [e.deal.title, e.deal.status])).toEqual([
      ["B-vare", "cheaper_elsewhere"],
      ["A-vare", "undecided"],
    ]);
    expect(referenceListingIds(deals)).toEqual(["r1"]);
  });

  it("works for offers of any chain, but never lists the offer's own chain", () => {
    const nearby = new Set(["netto", "rema1000", "lidl"]);
    const deals = evaluateDeals(
      [
        row({
          listingId: "l1",
          chainId: "lidl",
          chainName: "Lidl",
          title: "Lidl-vare",
          targetUnitPriceWorst: 60,
          targetUnitPriceBest: 50,
          references: [{ kind: "offer", chain_id: "netto", unit_price: 40 }],
        }),
        row({
          listingId: "l2",
          chainId: "lidl",
          chainName: "Lidl",
          title: "Egen normalpris",
          targetUnitPriceWorst: 60,
          targetUnitPriceBest: 50,
          references: [{ kind: "regular", chain_id: "lidl", unit_price: 40 }],
        }),
      ],
      nearby,
    );
    const byChain = cheaperByChain(deals, nearby);
    expect([...byChain.keys()]).toEqual(["netto"]);
    expect(byChain.get("netto")?.map((e) => e.deal.title)).toEqual(["Lidl-vare"]);
  });
});

describe("member prices", () => {
  it("a marked Netto member price can be a good deal and the badge says so", () => {
    const [deal] = evaluateDeals([row({ memberOnly: true })], ["superbrugsen", "rema1000"]);
    expect(deal?.status).toBe("good_deal");
    expect(verdictBadgeLabel(deal!.status, deal!.memberOnly, "netto")).toBe("Godt køb med Netto+");
    expect(verdictBadgeLabel("good_deal", false, "netto")).toBe("Godt køb");
    expect(verdictBadgeLabel("undecided", true, "netto")).toBe("Uafklaret");
  });

  it("a competitor member price counts like any other price", () => {
    const [deal] = evaluateDeals(
      [
        row({
          references: [{ kind: "offer", chain_id: "kvickly", unit_price: 30, member_only: true }],
        }),
      ],
      ["kvickly"],
    );
    expect(deal?.status).toBe("cheaper_elsewhere");
  });

  it("labels the membership per chain", () => {
    expect(memberPriceLabel("netto")).toBe("Kræver Netto+");
    expect(memberPriceLabel("superbrugsen")).toBe("Kræver Coop-medlem");
    expect(memberPriceLabel("365discount")).toBe("Kræver Coop-medlem");
    expect(memberPriceLabel("lidl")).toBe("Medlemspris");
  });
});

describe("all chains", () => {
  it("keeps only offers of chains with a nearby store, and of the selected chains", () => {
    const rows = [
      row({ listingId: "a", chainId: "netto" }),
      row({ listingId: "b", chainId: "lidl" }),
      row({ listingId: "c", chainId: "meny" }),
    ];
    const nearby = new Set(["netto", "lidl"]);
    expect(nearbyDeals(rows, nearby).map((r) => r.listingId)).toEqual(["a", "b"]);
    expect(nearbyDeals(rows, nearby, ["lidl", "meny"]).map((r) => r.listingId)).toEqual(["b"]);
  });

  it("parses and toggles the chain filter", () => {
    expect(parseChainFilter(undefined)).toEqual([]);
    expect(parseChainFilter("lidl, netto,lidl,Bad!")).toEqual(["lidl", "netto"]);
    expect(parseChainFilter(["lidl"])).toEqual([]);
    expect(toggleChain([], "lidl")).toBe("lidl");
    expect(toggleChain(["lidl"], "netto")).toBe("lidl,netto");
    expect(toggleChain(["lidl", "netto"], "lidl")).toBe("netto");
    expect(toggleChain(["lidl"], "lidl")).toBeNull();
  });

  it("builds shareable hrefs", () => {
    expect(dealsHref("gode", null)).toBe("/");
    expect(dealsHref("alle", null)).toBe("/?vis=alle");
    expect(dealsHref("gode", "lidl,netto")).toBe("/?kaede=lidl,netto");
    expect(dealsHref("alle", "lidl")).toBe("/?vis=alle&kaede=lidl");
  });

  it("sorts within a group by unit price, per unit", () => {
    const listings = groupByListing(
      evaluateDeals(
        [
          row({ listingId: "dyr", title: "B", unitPriceMin: 60, unitPriceMax: 70 }),
          row({ listingId: "billig", title: "C", unitPriceMin: 40, unitPriceMax: 50 }),
          row({ listingId: "liter", title: "A", unit: "l", unitPriceMin: 10, unitPriceMax: 10 }),
          row({ listingId: "ukendt", title: "D", unitPriceMin: null, unitPriceMax: null }),
        ],
        ["superbrugsen", "rema1000"],
      ),
    );
    const [group] = groupListings(listings);
    expect(group?.listings.map((l) => l.listingId)).toEqual(["billig", "dyr", "ukendt", "liter"]);
  });

  it("names the offer's own chain in history reasons and labels", () => {
    const [deal] = evaluateDeals(
      [
        row({
          chainId: "lidl",
          chainName: "Lidl",
          references: [{ kind: "history", chain_id: "lidl", unit_price: 20 }],
        }),
      ],
      [],
    );
    expect(verdictReason(deal!, new Set(), () => null)).toBe(
      "Lidl havde den til 20,00\u00a0kr./kg i et tidligere tilbud.",
    );
    expect(referenceKindLabel("history", "lidl")).toBe("Tidligere Lidl-tilbud");
    expect(referenceKindLabel("regular", "lidl")).toBe("Normalpris");
    expect(genitive("Netto")).toBe("Nettos");
    expect(genitive("føtex")).toBe("føtex'");
  });

  it("labels a marked member price of other chains", () => {
    expect(verdictBadgeLabel("good_deal", true, "kvickly")).toBe("Godt køb for Coop-medlemmer");
    expect(verdictBadgeLabel("good_deal", true, "lidl")).toBe("Godt køb for medlemmer");
  });
});

describe("upcoming offers", () => {
  const now = new Date("2026-11-20T12:00:00Z");
  const listing = (id: string, validFrom: string, extra: Partial<DealRow> = {}) =>
    groupByListing(
      evaluateDeals([row({ listingId: id, validFrom, ...extra })], new Set(["superbrugsen"])),
    )[0]!;

  it("are the listings starting after now", () => {
    expect(isUpcoming(listing("a", "2026-11-20T11:59:00Z"), now)).toBe(false);
    expect(isUpcoming(listing("b", "2026-11-21T23:00:00Z"), now)).toBe(true);
  });

  it("group by Copenhagen start day, earliest first, cheapest first within a day", () => {
    const days = groupUpcoming([
      listing("late", "2026-11-26T23:00:00Z"),
      // Saturday 22 November in Copenhagen (23:00 UTC on the 21st)
      listing("dear", "2026-11-21T23:00:00Z", { unitPriceMin: 40, unitPriceMax: 40 }),
      listing("cheap", "2026-11-22T06:00:00Z", { unitPriceMin: 30, unitPriceMax: 30 }),
    ]);
    expect(days.map((d) => d.day)).toEqual(["2026-11-22", "2026-11-27"]);
    expect(days[0]?.listings.map((l) => l.listingId)).toEqual(["cheap", "dear"]);
    expect(days[0]?.startsAt).toBe("2026-11-21T23:00:00Z");
  });
});
