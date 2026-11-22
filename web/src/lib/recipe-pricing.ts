/**
 * What a recipe from any website costs near the user (docs/ui.md §27): per store (each chain
 * with a store nearby) and "billigst kombineret" (each ingredient where it is cheapest). Every
 * price is a real current product (offer, shelf price or clearance); an ingredient we cannot
 * find is listed as missing, never estimated. Pure and unit tested.
 */
import type { IngredientMatch, ParsedIngredient } from "./ingredient-match";
import {
  PANTRY_SPECS,
  cheapest,
  matchesSpec,
  priceFor,
  type BuyableProduct,
  type FoundPrice,
  type ProductSpec,
} from "./pantry";
import { toOre } from "./verdict";

export interface RecipeItem {
  id: string;
  parsed: ParsedIngredient;
  match: IngredientMatch;
}

export interface QuoteLine {
  id: string;
  line: string;
  found: FoundPrice | null;
  /**
   * True when the amount could not be compared with the pack (no amount in the recipe, or units
   * that do not convert): the price is then one pack.
   */
  onePack: boolean;
}

export interface Quote {
  /** The chain, or null for "billigst kombineret". */
  chainId: string | null;
  lines: QuoteLine[];
  /** What the found items cost (kr.). */
  totalKr: number;
  missing: number;
  /** Chains the items come from. */
  chains: string[];
}

const roundKr = (value: number): number => toOre(value) / 100;

const typeOf = (classKey: string | null): string | null => classKey?.split("|")[0]?.trim() || null;

function specOf(match: IngredientMatch): ProductSpec | null {
  if (match.kind === "spec") return PANTRY_SPECS[match.specName] ?? null;
  if (match.kind === "text") return match.spec;
  return null;
}

/** Whether a product is the ingredient. */
export function productMatches(product: BuyableProduct, match: IngredientMatch): boolean {
  if (match.kind === "type") {
    const t = typeOf(product.classKey);
    return t != null && match.types.includes(t);
  }
  const spec = specOf(match);
  return spec != null && matchesSpec(product.label, spec);
}

/** The price of one product for an item: the packs that cover it, else one pack. */
function priceItem(
  product: BuyableProduct,
  item: RecipeItem,
): { found: FoundPrice; onePack: boolean } | null {
  if (!(product.price > 0)) return null;
  const spec = specOf(item.match) ?? undefined;
  const covered = item.parsed.need ? priceFor(product, item.parsed.need, spec) : null;
  if (covered) return { found: covered, onePack: false };
  // Without a comparable amount: one pack is what the user buys.
  return {
    found: {
      product,
      packs: 1,
      purchaseKr: roundKr(product.price),
      portionKr: roundKr(product.price),
    },
    onePack: true,
  };
}

function bestFor(item: RecipeItem, products: readonly BuyableProduct[]): QuoteLine {
  let best: { found: FoundPrice; onePack: boolean } | null = null;
  for (const p of products) {
    if (!productMatches(p, item.match)) continue;
    const priced = priceItem(p, item);
    if (!priced) continue;
    // A covered amount beats a one-pack guess; then the cheaper purchase.
    if (
      !best ||
      (best.onePack && !priced.onePack) ||
      (best.onePack === priced.onePack && cheapest([best.found, priced.found]) === priced.found)
    ) {
      best = priced;
    }
  }
  return {
    id: item.id,
    line: item.parsed.line,
    found: best?.found ?? null,
    onePack: best?.onePack ?? false,
  };
}

function quote(chainId: string | null, lines: QuoteLine[]): Quote {
  const found = lines.filter((l) => l.found);
  return {
    chainId,
    lines,
    totalKr: roundKr(found.reduce((sum, l) => sum + (l.found?.purchaseKr ?? 0), 0)),
    missing: lines.length - found.length,
    chains: [...new Set(found.map((l) => l.found!.product.chainId))],
  };
}

/**
 * The recipe priced in each chain and combined. Stores are ordered by how many items they have,
 * then by price: a cheap total that leaves half the recipe out is not the cheapest.
 */
export function quoteRecipe(
  items: readonly RecipeItem[],
  products: readonly BuyableProduct[],
  chains: readonly string[],
): { stores: Quote[]; combined: Quote } {
  const byChain = new Map<string, BuyableProduct[]>();
  for (const p of products) {
    const list = byChain.get(p.chainId);
    if (list) list.push(p);
    else byChain.set(p.chainId, [p]);
  }
  const stores = chains
    .map((c) =>
      quote(
        c,
        items.map((i) => bestFor(i, byChain.get(c) ?? [])),
      ),
    )
    .filter((q) => q.missing < items.length)
    .sort((a, b) => a.missing - b.missing || a.totalKr - b.totalKr);
  const combined = quote(
    null,
    items.map((i) =>
      bestFor(
        i,
        products.filter((p) => chains.includes(p.chainId)),
      ),
    ),
  );
  return { stores, combined };
}
