/**
 * Display names of the chains seeded by the pipeline migration (`public.chain`).
 *
 * Deal references only carry a `chain_id`; this map gives them a name without an extra query.
 * Unknown ids fall back to the id itself.
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

/** The display name of a chain id. */
export function chainName(chainId: string): string {
  return CHAIN_NAMES[chainId] ?? chainId;
}
