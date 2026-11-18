/**
 * Presentation logic for Netto deals: parsing `deal.references`, evaluating verdicts for the
 * user's nearby chains, one card per listing (variants inside), grouping, filtering and the
 * one-line Danish reasons (docs/ui.md §5.2 and §5.6). Pure and unit tested.
 */

import { chainName } from "./chains";
import { formatDistance, formatUnitPrice } from "./format";
import {
  REFERENCE_KINDS,
  type DealInput,
  type Reference,
  type ReferenceKind,
  type Verdict,
  type VerdictResult,
  LOCATION_INDEPENDENT_KINDS,
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
  /** Only members get this price (Netto+); shown with a "Kræver Netto+" badge. */
  memberOnly: boolean;
  /** Listing source (`tjek`). */
  source: string | null;
  /** Tjek offer id (eTilbudsavis `offer=`). */
  sourceItemId: string | null;
  /** Tjek catalog id (eTilbudsavis `publication=`). */
  catalogId: string | null;
  /** Pack size range in `unit`. */
  sizeMin: number | null;
  sizeMax: number | null;
  maxPerCustomer: number | null;
}

/** A deal's state as shown to the user: a verdict, or `pending` before the deal is computed. */
export type DealStatus = Verdict | "pending";

export interface EvaluatedDeal extends DealRow {
  status: DealStatus;
  result: VerdictResult | null;
}

export type DealFilter = "gode" | "alle";

export type Tone = "good" | "bad" | "warn" | "neutral";

export interface StatusMeta {
  label: string;
  tone: Tone;
}

/** Badge text and tone per status. Only the two decisive verdicts get a colour. */
export const STATUS_META: Readonly<Record<DealStatus, StatusMeta>> = {
  good_deal: { label: "Godt køb", tone: "good" },
  cheaper_elsewhere: { label: "Billigere andetsteds", tone: "bad" },
  undecided: { label: "Uafklaret", tone: "neutral" },
  no_reference: { label: "Ingen sammenligning", tone: "neutral" },
  not_exact: { label: "Ukendt egenskab", tone: "neutral" },
  ambiguous_offer: { label: "Flere varer", tone: "neutral" },
  no_price: { label: "Ingen kilopris", tone: "neutral" },
  pending: { label: "Beregnes", tone: "neutral" },
};

