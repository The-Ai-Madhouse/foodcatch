import { describe, expect, it } from "vitest";
import {
  copenhagenParts,
  displayEnd,
  formatDate,
  formatDateTime,
  formatDayDate,
  formatDistance,
  formatDkk,
  formatNumber,
  formatPercent,
  formatPeriod,
  formatRelative,
  formatUnitPrice,
  formatUnitPriceRange,
  daysFromToday,
  displayTitle,
  formatClock,
  formatEnd,
  formatMonth,
  formatPackSize,
  formatQuantity,
  formatShortPeriod,
  formatStock,
  packSize,
  parseRemaSize,
} from "./format";

// Tests compare with plain spaces; the formatter uses non-breaking spaces.
const plain = (s: string | null): string | null => (s == null ? s : s.replace(/ /g, " "));

describe("money and numbers", () => {
  it("formats DKK with Danish separators", () => {
    expect(plain(formatDkk(33.33))).toBe("33,33 kr.");
    expect(plain(formatDkk(25))).toBe("25,00 kr.");
    expect(plain(formatDkk(1234.5))).toBe("1.234,50 kr.");
    expect(plain(formatDkk(0.005))).toBe("0,01 kr.");
  });

  it("keeps amount and currency together with a non-breaking space", () => {
    expect(formatDkk(10)).toBe("10,00 kr.");
  });

  it("formats numbers with a chosen number of decimals", () => {
    expect(formatNumber(1.25, 1)).toBe("1,3");
    expect(formatNumber(1000, 0)).toBe("1.000");
  });

  it("formats unit prices per unit", () => {
    expect(plain(formatUnitPrice(33.333, "kg"))).toBe("33,33 kr./kg");
    expect(plain(formatUnitPrice(12.95, "l"))).toBe("12,95 kr./l");
    expect(plain(formatUnitPrice(2.5, "stk"))).toBe("2,50 kr./stk.");
    expect(plain(formatUnitPrice(2.5, null))).toBe("2,50 kr./enhed");
  });

  it("formats unit-price ranges and collapses equal ends", () => {
    expect(plain(formatUnitPriceRange(33.333, 41.667, "kg"))).toBe("33,33–41,67 kr./kg");
    expect(plain(formatUnitPriceRange(33.331, 33.334, "kg"))).toBe("33,33 kr./kg");
    expect(plain(formatUnitPriceRange(null, 20, "l"))).toBe("20,00 kr./l");
    expect(formatUnitPriceRange(null, null, "kg")).toBeNull();
  });

  it("formats percentages and distances", () => {
    expect(plain(formatPercent(45.5))).toBe("46 %");
    expect(plain(formatPercent(45.55, 1))).toBe("45,6 %");
    expect(plain(formatDistance(0.347))).toBe("350 m");
    expect(plain(formatDistance(0.001))).toBe("10 m");
    expect(plain(formatDistance(1.24))).toBe("1,2 km");
  });
});

describe("dates in Europe/Copenhagen", () => {
  it("converts UTC instants to Copenhagen wall-clock time (winter, UTC+1)", () => {
    // 23:30 UTC on 19 Nov is already 20 Nov in Copenhagen.
    expect(copenhagenParts("2026-11-19T23:30:00Z")).toEqual({
      year: 2026,
      month: 11,
      day: 20,
      weekday: 5,
      hour: 0,
      minute: 30,
    });
  });

  it("handles summer time (UTC+2)", () => {
    expect(plain(formatDateTime("2026-07-01T10:05:00Z"))).toBe("1. jul. 2026 kl. 12.05");
  });

  it("formats dates with and without year", () => {
    expect(formatDate("2026-11-20T08:00:00Z")).toBe("20. nov. 2026");
    expect(formatDate(new Date("2026-05-03T08:00:00Z"), { withYear: false })).toBe("3. maj");
  });

  it("formats dates with weekday", () => {
    expect(formatDayDate("2026-11-19T23:00:00Z")).toBe("fre. 20. nov.");
    expect(formatDayDate("2026-11-23T12:00:00Z")).toBe("man. 23. nov.");
  });

  it("formats validity periods", () => {
    expect(formatPeriod("2026-11-18T23:00:00Z", "2026-11-25T22:59:59Z")).toBe(
      "tors. 19. nov. – ons. 25. nov.",
    );
    expect(formatPeriod("2026-11-18T23:00:00Z", null)).toBe("fra tors. 19. nov.");
    expect(formatPeriod(null, "2026-11-25T22:59:59Z")).toBe("til ons. 25. nov.");
    expect(formatPeriod(null, null)).toBe("ukendt periode");
  });

  it("shows an exclusive end at Copenhagen midnight as the day before", () => {
    // regression: a Rema campaign ending Saturday 21 Nov is stored as Sunday 00:00 Copenhagen
    expect(formatPeriod("2026-11-15T23:00:00Z", "2026-11-21T23:00:00Z")).toBe(
      "man. 16. nov. – lør. 21. nov.",
    );
    expect(formatPeriod(null, "2026-11-21T23:00:00Z")).toBe("til lør. 21. nov.");
    // summer time: midnight is 22:00 UTC
    expect(formatDate(displayEnd("2026-07-11T22:00:00Z"))).toBe("11. jul. 2026");
    // a Tjek inclusive end and other times are unchanged
    expect(displayEnd("2026-11-20T22:59:59Z").toISOString()).toBe("2026-11-20T22:59:59.000Z");
    expect(displayEnd("2026-11-21T23:00:01Z").toISOString()).toBe("2026-11-21T23:00:01.000Z");
    expect(formatPeriod("2026-11-13T23:00:00Z", "2026-11-20T22:59:59Z")).toBe(
      "lør. 14. nov. – fre. 20. nov.",
    );
  });

  it("rejects invalid dates", () => {
    expect(() => formatDate("not a date")).toThrow(RangeError);
  });
});

