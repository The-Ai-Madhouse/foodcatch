import { describe, expect, it } from "vitest";
import {
  copenhagenParts,
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