/** Display order of statuses: the most useful first. */
export const STATUS_RANK: Readonly<Record<DealStatus, number>> = {
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
  ean_reference: "EAN-pris",
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
 * Every member-only Netto deal is shown as a member price: the deal card puts the
 * {@link memberPriceLabel} badge next to the verdict and the verdict badge reads "Godt køb med
 * Netto+" ({@link verdictBadgeLabel}). That is the condition under which the verdict may call a
 * member price a good deal (architecture §6).
 */
const MEMBER_PRICES_ARE_MARKED = true;

const COOP_CHAINS: ReadonlySet<string> = new Set(["superbrugsen", "kvickly", "365discount"]);

/** The membership a chain's member prices need, in Danish (`Netto+`, `Coop-medlem`). */
export function membershipName(chainId: string): string | null {
  if (chainId === "netto") return "Netto+";
  if (COOP_CHAINS.has(chainId)) return "Coop-medlem";
  return null;
}

/** Badge text for a member-only Netto price: `"Kræver Netto+"`. */
export function memberPriceLabel(chainId: string): string {
  const membership = membershipName(chainId);
  return membership ? `Kræver ${membership}` : "Medlemspris";
}

/** The verdict badge text; a marked member price reads "Godt køb med Netto+". */
export function verdictBadgeLabel(status: DealStatus, memberOnly: boolean): string {
  if (status === "good_deal" && memberOnly) return `Godt køb med ${membershipName("netto")}`;
  return STATUS_META[status].label;
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

/** Parse the `?vis=` search parameter; good deals are the default. */
export function parseDealFilter(value: string | string[] | undefined): DealFilter {
  return value === "alle" ? "alle" : "gode";
}

/**
 * A class label without the attributes the matcher could not determine (parts ending in "?"):
 * `"Kyllingebryst(filet), tilsat vand?"` -> `"Kyllingebryst(filet)"`.
 */
export function cleanClassLabel(label: string): string {
  const parts = label
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p && !p.endsWith("?"));
  return parts.join(", ") || label.trim();
}

/** One Netto offer (listing) with its recognised variants, best verdict first. */
export interface ListingDeal {
  listingId: string;
  /** The first variant; carries the listing's own fields (title, price, size, period, source). */
  offer: EvaluatedDeal;
  variants: EvaluatedDeal[];
  /** The best status of any variant. */
  status: DealStatus;
  groupName: string;
}

function compareVariants(a: EvaluatedDeal, b: EvaluatedDeal): number {
  return STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.variantIndex - b.variantIndex;
}

/** One entry per listing, its variants sorted best verdict first. */
export function groupByListing(deals: readonly EvaluatedDeal[]): ListingDeal[] {
  const byListing = new Map<string, EvaluatedDeal[]>();
  for (const deal of deals) {
    const list = byListing.get(deal.listingId);
    if (list) list.push(deal);
    else byListing.set(deal.listingId, [deal]);
  }
  return [...byListing.entries()].map(([listingId, list]) => {
    const variants = [...list].sort(compareVariants);
    const best = variants[0] as EvaluatedDeal;
    const offer = [...list].sort((a, b) => a.variantIndex - b.variantIndex)[0] as EvaluatedDeal;
    return { listingId, offer, variants, status: best.status, groupName: best.groupName };
  });
}

/** Keep listings with a good deal (`gode`) or everything (`alle`). */
export function filterListings(
  listings: readonly ListingDeal[],
  filter: DealFilter,
): ListingDeal[] {
  return filter === "gode" ? listings.filter((l) => l.status === "good_deal") : [...listings];
}

export interface ListingGroup {
  groupName: string;
  listings: ListingDeal[];
}

function groupRank(name: string): number {
  const i = GROUP_ORDER.indexOf(name);
  return i === -1 ? GROUP_ORDER.length : i;
}

function compareListings(a: ListingDeal, b: ListingDeal): number {
  return (
    STATUS_RANK[a.status] - STATUS_RANK[b.status] || collator.compare(a.offer.title, b.offer.title)
  );
}

/** Listings by product group in shopping order; within a group by verdict, then title. */
export function groupListings(listings: readonly ListingDeal[]): ListingGroup[] {
  const groups = new Map<string, ListingDeal[]>();
  for (const listing of listings) {
    const list = groups.get(listing.groupName);
    if (list) list.push(listing);
    else groups.set(listing.groupName, [listing]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => groupRank(a) - groupRank(b) || collator.compare(a, b))
    .map(([groupName, list]) => ({ groupName, listings: [...list].sort(compareListings) }));
}

/** "kilopris" / "literpris" / "stykpris" for a unit. */
export function unitPriceWord(unit: string | null | undefined): string {
  if (unit === "l") return "literpris";
  if (unit === "stk") return "stykpris";
  return "kilopris";
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

/** The cheapest reference that counted for the verdict, or null. */
export function cheapestReference(
  deal: EvaluatedDeal,
  nearbyChains: ReadonlySet<string>,
): ReferenceView | null {
  return referenceViews(deal, nearbyChains).find((r) => r.isCheapest) ?? null;
}

/** Distance (km) to the nearest store of a chain within the radius, or null. */
export type NearestDistance = (chainId: string) => number | null;

const FIXED_REASONS: Readonly<Partial<Record<DealStatus, string>>> = {
  no_reference: "Ingen butik i nærheden har præcis samme vare.",
  not_exact: "Tilbuddet oplyser ikke alle egenskaber (fx fedtprocent).",
  ambiguous_offer: "Prisen dækker flere forskellige varer.",
  no_price: "Kilden oplyser ikke vægten.",
  pending: "Sammenligningen er ikke beregnet endnu.",
};

/**
 * The one-line reason under a deal's badge (docs/ui.md §5.2), naming the cheapest counted
 * reference and the distance to that chain's nearest store.
 */
export function verdictReason(
  deal: EvaluatedDeal,
  nearbyChains: ReadonlySet<string>,
  nearestKm: NearestDistance,
): string {
  const fixed = FIXED_REASONS[deal.status];
  if (fixed) return fixed;
  const ref = cheapestReference(deal, nearbyChains);
  if (!ref) return FIXED_REASONS.no_reference as string;
  const price = formatUnitPrice(ref.unit_price, ref.unit ?? deal.unit);
  const pastNetto = ref.kind === "history";
  const who =
    ref.kind === "ean_reference"
      ? `${chainName(ref.chain_id)} (EAN-pris)`
      : chainName(ref.chain_id);
  const km = LOCATION_INDEPENDENT_KINDS.has(ref.kind) ? null : nearestKm(ref.chain_id);
  const where = km == null ? "" : ` (${formatDistance(km)})`;
  switch (deal.status) {
    case "good_deal":
      return pastNetto
        ? `Billigst i nærheden. Nettos tidligere tilbud: ${price}`
        : `Billigst i nærheden. Næstbedst: ${who} ${price}`;
    case "cheaper_elsewhere":
      return pastNetto
        ? `Netto havde den til ${price} i et tidligere tilbud.`
        : `${who} har den til ${price}${where}`;
    default:
      return pastNetto
        ? `Afhænger af pakningen – Netto havde den til ${price} i et tidligere tilbud`
        : `Afhænger af pakningen – ${who} har ${price}${where}`;
  }
}

/** Pack size, pack price and source ids of a reference's listing (`api.class_price_history`). */
export interface ReferenceDetail {
  listingId: string;
  source: string | null;
  sourceItemId: string | null;
  catalogId: string | null;
  chainId: string;
  price: number | null;
  description: string | null;
  unit: string | null;
  sizeMin: number | null;
  sizeMax: number | null;
  validTo: string | null;
}

/** Listing ids of every reference of the given deals (for one detail query per page). */
export function referenceListingIds(deals: readonly DealRow[]): string[] {
  const ids = new Set<string>();
  for (const deal of deals) {
    for (const ref of deal.references) if (ref.listing_id) ids.add(ref.listing_id);
  }
  return [...ids];
}

/** A compared Netto offer that another chain has cheaper (or possibly cheaper). */
export interface CheaperElsewhere {
  deal: EvaluatedDeal;
  /** The cheapest counted reference, from the chain that has it cheaper. */
  ref: ReferenceView;
}

/**
 * This week's compared Netto offers per competing chain (docs/ui.md §6.3 "Billigere her end i
 * Netto"): deals whose verdict is `cheaper_elsewhere` or `undecided` and whose cheapest counted
 * reference is a price from that chain (Netto's own past offers are not "here"). Clearly cheaper
 * offers first, then by title.
 */
export function cheaperByChain(
  deals: readonly EvaluatedDeal[],
  nearbyChains: ReadonlySet<string>,
): Map<string, CheaperElsewhere[]> {
  const byChain = new Map<string, CheaperElsewhere[]>();
  const seen = new Set<string>();
  for (const deal of deals) {
    if (deal.status !== "cheaper_elsewhere" && deal.status !== "undecided") continue;
    const ref = cheapestReference(deal, nearbyChains);
    if (!ref || LOCATION_INDEPENDENT_KINDS.has(ref.kind) || ref.chain_id === "netto") continue;
    const key = `${ref.chain_id}|${deal.listingId}|${ref.listing_id ?? ref.unit_price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = byChain.get(ref.chain_id);
    const entry = { deal, ref };
    if (list) list.push(entry);
    else byChain.set(ref.chain_id, [entry]);
  }
  for (const list of byChain.values()) {
    list.sort(
      (a, b) =>
        Number(a.deal.status !== "cheaper_elsewhere") -
          Number(b.deal.status !== "cheaper_elsewhere") ||
        collator.compare(a.deal.title, b.deal.title),
    );
  }
  return byChain;
}
