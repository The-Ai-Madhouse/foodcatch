import { describe, expect, it } from "vitest";
import { clearanceSaving, offerSaving, type SavingOffer } from "./savings";

const nearby = new Set(["netto", "rema1000"]);

function offer(overrides: Partial<SavingOffer> = {}): SavingOffer {
  return {
    price: 20,
    unit: "kg",
    sizeMin: 0.5,
    sizeMax: 0.5,
    isExact: true,
    priceApplies: true,
    references: [{ kind: "regular", chain_id: "rema1000", unit_price: 60, unit: "kg" }],
    ...overrides,
  };
}

describe("offerSaving", () => {
  it("saves against the cheapest nearby normal price of the same product", () => {
    const s = offerSaving(
      offer({
        references: [
          { kind: "regular", chain_id: "rema1000", unit_price: 60, unit: "kg" },
          { kind: "regular", chain_id: "netto", unit_price: 56, unit: "kg" },
          // Not near the user: does not count.
          { kind: "regular", chain_id: "lidl", unit_price: 44, unit: "kg" },
          // Another offer is not a normal price.
          { kind: "offer", chain_id: "rema1000", unit_price: 30, unit: "kg" },
        ],
      }),
      nearby,
    );
    expect(s).toEqual({
      kind: "saving",
      amount: 8,
      percent: 28,
      normalPrice: 28,
      normalChainId: "netto",
      basis: "shelf",
    });
  });

  it("uses Salling's EAN price anywhere, without a chain", () => {
    const s = offerSaving(
      offer({ references: [{ kind: "ean_reference", chain_id: "foetex", unit_price: 50 }] }),
      nearby,
    );
    expect(s).toMatchObject({ kind: "saving", amount: 5, normalChainId: null, basis: "ean" });
  });

  it("is unknown without a normal price, for a similar product or a shared price", () => {
    expect(offerSaving(offer({ references: [] }), nearby)).toEqual({ kind: "unknown" });
    expect(offerSaving(offer({ isExact: false }), nearby)).toEqual({ kind: "unknown" });
    expect(offerSaving(offer({ priceApplies: false }), nearby)).toEqual({ kind: "unknown" });
    expect(offerSaving(offer({ sizeMin: null, sizeMax: null }), nearby)).toEqual({
      kind: "unknown",
    });
    // A normal price in another unit is not comparable.
    expect(
      offerSaving(
        offer({ references: [{ kind: "regular", chain_id: "netto", unit_price: 9, unit: "stk" }] }),
        nearby,
      ),
    ).toEqual({ kind: "unknown" });
  });

  it("says when there is no saving", () => {
    expect(offerSaving(offer({ price: 30 }), nearby)).toMatchObject({
      kind: "none",
      normalPrice: 30,
    });
  });

  it("uses the smallest pack of a range and says when only bigger packs save", () => {
    // 250–400 g at 20 kr., normal 60 kr./kg: 15 kr. for 250 g (no saving), 24 kr. for 400 g.
    const s = offerSaving(offer({ sizeMin: 0.25, sizeMax: 0.4 }), nearby);
    expect(s).toEqual({ kind: "depends", maxAmount: 4, normalChainId: "rema1000", basis: "shelf" });
    // Saves even on the smallest pack: the smallest pack's saving is shown.
    expect(offerSaving(offer({ price: 10, sizeMin: 0.25, sizeMax: 0.4 }), nearby)).toMatchObject({
      kind: "saving",
      amount: 5,
    });
  });
});

describe("clearanceSaving", () => {
  it("saves against the price before the markdown", () => {
    expect(clearanceSaving({ price: 6, referencePrice: 11.95 })).toMatchObject({
      kind: "saving",
      amount: 5.95,
      percent: 49,
      basis: "before",
    });
    expect(clearanceSaving({ price: 6, referencePrice: null })).toEqual({ kind: "unknown" });
  });
});
