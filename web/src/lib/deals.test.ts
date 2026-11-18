import { describe, expect, it } from "vitest";
import {
  type DealRow,
  countByStatus,
  evaluateDeals,
  explainStatus,
  filterDeals,
  groupDeals,
  memberPriceLabel,
  parseDealFilter,
  parseReferences,
  referenceViews,
  unitPriceWord,
} from "./deals";

function row(overrides: Partial<DealRow> = {}): DealRow {
  return {
    listingId: "00000000-0000-0000-0000-000000000001",
    variantIndex: 0,
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
    nettoUnitPriceWorst: 33.33,
    nettoUnitPriceBest: 33.33,
    references: [
      { kind: "offer", chain_id: "superbrugsen", unit_price: 39 },
      { kind: "regular", chain_id: "rema1000", unit_price: 49.9 },
    ],
    memberOnly: false,
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
    const [deal] = evaluateDeals([row({ priceApplies: null, nettoUnitPriceWorst: null })], []);
    expect(deal?.status).toBe("pending");
    expect(deal?.result).toBeNull();
  });
});

describe("filtering and grouping", () => {
  const deals = evaluateDeals(
    [
      row(),
      row({
        listingId: "2",
        title: "Hakket oksekød 14-18%",
        typeId: "hakket_oksekød",
        typeLabel: "Hakket oksekød",
        nettoUnitPriceWorst: 72,
        nettoUnitPriceBest: 54,
        references: [{ kind: "offer", chain_id: "meny", unit_price: 49.9 }],
      }),
      row({
        listingId: "3",
        title: "Æg 10 stk",
        typeId: "æg",
        typeLabel: "Æg",
        groupName: "Æg",
        unit: "stk",
      }),
      row({
        listingId: "4",
        title: "Skyr",
        typeId: "skyr",
        typeLabel: "Skyr",
        groupName: "Mejeri",
      }),
      row({ listingId: "5", groupName: "Snacks", typeId: "x", typeLabel: "X", isExact: false }),
    ],
    ["superbrugsen", "meny"],
  );

  it("filters good deals by default", () => {
    expect(parseDealFilter(undefined)).toBe("gode");
    expect(parseDealFilter("alle")).toBe("alle");
    expect(parseDealFilter(["alle"])).toBe("gode");
    expect(filterDeals(deals, "gode").map((d) => d.listingId)).toEqual([
      "00000000-0000-0000-0000-000000000001",
      "3",
      "4",
    ]);
    expect(filterDeals(deals, "alle")).toHaveLength(5);
  });

  it("groups in shopping order, unknown groups last", () => {
    const groups = groupDeals(deals);
    expect(groups.map((g) => g.groupName)).toEqual(["Kød", "Æg", "Mejeri", "Snacks"]);
    expect(groups[0]?.types.map((t) => t.typeLabel)).toEqual(["Hakket grisekød", "Hakket oksekød"]);
  });

  it("counts statuses", () => {
    const counts = countByStatus(deals);
    expect(counts.good_deal).toBe(3);
    expect(counts.cheaper_elsewhere).toBe(1);
    expect(counts.not_exact).toBe(1);
    expect(counts.pending).toBe(0);
  });
});

describe("explanations", () => {
  const plain = (s: string) => s.replace(/ /g, " ");

  it("explains a good deal with prices", () => {
    const [deal] = evaluateDeals([row()], ["superbrugsen"]);
    expect(plain(explainStatus(deal!))).toBe(
      "Nettos højeste kilopris (33,33 kr./kg) er lig med eller lavere end den billigste sammenligning (39,00 kr./kg).",
    );
  });

  it("uses the right unit word", () => {
    expect(unitPriceWord("l")).toBe("literpris");
    expect(unitPriceWord("stk")).toBe("stykpris");
    expect(unitPriceWord(null)).toBe("kilopris");
  });

  it("has an explanation for every status", () => {
    const statuses = [
      row({ nettoUnitPriceWorst: null }),
      row({ priceApplies: false }),
      row({ isExact: false }),
      row({ references: [] }),
      row({ nettoUnitPriceWorst: 60, nettoUnitPriceBest: 30 }),
      row({ nettoUnitPriceWorst: 60, nettoUnitPriceBest: 50 }),
      row({ priceApplies: null }),
      row(),
    ];
    const texts = evaluateDeals(statuses, ["superbrugsen"]).map(explainStatus);
    expect(new Set(texts).size).toBe(statuses.length);
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
          nettoUnitPriceWorst: 34,
          nettoUnitPriceBest: 34,
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

describe("member prices", () => {
  it("a marked Netto member price can be a good deal and says so", () => {
    const [deal] = evaluateDeals([row({ memberOnly: true })], ["superbrugsen", "rema1000"]);
    expect(deal?.status).toBe("good_deal");
    expect(deal && explainStatus(deal)).toContain("medlemspris og gælder kun med Netto+");
  });

  it("a competitor member price counts and the plain explanation has no member note", () => {
    const [deal] = evaluateDeals(
      [
        row({
          references: [{ kind: "offer", chain_id: "kvickly", unit_price: 30, member_only: true }],
        }),
      ],
      ["kvickly"],
    );
    expect(deal?.status).toBe("cheaper_elsewhere");
    expect(deal && explainStatus(deal)).not.toContain("medlemspris");
  });

  it("labels the membership per chain", () => {
    expect(memberPriceLabel("netto")).toBe("Medlemspris (Netto+)");
    expect(memberPriceLabel("superbrugsen")).toBe("Medlemspris (Coop-medlem)");
    expect(memberPriceLabel("365discount")).toBe("Medlemspris (Coop-medlem)");
    expect(memberPriceLabel("lidl")).toBe("Medlemspris");
  });
});
