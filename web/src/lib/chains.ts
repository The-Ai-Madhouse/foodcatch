/**
 * Static facts about the chains seeded by the pipeline migration (`public.chain`): display
 * names, eTilbudsavis slugs (docs/ui.md §1.1) and the categorical map colours (docs/ui.md §4.3).
 *
 * Deal references only carry a `chain_id`; these maps give them a name and colour without an
 * extra query. Unknown ids fall back to the id itself and a neutral colour.
 */
export const CHAIN_NAMES: Readonly<Record<string, string>> = {
  netto: "Netto",
  rema1000: "REMA 1000",
  lidl: "Lidl",
  foetex: "føtex",
  bilka: "Bilka",
  "365discount": "365discount",
  superbrugsen: "SuperBrugsen",
  kvickly: "Kvickly",
  meny: "MENY",
  loevbjerg: "Løvbjerg",
  spar: "SPAR",
};

/**
 * The eTilbudsavis slug of each chain (`dealer.markets[].slug` in the Tjek payloads, each
 * verified with a 200 on `https://etilbudsavis.dk/{slug}`). Løvbjerg has none: no link until a
 * slug has been observed.
 */
export const ETILBUDSAVIS_SLUGS: Readonly<Record<string, string>> = {
  netto: "Netto",
  rema1000: "REMA-1000",
  lidl: "Lidl",
  foetex: "fotex",
  bilka: "Bilka",
  "365discount": "365discount",
  superbrugsen: "SuperBrugsen",
  kvickly: "Kvickly",
  meny: "MENY",
  spar: "SPAR",
};

export interface ChainStyle {
  /** Marker and dot fill. */
  fill: string;
  /** Monogram colour on the fill (at least 4.5:1). */
  text: string;
  /** Short letters shown on the fill, so colour is never the only cue. */
  monogram: string;
}

/**
 * Categorical chain colours, loosely inspired by the brands (which collide: most are blue, red
 * or yellow). Same fills in dark mode.
 */
export const CHAIN_STYLE: Readonly<Record<string, ChainStyle>> = {
  netto: { fill: "#F2C200", text: "#1a1a1a", monogram: "N" },
  rema1000: { fill: "#1B4F9C", text: "#ffffff", monogram: "R" },
  lidl: { fill: "#0A78B5", text: "#ffffff", monogram: "L" },
  foetex: { fill: "#5B3A9B", text: "#ffffff", monogram: "F" },
  bilka: { fill: "#0E7C7B", text: "#ffffff", monogram: "B" },
  "365discount": { fill: "#287D33", text: "#ffffff", monogram: "365" },
  superbrugsen: { fill: "#D0262E", text: "#ffffff", monogram: "SB" },
  kvickly: { fill: "#8C1C13", text: "#ffffff", monogram: "K" },
  meny: { fill: "#1F1F1F", text: "#ffffff", monogram: "M" },
  loevbjerg: { fill: "#D9621A", text: "#1a1a1a", monogram: "LØ" },
  spar: { fill: "#5E7F2A", text: "#ffffff", monogram: "S" },
};

/** The display name of a chain id. */
export function chainName(chainId: string): string {
  return CHAIN_NAMES[chainId] ?? chainId;
}

/** The colours and monogram of a chain; unknown chains get a neutral fill and their initial. */
export function chainStyle(chainId: string): ChainStyle {
  const known = CHAIN_STYLE[chainId];
  if (known) return known;
  const initial = chainName(chainId).trim().charAt(0).toLocaleUpperCase("da-DK") || "?";
  return { fill: "var(--neutral-fg)", text: "var(--surface)", monogram: initial };
}
