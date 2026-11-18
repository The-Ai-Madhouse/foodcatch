/**
 * Presentation logic for Netto deals: parsing `deal.references`, evaluating verdicts for the
 * user's nearby chains, grouping, filtering and Danish explanations. Pure and unit tested.
 */

import { formatUnitPrice, formatUnitPriceRange } from "./format";
import {
  REFERENCE_KINDS,
  type DealInput,
  type Reference,
  type ReferenceKind,
  type Verdict,
  type VerdictResult,
  referenceCounts,
  verdict,
} from "./verdict";

/** One row of `api.current_netto_deals`, with numbers parsed and names in camelCase. */
export interface DealRow {
  listingId: string;
  variantIndex: number;
  title: string;
  description: string;
  price: number;
  unit: string | null;
  unitPriceMin: number | null;
  unitPriceMax: number | null;
  validFrom: string;
  validTo: string | null;
  typeId: string;
  typeLabel: string;
  groupName: string;
  classKey: string;
  classLabel: string;
  isExact: boolean;
  notes: string[];
  /** Null until the pipeline has computed the deal. */
  priceApplies: boolean | null;
  nettoUnitPriceWorst: number | null;
  nettoUnitPriceBest: number | null;
  references: Reference[];
  /** Only members get this price (Netto+); shown with a "Medlemspris" badge. */
  memberOnly: boolean;
}

/** A deal's state as shown to the user: a verdict, or `pending` before the deal is computed. */
export type DealStatus = Verdict | "pending";

export interface EvaluatedDeal extends DealRow {
  status: DealStatus;
  result: VerdictResult | null;
}

export interface DealTypeGroup {
  typeId: string;
  typeLabel: string;
  deals: EvaluatedDeal[];
}

export interface DealGroup {
  groupName: string;
  types: DealTypeGroup[];
}

export type DealFilter = "gode" | "alle";

export type Tone = "good" | "bad" | "warn" | "neutral";

export interface StatusMeta {
  label: string;
  tone: Tone;
}

/** Badge text and tone per status (Danish UI). */
export const STATUS_META: Readonly<Record<DealStatus, StatusMeta>> = {
  good_deal: { label: "Godt køb", tone: "good" },
  cheaper_elsewhere: { label: "Billigere andetsteds", tone: "bad" },
  undecided: { label: "Uafklaret", tone: "warn" },
  no_reference: { label: "Ingen sammenligning", tone: "neutral" },
  not_exact: { label: "Ukendt egenskab", tone: "neutral" },
  ambiguous_offer: { label: "Flere varer i tilbuddet", tone: "neutral" },
  no_price: { label: "Ingen kilopris", tone: "neutral" },
  pending: { label: "Afventer beregning", tone: "neutral" },
};

/** Display order of statuses: the most useful first. */
const STATUS_RANK: Readonly<Record<DealStatus, number>> = {
  good_deal: 0,
  undecided: 1,
  cheaper_elsewhere: 2,
  no_reference: 3,
  not_exact: 4,
  ambiguous_offer: 5,
  no_price: 6,
  pending: 7,
};

export const REFERENCE_KIND_LABELS: Readonly<Record<ReferenceKind, string>> = {
  offer: "Tilbud",
  regular: "Normalpris",
  history: "Tidligere Netto-tilbud",
  ean_reference: "EAN-reference",
};

/** Product groups in shopping order; unknown groups follow alphabetically. */
const GROUP_ORDER = ["Kød", "Fisk", "Æg", "Mejeri", "Frugt og grønt", "Kolonial"];

const collator = new Intl.Collator("da-DK");

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const optionalString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/**
 * Validate the `references` JSON of a deal. Malformed elements are dropped rather than trusted:
 * a reference without a valid kind, chain or positive unit price cannot support a verdict.
 */