describe("formatRelative", () => {
  const now = new Date("2026-11-18T12:00:00Z");

  it("describes the past", () => {
    expect(formatRelative("2026-11-18T11:59:30Z", now)).toBe("lige nu");
    expect(formatRelative("2026-11-18T11:59:00Z", now)).toBe("for 1 minut siden");
    expect(formatRelative("2026-11-18T11:15:00Z", now)).toBe("for 45 minutter siden");
    expect(formatRelative("2026-11-18T09:00:00Z", now)).toBe("for 3 timer siden");
    expect(formatRelative("2026-11-17T11:00:00Z", now)).toBe("for 1 dag siden");
    expect(formatRelative("2026-11-10T12:00:00Z", now)).toBe("for 8 dage siden");
  });

  it("describes the future", () => {
    expect(formatRelative("2026-11-20T12:00:00Z", now)).toBe("om 2 dage");
    expect(formatRelative("2026-11-18T13:00:00Z", now)).toBe("om 1 time");
  });
});

describe("formatQuantity", () => {
  it("shows grams and millilitres below 1 kg / 1 l", () => {
    expect(plain(formatQuantity(0.3, 0.3, "kg"))).toBe("300 g");
    expect(plain(formatQuantity(0.25, 0.4, "kg"))).toBe("250–400 g");
    expect(plain(formatQuantity(0.5, 0.5, "l"))).toBe("500 ml");
    expect(plain(formatQuantity(0.25, 0.33, "l"))).toBe("250–330 ml");
  });

  it("shows kg and l from 1 with up to three decimals", () => {
    expect(plain(formatQuantity(1, 1, "kg"))).toBe("1 kg");
    expect(plain(formatQuantity(0.8, 1.45, "kg"))).toBe("0,8–1,45 kg");
    expect(plain(formatQuantity(1.5, 1.5, "l"))).toBe("1,5 l");
    expect(plain(formatQuantity(1.2345, 1.2345, "kg"))).toBe("1,235 kg");
  });

  it("shows pieces", () => {
    expect(plain(formatQuantity(8, 8, "stk"))).toBe("8 stk.");
    expect(plain(formatQuantity(6, 10, "stk"))).toBe("6–10 stk.");
  });

  it("collapses equal ends and fills a missing end", () => {
    expect(plain(formatQuantity(0.3, null, "kg"))).toBe("300 g");
    expect(plain(formatQuantity(0.3001, 0.2999, "kg"))).toBe("300 g");
  });

  it("returns null without a usable size", () => {
    expect(formatQuantity(null, null, "kg")).toBeNull();
    expect(formatQuantity(0, 0, "kg")).toBeNull();
    expect(formatQuantity(1, 1, null)).toBeNull();
    expect(formatQuantity(Number.NaN, 1, "kg")).toBeNull();
  });
});

