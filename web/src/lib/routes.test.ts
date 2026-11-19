import { describe, expect, it } from "vitest";
import { classKeyFromSegment, classPath, productKeyFromSegment, productPath } from "./routes";

const KEY = "hakket_grisekød|fedt=8-12%|øko=nej|forarbejdet=nej";

describe("classPath", () => {
  it("percent-encodes the class key", () => {
    expect(classPath(KEY)).toBe(
      "/vare/hakket_grisek%C3%B8d%7Cfedt%3D8-12%25%7C%C3%B8ko%3Dnej%7Cforarbejdet%3Dnej",
    );
  });
});

describe("classKeyFromSegment", () => {
  it("decodes an encoded segment exactly once", () => {
    const segment = classPath(KEY).slice("/vare/".length);
    expect(classKeyFromSegment(segment)).toBe(KEY);
  });

  it("accepts an already decoded segment (containing a literal %)", () => {
    expect(classKeyFromSegment(KEY)).toBe(KEY);
    expect(classKeyFromSegment("yoghurt|smag=naturel|fedt=1,5-3,5%")).toBe(
      "yoghurt|smag=naturel|fedt=1,5-3,5%",
    );
  });

  it("keeps plain keys and rejects blank or malformed segments", () => {
    expect(classKeyFromSegment("havregryn")).toBe("havregryn");
    expect(classKeyFromSegment("")).toBeNull();
    expect(classKeyFromSegment("%20")).toBeNull();
    expect(classKeyFromSegment("abc%E0%A4%A")).toBeNull();
  });
});

describe("productPath / productKeyFromSegment", () => {
  it("round-trips product keys", () => {
    for (const key of ["ean:5701234000011", "rema:400554", "offer:netto:hakket grisekød 8 12"]) {
      const segment = productPath(key).slice("/produkt/".length);
      expect(segment).not.toContain(":");
      expect(productKeyFromSegment(segment)).toBe(key);
      expect(productKeyFromSegment(key)).toBe(key);
    }
  });

  it("rejects segments that are not product keys", () => {
    expect(productKeyFromSegment("")).toBeNull();
    expect(productKeyFromSegment("havregryn")).toBeNull();
  });
});
