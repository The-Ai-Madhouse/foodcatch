import { describe, expect, it } from "vitest";
import { CHAIN_NAMES, CHAIN_STYLE, ETILBUDSAVIS_SLUGS, chainName, chainStyle } from "./chains";

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("chains", () => {
  it("has a style for every known chain with readable monograms (≥ 4.5:1)", () => {
    for (const chainId of Object.keys(CHAIN_NAMES)) {
      const style = CHAIN_STYLE[chainId];
      expect(style, chainId).toBeDefined();
      expect(contrast(style!.fill, style!.text), chainId).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("falls back to a neutral style and the initial", () => {
    expect(chainStyle("ukendt")).toEqual({
      fill: "var(--neutral-fg)",
      text: "var(--surface)",
      monogram: "U",
    });
    expect(chainName("ukendt")).toBe("ukendt");
  });

  it("knows the eTilbudsavis slugs, and none for Løvbjerg", () => {
    expect(ETILBUDSAVIS_SLUGS.foetex).toBe("fotex");
    expect(ETILBUDSAVIS_SLUGS.rema1000).toBe("REMA-1000");
    expect(ETILBUDSAVIS_SLUGS.loevbjerg).toBeUndefined();
  });
});