describe("packSize", () => {
  const tjek = { unit: "kg", sizeMin: 0.3, sizeMax: 0.3, source: "tjek" };

  it("uses the size the source states", () => {
    expect(plain(formatPackSize(tjek))).toBe("300 g");
    expect(packSize(tjek).origin).toBe("source");
  });

  it("parses REMA 1000's description, else marks the computed size as approximate", () => {
    expect(parseRemaSize("400 GR. / REMA 1000")).toBe("400\u00a0g");
    expect(plain(parseRemaSize("1 LTR. / GRAM SLOT, ØKOLOGISK"))).toBe("1 l");
    expect(plain(parseRemaSize("1 KG. / YOGGI"))).toBe("1 kg");
    expect(plain(parseRemaSize("33 CL / FAXE"))).toBe("330 ml");
    expect(plain(parseRemaSize("10 STK. / HEDEGAARD"))).toBe("10 stk.");
    expect(plain(parseRemaSize("1,5 KG / X"))).toBe("1,5 kg");
    expect(parseRemaSize("6 X 330 ML / FAXE")).toBeNull();
    expect(parseRemaSize("2 MTR. / X")).toBeNull();
    expect(parseRemaSize(null)).toBeNull();

    const rema = { unit: "kg", sizeMin: 0.28498, sizeMax: 0.28498, source: "rema" };
    expect(plain(formatPackSize({ ...rema, description: "285 GR. / EASIS" }))).toBe("285 g");
    expect(packSize({ ...rema, description: "285 GR. / EASIS" }).origin).toBe("description");
    expect(plain(formatPackSize({ ...rema, description: "SÆT / X" }))).toBe("ca. 285 g");
    expect(packSize({ ...rema, description: null }).origin).toBe("computed");
  });

  const waste = {
    unit: null,
    sizeMin: null,
    sizeMax: null,
    source: "salling_food_waste",
    stockUnit: "each",
  };

  it("uses a food-waste size from the Salling name first", () => {
    expect(plain(formatPackSize({ ...waste, unit: "kg", sizeMin: 0.25, sizeMax: 0.25 }))).toBe(
      "250 g",
    );
  });

  it("says when the weight varies, whatever Open Food Facts says", () => {
    expect(
      formatPackSize({ ...waste, stockUnit: "kg", offNetQuantity: 0.5, offNetUnit: "kg" }),
    ).toBe("Vægt varierer");
  });

  it("falls back to Open Food Facts, marked as such", () => {
    const off = packSize({ ...waste, offNetQuantity: 1, offNetUnit: "kg" });
    expect(plain(off.text)).toBe("1 kg ifølge Open Food Facts");
    expect(off.origin).toBe("off");
    expect(formatPackSize({ ...waste, offQuantityText: "4 x 125 g" })).toBe(
      "4 x 125 g ifølge Open Food Facts",
    );
  });

  it("never guesses", () => {
    expect(packSize(waste)).toEqual({ text: "Vægt ukendt", origin: "unknown" });
    expect(packSize({ unit: "kg", sizeMin: null, sizeMax: null, source: "tjek" }).text).toBe(
      "Vægt ukendt",
    );
  });
});

describe("displayTitle", () => {
  it("puts shouted names in sentence case", () => {
    expect(displayTitle("HK GRIS 3-7% MESTERHAKKET")).toBe("Hk gris 3-7% mesterhakket");
    expect(displayTitle("ØKO FRAICHE 9% LØGISMOSE")).toBe("Øko fraiche 9% løgismose");
  });

  it("keeps names that already use lower case", () => {
    expect(displayTitle("Øko yoghurt naturel Løgismose")).toBe("Øko yoghurt naturel Løgismose");
  });
});

describe("clearance dates", () => {
  const now = new Date("2026-11-18T12:00:00Z");

  it("counts Copenhagen calendar days", () => {
    expect(daysFromToday("2026-11-18T22:59:00Z", now)).toBe(0);
    expect(daysFromToday("2026-11-18T23:30:00Z", now)).toBe(1);
    expect(daysFromToday("2026-11-17T12:00:00Z", now)).toBe(-1);
  });

  it("says today, tomorrow or the day, and the time only when it is not the end of the day", () => {
    expect(formatEnd("2026-11-18T22:59:00Z", now)).toBe("til i dag");
    expect(formatEnd("2026-11-18T22:59:59Z", now)).toBe("til i dag");
    expect(formatEnd("2026-11-19T22:59:59Z", now)).toBe("til i morgen");
    expect(formatEnd("2026-11-21T22:59:59Z", now)).toBe("til lør. 21. nov.");
    expect(plain(formatEnd("2026-11-18T17:00:00Z", now))).toBe("til i dag kl. 18.00");
    // An exclusive end at Copenhagen midnight is the end of the day before.
    expect(formatEnd("2026-11-19T23:00:00Z", now)).toBe("til i morgen");
  });

  it("formats the clock and the month", () => {
    expect(formatClock("2026-11-18T12:37:00Z")).toBe("13.37");
    expect(formatMonth("2026-11-01T00:30:00Z")).toBe("november 2026");
  });

  it("formats stock", () => {
    expect(plain(formatStock(1, "each"))).toBe("1 stk. tilbage");
    expect(plain(formatStock(1.96, "kg"))).toBe("1,96 kg tilbage");
    expect(formatStock(null, "each")).toBeNull();
  });
});

describe("formatShortPeriod", () => {
  it("shortens a period within one month", () => {
    expect(formatShortPeriod("2026-11-13T23:00:00Z", "2026-11-20T22:59:59Z")).toBe(
      "lør. 14.–fre. 20. nov.",
    );
  });

  it("spells out both months across a month", () => {
    expect(formatShortPeriod("2026-11-27T23:00:00Z", "2026-12-04T22:59:59Z")).toBe(
      "lør. 28. nov.–fre. 4. dec.",
    );
  });

  it("handles one day and open ends", () => {
    expect(formatShortPeriod("2026-11-17T23:00:00Z", "2026-11-18T22:59:59Z")).toBe("ons. 18. nov.");
    expect(formatShortPeriod("2026-11-17T23:00:00Z", null)).toBe("fra ons. 18. nov.");
  });
});
