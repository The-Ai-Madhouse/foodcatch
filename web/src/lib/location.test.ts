import { describe, expect, it } from "vitest";
import {
  DEFAULT_RADIUS_KM,
  FALLBACK_COORDINATES,
  clampRadius,
  defaultLocation,
  parseCoordinates,
  parseLocationCookie,
  parseStoredLocation,
  sameStoredLocation,
  serializeLocation,
  toStoredLocation,
  type StoredLocation,
} from "./location";

describe("parseCoordinates", () => {
  it("parses lat,lon", () => {
    expect(parseCoordinates("55.6761,12.5683")).toEqual({ lat: 55.6761, lon: 12.5683 });
    expect(parseCoordinates(" 56.15 , 10.2 ")).toEqual({ lat: 56.15, lon: 10.2 });
  });

  it("rejects malformed or out-of-range values", () => {
    for (const bad of ["", "55.6", "a,b", "55,12,1", "95,12", "55,190", "1e3,2", null]) {
      expect(parseCoordinates(bad)).toBeNull();
    }
  });
});

describe("clampRadius", () => {
  it("clamps to 1-5 km and rounds", () => {
    expect(clampRadius(0)).toBe(1);
    expect(clampRadius(9)).toBe(5);
    expect(clampRadius("3")).toBe(3);
    expect(clampRadius(2.4)).toBe(2);
    expect(clampRadius("x")).toBe(DEFAULT_RADIUS_KM);
  });
});

describe("defaultLocation", () => {
  it("uses the configured coordinates", () => {
    expect(defaultLocation("56.1496,10.2045")).toMatchObject({
      lat: 56.1496,
      lon: 10.2045,
      isDefault: true,
      radiusKm: DEFAULT_RADIUS_KM,
    });
  });

  it("falls back to Copenhagen when unset or invalid", () => {
    expect(defaultLocation(undefined)).toMatchObject(FALLBACK_COORDINATES);
    expect(defaultLocation("nonsense")).toMatchObject(FALLBACK_COORDINATES);
  });
});

describe("location cookie", () => {
  it("round-trips", () => {
    const value = serializeLocation({
      lat: 55.6812345,
      lon: 12.5291234,
      label: "Nørrebrogade 10, København N",
      radiusKm: 3,
    });
    expect(parseLocationCookie(value)).toEqual({
      lat: 55.68123,
      lon: 12.52912,
      label: "Nørrebrogade 10, København N",
      radiusKm: 3,
      isDefault: false,
    });
  });

  it("sanitizes labels and clamps the radius", () => {
    const parsed = parseLocationCookie(
      JSON.stringify({ lat: 55, lon: 12, label: "  a\u0000b  " + "x".repeat(300), r: 42 }),
    );
    expect(parsed?.radiusKm).toBe(5);
    expect(parsed?.label.startsWith("a b x")).toBe(true);
    expect(parsed?.label.length).toBe(120);
  });

  it("returns null for invalid cookies", () => {
    for (const bad of [
      undefined,
      "",
      "{",
      "null",
      "[]",
      '{"lat":"55","lon":12}',
      '{"lat":99,"lon":12}',
    ]) {
      expect(parseLocationCookie(bad)).toBeNull();
    }
  });
});

describe("stored location (localStorage backup)", () => {
  const entry = {
    lat: 55.6894,
    lon: 12.5541,
    label: "Nørrebrogade 10, 2200 København N",
    r: 3,
    savedAt: "2026-11-18T12:00:00.000Z",
  };

  it("parses a JSON string or an object", () => {
    expect(parseStoredLocation(JSON.stringify(entry))).toEqual(entry);
    expect(parseStoredLocation(entry)).toEqual(entry);
  });

  it("applies the cookie's rules", () => {
    expect(parseStoredLocation({ ...entry, r: 9 })?.r).toBe(5);
    expect(parseStoredLocation({ ...entry, savedAt: "nonsense" })?.savedAt).toBe(
      "1970-01-01T00:00:00.000Z",
    );
    for (const bad of [null, "", "{", "[]", 42, { ...entry, lat: 99 }, { ...entry, lon: "12" }]) {
      expect(parseStoredLocation(bad)).toBeNull();
    }
  });

  it("round-trips a location and compares without the time", () => {
    const stored = toStoredLocation(
      { lat: 55.68940123, lon: 12.55410123, label: entry.label, radiusKm: 3 },
      new Date(entry.savedAt),
    );
    expect(stored).toEqual(entry);
    const later: StoredLocation = { ...entry, savedAt: "2027-01-01T00:00:00.000Z" };
    expect(sameStoredLocation(stored, later)).toBe(true);
    expect(sameStoredLocation(stored, { ...entry, r: 2 })).toBe(false);
    expect(sameStoredLocation(null, null)).toBe(true);
    expect(sameStoredLocation(stored, null)).toBe(false);
  });
});
