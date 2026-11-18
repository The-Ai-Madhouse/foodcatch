import { describe, expect, it } from "vitest";
import { boundingBox, haversineKm, isValidCoordinate } from "./geo";

const RAADHUSPLADSEN = { lat: 55.6761, lon: 12.5683 };
const AARHUS_C = { lat: 56.1496, lon: 10.2045 };

describe("haversineKm", () => {
  it("is zero for the same point", () => {
    expect(haversineKm(55.6761, 12.5683, 55.6761, 12.5683)).toBe(0);
  });

  it("matches the known Copenhagen - Aarhus distance", () => {
    const d = haversineKm(RAADHUSPLADSEN.lat, RAADHUSPLADSEN.lon, AARHUS_C.lat, AARHUS_C.lon);
    expect(d).toBeCloseTo(156.6, 0);
  });

  it("is symmetric", () => {
    const ab = haversineKm(55.6761, 12.5683, 55.69, 12.55);
    const ba = haversineKm(55.69, 12.55, 55.6761, 12.5683);
    expect(ab).toBeCloseTo(ba, 10);
  });

  it("gives one degree of latitude as about 111.2 km", () => {
    expect(haversineKm(55, 12, 56, 12)).toBeCloseTo(111.19, 1);
  });
});

describe("boundingBox", () => {
  it("contains points at the radius in every direction", () => {
    const box = boundingBox(RAADHUSPLADSEN, 5);
    expect(
      haversineKm(RAADHUSPLADSEN.lat, RAADHUSPLADSEN.lon, box.maxLat, RAADHUSPLADSEN.lon),
    ).toBeCloseTo(5, 6);
    expect(
      haversineKm(RAADHUSPLADSEN.lat, RAADHUSPLADSEN.lon, RAADHUSPLADSEN.lat, box.maxLon),
    ).toBeGreaterThanOrEqual(4.99);
    expect(box.minLat).toBeLessThan(RAADHUSPLADSEN.lat);
    expect(box.minLon).toBeLessThan(RAADHUSPLADSEN.lon);
  });
});

describe("isValidCoordinate", () => {
  it("accepts Danish coordinates and rejects out-of-range values", () => {
    expect(isValidCoordinate(55.6761, 12.5683)).toBe(true);
    expect(isValidCoordinate(91, 12)).toBe(false);
    expect(isValidCoordinate(55, -181)).toBe(false);
    expect(isValidCoordinate(Number.NaN, 12)).toBe(false);
  });
});
