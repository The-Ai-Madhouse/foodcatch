"use server";

import { chainName } from "@/lib/chains";
import { matchIngredient, parseIngredientLine, usuallyAtHome } from "@/lib/ingredient-match";
import { clearanceProduct, packText, pantrySearchStems } from "@/lib/pantry";
import { extractRecipe, looksLikeBotCheck } from "@/lib/recipe-import";
import { quoteRecipe, type Quote, type RecipeItem } from "@/lib/recipe-pricing";
import { priceSource, type PriceSource } from "@/lib/sources";
import { nearestByChain, shortStoreName } from "@/lib/stores";
import { RecipeFetchError, fetchRecipePage } from "@/server/fetch-recipe";
import { getUserLocation } from "@/server/location";
import { getBuyableProducts, getFoodWasteNear, getNearbyStores } from "@/server/queries";

/** One ingredient as the editor shows it. */
export interface EditorIngredient {
  id: string;
  line: string;
  /** "400 g", or null. */
  amount: string | null;
  /** What we will look for ("Hakket oksekød", "kulmule"). */
  lookFor: string;
  /** Usually at home (salt, oil …): pre-ticked "har jeg". */
  atHome: boolean;
}

export interface ImportState {
  status: "idle" | "ok" | "error";
  message: string;
  url: string;
  title: string | null;
  servings: number | null;
  ingredients: EditorIngredient[];
  seq: number;
}

/** Reads a typed or pasted ingredient line into the editor's form. */
function editorIngredient(line: string, index: number): EditorIngredient {
  const parsed = parseIngredientLine(line);
  const match = matchIngredient(parsed.name, parsed.phrase);
  return {
    id: `i${index}-${line.length}`,
    line: parsed.line,
    amount: parsed.amountText,
    lookFor: match.label.charAt(0).toLocaleUpperCase("da-DK") + match.label.slice(1),
    atHome: usuallyAtHome(parsed.name),
  };
}

/** Step 1: fetch the page and read its ingredients. */
export async function importRecipeAction(
  prev: ImportState,
  formData: FormData,
): Promise<ImportState> {
  const url = String(formData.get("url") ?? "").slice(0, 2000);
  const base = { ...prev, url, seq: prev.seq + 1 };
  try {
    const page = await fetchRecipePage(url);
    const recipe = extractRecipe(page.html);
    if (!recipe) {
      return {
        ...base,
        status: "error",
        message: looksLikeBotCheck(page.html)
          ? "Siden lader ikke programmer læse den (den tjekker, om du er et menneske). Skriv ingredienserne selv nedenfor."
          : "Vi kunne ikke finde en ingrediensliste på siden. Skriv ingredienserne selv nedenfor.",
        title: null,
        servings: null,
        ingredients: [],
      };
    }
    return {
      ...base,
      status: "ok",
      message: "",
      title: recipe.title,
      servings: recipe.servings,
      ingredients: recipe.ingredients.map(editorIngredient),
    };
  } catch (error) {
    return {
      ...base,
      status: "error",
      message: error instanceof RecipeFetchError ? error.message : "Siden kunne ikke hentes.",
      title: null,
      servings: null,
      ingredients: [],
    };
  }
}

/** Reads one line typed in the editor ("Tilføj ingrediens"). */
export async function readIngredientAction(line: string, index: number): Promise<EditorIngredient> {
  return editorIngredient(String(line).slice(0, 200), index);
}

// ---------------------------------------------------------------- step 2: prices

export interface QuoteLineView {
  line: string;
  product: string | null;
  pack: string | null;
  purchaseKr: number | null;
  kind: "regular" | "offer" | "clearance" | null;
  onePack: boolean;
  chain: string | null;
  source: PriceSource | null;
}

export interface QuoteView {
  /** Chain id, or null for the combined quote. */
  chainId: string | null;
  title: string;
  /** Nearest store and its distance (km), for a chain. */
  store: string | null;
  distanceKm: number | null;
  totalKr: number;
  missing: number;
  chains: string[];
  lines: QuoteLineView[];
}

export interface PricesResult {
  stores: QuoteView[];
  combined: QuoteView | null;
  /** Ingredients priced (not ticked as at home). */
  count: number;
}

/** Step 2: the ingredients still to buy, priced in each nearby store and combined. */
export async function quoteRecipeAction(lines: string[]): Promise<PricesResult> {
  const wanted = lines
    .map((l) => String(l).slice(0, 200))
    .filter((l) => l.trim())
    .slice(0, 60);
  const items: RecipeItem[] = wanted.map((line, i) => {
    const parsed = parseIngredientLine(line);
    return { id: `i${i}`, parsed, match: matchIngredient(parsed.name, parsed.phrase) };
  });
  if (items.length === 0) return { stores: [], combined: null, count: 0 };
  const location = await getUserLocation();
  const [stores, foodWaste] = await Promise.all([
    getNearbyStores(location),
    getFoodWasteNear(location),
  ]);
  const storesByChain = nearestByChain(stores);
  const chains = [...storesByChain.keys()];
  const stems = new Set(pantrySearchStems());
  const types = new Set<string>();
  for (const item of items) {
    if (item.match.kind === "type") item.match.types.forEach((t) => types.add(t));
    if (item.match.kind === "text")
      stems.add(item.match.label.split(" ").at(-1) ?? item.match.label);
  }
  const products = [
    ...(await getBuyableProducts(chains, [...stems], [...types])),
    ...foodWaste.map(clearanceProduct),
  ];
  const { stores: quotes, combined } = quoteRecipe(items, products, chains);
  const now = new Date();
  const view = (q: Quote): QuoteView => {
    const nearest = q.chainId ? storesByChain.get(q.chainId)?.[0] : undefined;
    return {
      chainId: q.chainId,
      title: q.chainId ? chainName(q.chainId) : "Billigst kombineret",
      store: nearest && q.chainId ? shortStoreName(nearest.name, q.chainId) : null,
      distanceKm: nearest?.distanceKm ?? null,
      totalKr: q.totalKr,
      missing: q.missing,
      chains: q.chains,
      lines: q.lines.map((l) => {
        const p = l.found?.product;
        return {
          line: l.line,
          product: p?.label ?? null,
          pack: l.found ? packText(l.found) : null,
          purchaseKr: l.found?.purchaseKr ?? null,
          kind: p?.kind ?? null,
          onePack: l.onePack,
          chain: p ? chainName(p.chainId) : null,
          source: p
            ? priceSource(
                {
                  source: p.source,
                  chainId: p.chainId,
                  sourceItemId: p.sourceItemId,
                  catalogId: p.catalogId,
                  validTo: p.validTo,
                  ean: p.ean,
                },
                now,
              )
            : null,
        };
      }),
    };
  };
  return { stores: quotes.map(view), combined: view(combined), count: items.length };
}