export function parseReferences(json: unknown): Reference[] {
  if (!Array.isArray(json)) return [];
  const refs: Reference[] = [];
  for (const item of json) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const kind = r.kind;
    const unitPrice = toNumber(r.unit_price);
    if (
      typeof kind !== "string" ||
      !(REFERENCE_KINDS as readonly string[]).includes(kind) ||
      typeof r.chain_id !== "string" ||
      unitPrice == null ||
      unitPrice <= 0
    ) {
      continue;
    }
    refs.push({
      kind: kind as ReferenceKind,
      chain_id: r.chain_id,
      unit_price: unitPrice,
      listing_id: optionalString(r.listing_id),
      title: optionalString(r.title),
      unit: optionalString(r.unit),
      valid_from: optionalString(r.valid_from),
      valid_to: optionalString(r.valid_to),
      member_only: r.member_only === true,
    });
  }
  return refs;
}

/** The verdict input of a row; null while the deal has not been computed. */
export function toDealInput(row: DealRow): DealInput | null {
  if (row.priceApplies == null) return null;
  return {
    netto_unit_price_worst: row.nettoUnitPriceWorst,
    netto_unit_price_best: row.nettoUnitPriceBest,
    price_applies: row.priceApplies,
    is_exact: row.isExact,
    references: row.references,
    member_only: row.memberOnly,
  };
}

/**
 * Every member-only Netto deal is shown as a member price: `DealCard` puts the
 * {@link memberPriceLabel} badge on it and {@link explainStatus} says so. That is the condition
 * under which the verdict may call a member price a good deal (architecture §6).
 */
const MEMBER_PRICES_ARE_MARKED = true;

const COOP_CHAINS: ReadonlySet<string> = new Set(["superbrugsen", "kvickly", "365discount"]);

/** The membership a chain's member prices need, in Danish (`Netto+`, `Coop-medlem`). */
export function membershipName(chainId: string): string | null {
  if (chainId === "netto") return "Netto+";
  if (COOP_CHAINS.has(chainId)) return "Coop-medlem";
  return null;
}

/** Badge text for a member price: `"Medlemspris (Netto+)"`, or `"Medlemspris"`. */
export function memberPriceLabel(chainId: string): string {
  const membership = membershipName(chainId);
  return membership ? `Medlemspris (${membership})` : "Medlemspris";
}

/** Evaluate every row for the chains near the user. */
export function evaluateDeals(
  rows: readonly DealRow[],
  nearbyChains: Iterable<string>,
): EvaluatedDeal[] {
  const nearby = new Set(nearbyChains);
  return rows.map((row) => {
    const input = toDealInput(row);
    const result = input
      ? verdict(input, nearby, { memberPriceMarked: MEMBER_PRICES_ARE_MARKED })
      : null;
    return { ...row, result, status: result ? result.verdict : "pending" };
  });
}

/** Keep only good deals (`gode`) or everything (`alle`). */
export function filterDeals(deals: readonly EvaluatedDeal[], filter: DealFilter): EvaluatedDeal[] {
  return filter === "gode" ? deals.filter((d) => d.status === "good_deal") : [...deals];
}

/** Parse the `?vis=` search parameter; good deals are the default. */
export function parseDealFilter(value: string | string[] | undefined): DealFilter {
  return value === "alle" ? "alle" : "gode";
}

function groupRank(name: string): number {
  const i = GROUP_ORDER.indexOf(name);
  return i === -1 ? GROUP_ORDER.length : i;
}

function compareDeals(a: EvaluatedDeal, b: EvaluatedDeal): number {
  const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
  if (rank !== 0) return rank;
  const pa = a.nettoUnitPriceWorst ?? a.unitPriceMax ?? Number.POSITIVE_INFINITY;
  const pb = b.nettoUnitPriceWorst ?? b.unitPriceMax ?? Number.POSITIVE_INFINITY;
  if (pa !== pb) return pa - pb;
  return collator.compare(a.title, b.title);
}

/** Group deals by product group, then by product type, in a stable, readable order. */
export function groupDeals(deals: readonly EvaluatedDeal[]): DealGroup[] {
  const groups = new Map<string, Map<string, DealTypeGroup>>();
  for (const deal of deals) {
    let types = groups.get(deal.groupName);
    if (!types) {
      types = new Map();
      groups.set(deal.groupName, types);
    }
    let type = types.get(deal.typeId);
    if (!type) {
      type = { typeId: deal.typeId, typeLabel: deal.typeLabel, deals: [] };
      types.set(deal.typeId, type);
    }
    type.deals.push(deal);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => groupRank(a) - groupRank(b) || collator.compare(a, b))
    .map(([groupName, types]) => ({
      groupName,
      types: [...types.values()]
        .map((t) => ({ ...t, deals: [...t.deals].sort(compareDeals) }))
        .sort((a, b) => collator.compare(a.typeLabel, b.typeLabel)),
    }));
}

/** Count deals per status. */
export function countByStatus(deals: readonly EvaluatedDeal[]): Record<DealStatus, number> {
  const counts = Object.fromEntries(Object.keys(STATUS_META).map((k) => [k, 0])) as Record<
    DealStatus,
    number
  >;
  for (const d of deals) counts[d.status] += 1;
  return counts;
}

/** "kilopris" / "literpris" / "stykpris" for a unit. */
export function unitPriceWord(unit: string | null | undefined): string {
  if (unit === "l") return "literpris";
  if (unit === "stk") return "stykpris";
  return "kilopris";
}

/** Danish explanation of a deal's status, plus a note when only members get the price. */
export function explainStatus(deal: EvaluatedDeal): string {
  const text = explainVerdict(deal);
  if (!deal.memberOnly) return text;
  return `${text} Prisen er en medlemspris og gælder kun med ${membershipName("netto")}.`;
}

function explainVerdict(deal: EvaluatedDeal): string {
  const word = unitPriceWord(deal.unit);
  const { result } = deal;
  const worst = deal.nettoUnitPriceWorst;
  const cheapest = result?.cheapest_unit_price;
  const fmt = (n: number) => formatUnitPrice(n, deal.unit);
  switch (deal.status) {
    case "good_deal":
      return `Nettos højeste ${word} (${fmt(worst ?? 0)}) er lig med eller lavere end den billigste sammenligning (${fmt(cheapest ?? 0)}).`;
    case "cheaper_elsewhere":
      return `Selv Nettos laveste ${word} (${fmt(deal.nettoUnitPriceBest ?? worst ?? 0)}) er højere end den billigste sammenligning (${fmt(cheapest ?? 0)}).`;
    case "undecided":
      return `Nettos ${word} (${formatUnitPriceRange(deal.nettoUnitPriceBest, worst, deal.unit) ?? "ukendt"}) afhænger af pakningen og overlapper den billigste sammenligning (${fmt(cheapest ?? 0)}).`;
    case "no_reference":
      return "Vi kender ingen pris på præcis samme vare i en butik inden for din radius eller fra Nettos egne tidligere tilbud.";
    case "not_exact":
      return "Tilbuddet oplyser ikke alle egenskaber, der afgør prisen (fx fedtprocent eller økologi), så vi sammenligner ikke.";
    case "ambiguous_offer":
      return `Tilbuddet dækker flere forskellige varer til samme pris, så ${word}en gælder ikke nødvendigvis denne vare.`;
    case "no_price":
      return `Tilbuddet oplyser ikke mængden, så vi kan ikke beregne en ${word}.`;
    case "pending":
      return "Sammenligningen er ikke beregnet endnu.";
  }
}

export interface ReferenceView extends Reference {
  /** Whether this reference counted for the verdict (nearby chain or location independent). */
  counts: boolean;
  /** Whether it is the cheapest counted reference. */
  isCheapest: boolean;
}

/** References sorted by unit price, annotated with whether they counted for this user. */
export function referenceViews(
  deal: EvaluatedDeal,
  nearbyChains: ReadonlySet<string>,
): ReferenceView[] {
  const cheapest = deal.result?.cheapest_unit_price ?? null;
  let cheapestMarked = false;
  return [...deal.references]
    .sort((a, b) => a.unit_price - b.unit_price)
    .map((ref) => {
      const counts = referenceCounts(ref, nearbyChains);
      const isCheapest =
        counts && !cheapestMarked && cheapest != null && ref.unit_price === cheapest;
      if (isCheapest) cheapestMarked = true;
      return { ...ref, counts, isCheapest };
    });
}
