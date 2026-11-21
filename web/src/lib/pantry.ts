/**
 * Real prices for everything a dish needs (docs/ui.md §23): the "extra" items of a recipe
 * (potatoes, lasagne sheets, rice, basil …) and the ingredients that are not on offer are looked
 * up among the current offers, shelf prices and food waste near the user, like the ingredients
 * on offer. Pure and unit tested; the server only fetches the candidate products.
 *
 * Two prices per item, both from the same real product:
 * - the purchase price: what the user pays at the till for the pack(s) that cover the amount;
 * - the portion price: what the amount the dish uses costs at that product's unit price (what it
 *   costs when the user already has the item at home).
 *
 * Products are matched on their name with explicit words and exclusions per item, so "ris" never
 * finds "rismel" or "Paris", and "kartofler" never finds "kartoffelmos".
 */
import type { FoodWasteItem } from "./foodwaste";
import type { PantryItem, RecipeSlot, SlotUnit } from "./recipes";
import { toOre } from "./verdict";

/** How products named like an item are recognised. */
export interface ProductSpec {
  /** Words or phrases; a product matches when its name contains one as whole words. */
  words: readonly string[];
  /** Also match a compound that ends in a word ("bagekartofler" for "kartofler"). */
  compound?: boolean;
  /** Parts of a name that disqualify a product ("mos", "chips"). */
  exclude?: readonly string[];
  /** Weight (kg) of one piece as the recipe counts it (a slice, a can, a head), for kg <-> stk. */
  pieceKg?: number;
  /** Weight (kg) or volume (l) of one tablespoon; a teaspoon is a third. Default 0.015. */
  spoon?: number;
}

/** Product specs by pantry item name (as in `lib/recipes.ts`). Items without one stay estimates. */
export const PANTRY_SPECS: Readonly<Record<string, ProductSpec>> = {
  løg: {
    words: ["løg", "gule løg"],
    exclude: ["ringe", "stegte", "ristede", "syltede", "perle", "pulver", "suppe", "sauce"],
    pieceKg: 0.1,
  },
  hvidløg: {
    words: ["hvidløg"],
    exclude: [
      "pulver",
      "granul",
      "dressing",
      "sauce",
      "brød",
      "flute",
      "flûte",
      "smør",
      "olie",
      "peber",
      "salt",
      "aioli",
      "pasta",
      "creme",
    ],
    pieceKg: 0.05,
  },
  olie: {
    words: ["rapsolie", "solsikkeolie", "olivenolie", "madolie", "vindruekerneolie"],
    exclude: ["spray", "chili", "trøffel", "hvidløg", "dressing", "sardin", "tun"],
    spoon: 0.015,
  },
  ris: {
    words: ["ris"],
    compound: true,
    exclude: [
      "mel",
      "grød",
      "kiks",
      "chips",
      "papir",
      "mande",
      "nudl",
      "drik",
      "pudding",
      "waffel",
      "vaffel",
      "kage",
      "paris",
      "pris",
      "kris",
      "boller",
      "snack",
      "dessert",
      "risotto",
      "kakao",
      "chokolade",
      "mælk",
      "ret",
      "salat",
      "suppe",
    ],
  },
  pasta: {
    words: [
      "pasta",
      "penne",
      "fusilli",
      "farfalle",
      "makaroni",
      "tagliatelle",
      "rigatoni",
      "spaghetti",
    ],
    exclude: [
      "sauce",
      "salat",
      "pesto",
      "fyldt",
      "tortellini",
      "ravioli",
      "lasagne",
      "suppe",
      "ret",
      "frisk",
      "bolognese",
      "carbonara",
      "snack",
      "skruer med",
    ],
  },
  spaghetti: {
    words: ["spaghetti"],
    exclude: ["sauce", "ret", "bolognese", "carbonara", "squash", "frisk"],
  },
  lasagneplader: {
    words: ["lasagneplader", "lasagnaplader", "lasagneplade", "lasagne plader", "lasagna plader"],
  },
  kartofler: {
    words: ["kartofler"],
    compound: true,
    exclude: [
      "mos",
      "chips",
      "både",
      "baade",
      "salat",
      "pommes",
      "rösti",
      "rosti",
      "frites",
      "gratin",
      "skiver",
      "kroket",
      "flager",
      "mel",
      "stivelse",
      "søde",
      "sød ",
      "suppe",
      "ovn",
      "tern",
      "hasselback",
      "snack",
    ],
  },
  agurk: {
    words: ["agurk", "agurker"],
    exclude: ["sylte", "asie", "snack", "mini", "salat", "dip"],
  },
  tomater: {
    words: ["tomater", "tomat"],
    exclude: [
      "hakkede",
      "flåede",
      "cherry",
      "cocktail",
      "snack",
      "soltørrede",
      "puré",
      "pure",
      "ketchup",
      "suppe",
      "sauce",
      "passata",
      "juice",
      "mini",
      "salsa",
      "pesto",
      "dåse",
      "chips",
    ],
    pieceKg: 0.1,
  },
  cherrytomater: {
    words: ["cherrytomater", "cherry tomater", "snacktomater", "cocktailtomater", "cherrytomat"],
    exclude: ["soltørrede", "dåse", "sauce"],
  },
  citron: {
    words: ["citron", "citroner"],
    exclude: [
      "saft",
      "juice",
      "vand",
      "peber",
      "most",
      "sorbet",
      "kage",
      "mælk",
      "te ",
      "is ",
      "dressing",
      "græs",
      "sodavand",
      "limonade",
    ],
    pieceKg: 0.12,
  },
  salat: {
    words: [
      "icebergsalat",
      "iceberg",
      "hjertesalat",
      "romainesalat",
      "romaine",
      "salathoved",
      "salathjerter",
      "romainehjerter",
    ],
    exclude: ["dressing", "mix med", "kylling"],
    pieceKg: 0.4,
  },
  rødløg: {
    words: ["rødløg", "røde løg"],
    exclude: ["syltede", "ristede", "marmelade"],
    pieceKg: 0.1,
  },
  rugbrød: {
    words: ["rugbrød"],
    exclude: ["chips", "kiks", "snack", "chunks", "toast"],
    pieceKg: 0.05,
  },
  brød: {
    words: ["toastbrød", "sandwichbrød", "franskbrød", "landbrød", "surdejsbrød"],
    exclude: ["rasp", "chips", "kiks"],
    pieceKg: 0.035,
  },
  pitabrød: {
    words: ["pitabrød", "pita brød", "pita"],
    exclude: ["chips", "snack"],
    pieceKg: 0.07,
  },
  tortillas: {
    words: ["tortilla", "tortillas", "tortillawraps", "wraps", "tortilla wraps"],
    exclude: ["chips", "chip", "snack", "sauce", "krydderi", "kit", "salsa", "bowl"],
    pieceKg: 0.04,
  },
  peberfrugt: {
    words: ["peberfrugt", "peberfrugter"],
    exclude: ["grillet", "syltet", "pesto", "chips", "dip", "fyldt", "snack", "mini"],
    pieceKg: 0.17,
  },
  gulerødder: {
    words: ["gulerødder", "gulerod"],
    exclude: [
      "juice",
      "kage",
      "snack",
      "revne",
      "revet",
      "baby",
      "mini",
      "suppe",
      "frosne",
      "dåse",
    ],
    pieceKg: 0.08,
  },
  karry: {
    words: ["karry", "karrypulver"],
    exclude: ["sauce", "ret", "paste", "ketchup", "salat", "dressing", "kylling", "suppe", "sild"],
    spoon: 0.006,
  },
  karse: { words: ["karse"], exclude: ["brøndkarse"] },
  hvedemel: { words: ["hvedemel"], exclude: ["fuldkorn", "durum"], spoon: 0.009 },
  paprika: {
    words: ["paprika"],
    exclude: [
      "frugt",
      "chips",
      "pølse",
      "salami",
      "sauce",
      "kylling",
      "creme",
      "dip",
      "snack",
      "chorizo",
    ],
    spoon: 0.006,
  },
  mayonnaise: {
    words: ["mayonnaise", "mayo"],
    exclude: ["dressing", "remoulade", "sauce", "salat"],
    spoon: 0.015,
  },
  "frosne ærter": {
    words: ["ærter", "haveærter", "grønne ærter"],
    exclude: [
      "kikærter",
      "sukkerærter",
      "snack",
      "suppe",
      "gule",
      "dåse",
      "wasabi",
      "proteinærter",
    ],
  },
  oliven: { words: ["oliven"], exclude: ["olie", "tapenade", "pesto", "fyldte"], spoon: 0.01 },
  spidskommen: { words: ["spidskommen", "spidskommen hel", "spidskommen stødt"], spoon: 0.006 },
  purløg: { words: ["purløg"], exclude: ["dressing", "smør", "creme", "dip", "frys", "tørret"] },
  majs: {
    words: ["majs", "majskerner"],
    exclude: [
      "chips",
      "mel",
      "pop",
      "kolber",
      "cornflakes",
      "stivelse",
      "snack",
      "brød",
      "kiks",
      "baby",
      "suppe",
    ],
    pieceKg: 0.285,
  },
  tahin: { words: ["tahin", "tahini", "sesampasta"], spoon: 0.015 },
  persille: {
    words: ["persille", "bredbladet persille", "kruspersille"],
    exclude: ["rod", "rødder", "tørret", "frys"],
  },
  radiser: { words: ["radiser"], exclude: ["snack"] },
  havregryn: {
    words: ["havregryn", "havregrød"],
    exclude: ["bar", "kiks", "drik", "chokolade"],
    spoon: 0.006,
  },
  æble: {
    words: ["æble", "æbler"],
    exclude: [
      "juice",
      "most",
      "kage",
      "mos",
      "chips",
      "eddike",
      "tærte",
      "saft",
      "grød",
      "gele",
      "snack",
      "cider",
      "drik",
      "smoothie",
      "kompot",
      "ringe",
      "tørrede",
    ],
    pieceKg: 0.15,
  },
  champignon: {
    words: ["champignon", "champignoner", "svampe"],
    exclude: ["sauce", "suppe", "paté", "pate", "dåse", "tørrede", "pizza", "creme", "skovsvampe"],
  },
  "grønne bønner": {
    words: ["grønne bønner", "haricots verts", "haricots"],
    exclude: ["dåse", "salat"],
  },
  kapers: { words: ["kapers"], spoon: 0.01 },
  gær: {
    words: ["gær", "bagegær", "tørgær"],
    exclude: ["ekstrakt", "flager", "øl"],
    pieceKg: 0.05,
  },
  basilikum: {
    words: ["basilikum"],
    exclude: ["pesto", "tørret", "dressing", "olie", "sauce", "frys"],
  },
  ingefær: {
    words: ["ingefær", "ingefærrod"],
    exclude: [
      "shot",
      "drik",
      "juice",
      "øl",
      "syltet",
      "kage",
      "te",
      "pulver",
      "stødt",
      "kiks",
      "candy",
      "lemonade",
      "sodavand",
    ],
    pieceKg: 0.05,
  },
  "frossen spinat": {
    words: ["spinat", "hakket spinat", "bladspinat"],
    exclude: ["baby", "pizza", "tærte", "lasagne", "suppe", "pasta", "chips", "dip", "pesto"],
  },
  tacokrydderi: {
    words: ["tacokrydderi", "taco krydderi", "taco seasoning", "tacomix"],
    spoon: 0.008,
    pieceKg: 0.028,
  },
  "frosne grøntsager": { words: ["grøntsagsblanding", "wokgrøntsager"] },
  bacon: {
    words: ["bacon", "baconskiver", "bacontern", "bacon i tern"],
    exclude: ["chips", "snack", "dressing", "ost", "pølse", "salat", "pizza", "bites"],
    pieceKg: 0.0125,
  },
  "bacon i tern": {
    words: ["bacontern", "bacon i tern", "bacon tern"],
    exclude: ["chips", "snack"],
  },
  squash: {
    words: ["squash", "courgette"],
    exclude: ["butternut", "græskar", "nudler", "spaghetti", "suppe"],
    pieceKg: 0.3,
  },
  "rød chili": {
    words: ["chili", "chilipeber", "chilier", "rød chili"],
    exclude: [
      "sauce",
      "flager",
      "pulver",
      "stødt",
      "con carne",
      "sin carne",
      "mayo",
      "olie",
      "ketchup",
      "chips",
      "nødder",
      "chokolade",
      "pasta",
      "sweet",
      "dip",
      "pølse",
      "salami",
      "creme",
      "marinade",
    ],
    pieceKg: 0.015,
  },
  "soltørrede tomater i olie": {
    words: ["soltørrede tomater"],
    exclude: ["pesto", "creme", "dip", "brød"],
    spoon: 0.015,
  },
  spidskål: { words: ["spidskål"], exclude: ["salat", "coleslaw", "snittet"], pieceKg: 0.8 },
  avocado: {
    words: ["avocado", "avocadoer", "avokado"],
    exclude: ["dip", "guacamole", "olie", "creme", "snack"],
    pieceKg: 0.2,
  },
  "mørk chokolade": {
    words: ["mørk chokolade", "chokolade 70", "kakaochokolade", "mørk"],
    exclude: ["mælk", "kiks", "kage", "drik", "is", "nød", "bar", "chips", "brød", "pålæg"],
  },
  nachos: { words: ["nachos", "tortillachips"], exclude: ["dip", "sauce", "ost", "kit"] },
  lime: {
    words: ["lime", "limefrugter"],
    exclude: [
      "juice",
      "saft",
      "sodavand",
      "vand",
      "kage",
      "most",
      "mynte",
      "chips",
      "dressing",
      "blade",
    ],
    pieceKg: 0.07,
  },
  "frisk koriander": {
    words: ["koriander", "frisk koriander"],
    exclude: ["stødt", "tørret", "frø", "hele", "frys", "pesto"],
  },
  "frisk mynte": {
    words: ["mynte", "frisk mynte"],
    exclude: [
      "te",
      "tørret",
      "pastil",
      "tyggegummi",
      "chokolade",
      "lime",
      "vand",
      "sodavand",
      "is",
    ],
  },
  "frisk timian": {
    words: ["timian", "frisk timian"],
    exclude: ["tørret", "honning", "salt", "olie"],
  },
  dild: {
    words: ["dild", "frisk dild"],
    exclude: ["tørret", "kartofler", "sild", "dressing", "creme", "dip", "frys", "olie"],
  },
  rucola: {
    words: ["rucola", "rucolasalat"],
    exclude: ["pesto", "dressing", "pizza", "chips"],
    pieceKg: 0.02,
  },
  forårsløg: {
    words: ["forårsløg"],
    exclude: ["dressing", "dip", "chips", "creme", "smør", "ost"],
  },
  blomkål: {
    words: ["blomkål"],
    exclude: ["ris", "mos", "suppe", "gratin", "pizza", "frosne", "salat", "chips"],
    pieceKg: 0.8,
  },
  aubergine: {
    words: ["aubergine", "auberginer"],
    exclude: ["dip", "creme", "grillet", "syltet", "chips", "salat"],
    pieceKg: 0.3,
  },
  babyspinat: {
    words: ["babyspinat", "baby spinat", "spinat"],
    exclude: [
      "frosne",
      "frossen",
      "hakket",
      "pizza",
      "tærte",
      "lasagne",
      "suppe",
      "pasta",
      "chips",
      "dip",
      "pesto",
    ],
  },
  "grønne asparges": {
    words: ["asparges", "grønne asparges"],
    exclude: ["hvide", "dåse", "suppe", "glas", "frosne", "tærte", "chips", "bacon"],
  },
  edamamebønner: {
    words: ["edamame", "edamamebønner"],
    exclude: ["snack", "chips", "salt", "chili", "nudler"],
  },
  chorizo: {
    words: ["chorizo"],
    exclude: ["chips", "pizza", "snack", "pålæg i skiver", "pasta", "olie"],
  },
  cocktailpølser: {
    words: ["cocktailpølser", "cocktail pølser"],
    exclude: ["svøbt", "bacon", "dej", "snack"],
  },
  mandler: {
    words: ["mandler", "mandelflager", "hakkede mandler"],
    exclude: [
      "chokolade",
      "mælk",
      "drik",
      "smør",
      "mel",
      "kage",
      "salt",
      "ristede saltede",
      "marcipan",
      "kiks",
      "is",
    ],
  },
  dadler: {
    words: ["dadler", "medjool"],
    exclude: ["chokolade", "kugler", "bar", "kage", "sirup"],
  },
  "tørrede abrikoser": {
    words: ["abrikoser", "tørrede abrikoser"],
    exclude: ["marmelade", "dåse", "syltetøj", "kompot", "chokolade", "kage", "bar"],
  },
  durummel: {
    words: ["durummel", "durum", "semolina"],
    exclude: ["pasta", "brød", "spaghetti", "penne"],
  },
};

/** A shelf price, an offer or a clearance that can be bought now near the user. */
export interface BuyableProduct {
  /** Stable id (product key, or `waste:{listing}` for a clearance). */
  key: string;
  label: string;
  chainId: string;
  /** Taxonomy class key, when the product is recognised. */
  classKey: string | null;
  kind: "regular" | "offer" | "clearance";
  /** Pack price (kr.). */
  price: number;
  unit: string | null;
  sizeMin: number | null;
  sizeMax: number | null;
  /** Source fields for the price's link (`lib/sources.ts`). */
  source: string | null;
  sourceItemId: string | null;
  catalogId: string | null;
  validTo: string | null;
  ean: string | null;
  /** A clearance's store and distance; offers and shelf prices are chain-wide. */
  storeName?: string | null;
  distanceKm?: number | null;
  productKey?: string | null;
}

/** An amount in a product unit. */
export interface Need {
  amount: number;
  unit: SlotUnit;
}

/** What an item costs, from one real product. */
export interface FoundPrice {
  product: BuyableProduct;
  /** Packs to buy to cover the amount. */
  packs: number;
  /** What the packs cost (kr.). */
  purchaseKr: number;
  /** What the amount the dish uses costs at the product's unit price (kr.), at most `purchaseKr`. */
  portionKr: number;
}

/** Kroner rounded to whole øre. */
const roundKr = (value: number): number => toOre(value) / 100;

/** Lower case, Danish, letters and digits split into words. */
function words(text: string): string[] {
  return text
    .toLocaleLowerCase("da-DK")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Whether a product name is the item: a word or phrase of the spec as whole words. */
export function matchesSpec(name: string, spec: ProductSpec): boolean {
  const lower = ` ${name.toLocaleLowerCase("da-DK")} `;
  if (spec.exclude?.some((x) => lower.includes(x))) return false;
  const tokens = words(name);
  return spec.words.some((phrase) => {
    const parts = words(phrase);
    if (parts.length === 0) return false;
    for (let i = 0; i + parts.length <= tokens.length; i++) {
      const ok = parts.every((p, j) => {
        const t = tokens[i + j] ?? "";
        // Only the last word of a phrase may be the end of a compound.
        return t === p || (spec.compound === true && j === parts.length - 1 && t.endsWith(p));
      });
      if (ok) return true;
    }
    return false;
  });
}

/** Danish amount fractions: "1/2", "½", "1,5". */
function parseNumber(text: string): number | null {
  const t = text.replace("½", "1/2").replace(",", ".");
  const frac = /^(\d+)\/(\d+)$/.exec(t);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const PIECE_WORDS = new Set([
  "stk",
  "hoved",
  "hoveder",
  "bundt",
  "bakke",
  "potte",
  "dåse",
  "dåser",
  "terning",
  "terninger",
  "skive",
  "skiver",
  "pakke",
  "pakker",
  "pose",
  "glas",
  "håndfuld",
  "håndfulde",
  "bundter",
]);

/**
 * The amount of a recipe text ("300 g", "1/2 stk.", "2 spsk.", "4 skiver") in kg, l or pieces;
 * null for "efter smag" and the like.
 */
export function parseAmount(text: string, spec?: ProductSpec): Need | null {
  const m = /^\s*([\d½/,.]+)\s*([\p{L}.]*)/u.exec(text.toLocaleLowerCase("da-DK"));
  if (!m) return null;
  const n = parseNumber(m[1] ?? "");
  if (n == null) return null;
  const unit = (m[2] ?? "").replace(/\.$/, "");
  const spoon = spec?.spoon ?? 0.015;
  switch (unit) {
    case "g":
      return { amount: n / 1000, unit: "kg" };
    case "kg":
      return { amount: n, unit: "kg" };
    case "ml":
      return { amount: n / 1000, unit: "l" };
    case "dl":
      return { amount: n / 10, unit: "l" };
    case "l":
      return { amount: n, unit: "l" };
    case "spsk":
      return { amount: n * spoon, unit: "kg" };
    case "tsk":
      return { amount: (n * spoon) / 3, unit: "kg" };
    case "fed":
      // A clove is about a tenth of a head.
      return { amount: n / 10, unit: "stk" };
    case "":
      return { amount: n, unit: "stk" };
    default:
      return PIECE_WORDS.has(unit) ? { amount: n, unit: "stk" } : null;
  }
}

/** The need in the product's unit (kg, l and pieces converted where the spec knows how), or null. */
function inUnit(need: Need, unit: string | null, spec?: ProductSpec): number | null {
  if (unit == null) return null;
  if (need.unit === unit) return need.amount;
  // Liquids and solids by the spoon: 1 l ≈ 1 kg is close enough for a spoonful.
  if ((need.unit === "kg" && unit === "l") || (need.unit === "l" && unit === "kg")) {
    return need.amount;
  }
  const piece = spec?.pieceKg;
  if (piece == null) return null;
  if (need.unit === "stk" && (unit === "kg" || unit === "l")) return need.amount * piece;
  if ((need.unit === "kg" || need.unit === "l") && unit === "stk") return need.amount / piece;
  return null;
}

/** At most this many packs are bought to cover one item. */
const MAX_PACKS = 4;

/**
 * What one product costs for a need: the packs that cover it (the smallest pack of a size range
 * counts, so the cover is never overstated) and the portion at the product's unit price. Null
 * when the product cannot be compared (unknown size, another unit) or would take too many packs.
 */
export function priceFor(
  product: BuyableProduct,
  need: Need,
  spec?: ProductSpec,
): FoundPrice | null {
  if (!(product.price > 0)) return null;
  // A product priced per piece without a size is one piece.
  const size = product.sizeMin ?? product.sizeMax ?? (product.unit === "stk" ? 1 : null);
  if (size == null || !(size > 0)) return null;
  const amount = inUnit(need, product.unit, spec);
  if (amount == null || !(amount > 0)) return null;
  const packs = Math.max(1, Math.ceil(amount / size - 1e-9));
  if (packs > MAX_PACKS) return null;
  const purchaseKr = roundKr(product.price * packs);
  const portionKr = Math.min(purchaseKr, roundKr((product.price / size) * amount));
  return { product, packs, purchaseKr, portionKr };
}

/** The cheapest purchase among the candidates; ties: the cheaper portion, then the shorter name. */
export function cheapest(candidates: readonly (FoundPrice | null)[]): FoundPrice | null {
  let best: FoundPrice | null = null;
  for (const c of candidates) {
    if (!c) continue;
    if (
      !best ||
      c.purchaseKr < best.purchaseKr ||
      (c.purchaseKr === best.purchaseKr && c.portionKr < best.portionKr) ||
      (c.purchaseKr === best.purchaseKr &&
        c.portionKr === best.portionKr &&
        c.product.label.length < best.product.label.length)
    ) {
      best = c;
    }
  }
  return best;
}

/** A clearance as a buyable product (store-specific). */
export function clearanceProduct(item: FoodWasteItem): BuyableProduct {
  return {
    key: `waste:${item.listingId}`,
    label: item.title,
    chainId: item.chainId,
    classKey: item.classKey ?? null,
    kind: "clearance",
    price: item.price,
    unit: item.unit,
    sizeMin: item.size,
    sizeMax: item.size,
    source: "salling_food_waste",
    sourceItemId: null,
    catalogId: null,
    validTo: item.validTo,
    ean: item.ean,
    storeName: item.storeName,
    distanceKm: item.distanceKm,
    productKey: item.productKey ?? null,
  };
}

/** Finds real prices for recipe items among the products near the user. */
export interface PriceFinder {
  /** A pantry item (by name and amount text), or null when we have no price for it. */
  pantry(item: PantryItem, chainId?: string | null): FoundPrice | null;
  /** A slot bought at the normal price (any of its taxonomy types), or null. */
  slot(slot: RecipeSlot, chainId?: string | null): FoundPrice | null;
  /** A pantry item needed by several dishes: their amounts together (same unit only). */
  pantryAmounts(
    name: string,
    amounts: readonly string[],
    chainId?: string | null,
  ): FoundPrice | null;
  /** A slot needed by several dishes: the summed amount in the slot's unit. */
  slotAmount(
    types: readonly string[],
    amount: number,
    unit: SlotUnit,
    chainId?: string | null,
  ): FoundPrice | null;
}

const typeOf = (classKey: string | null): string | null => classKey?.split("|")[0]?.trim() || null;

/** The sum of amount texts in one unit, or null when they cannot be added up. */
export function sumAmounts(amounts: readonly string[], spec?: ProductSpec): Need | null {
  let amount = 0;
  let unit: SlotUnit | null = null;
  for (const text of amounts) {
    const need = parseAmount(text, spec);
    if (!need || (unit != null && unit !== need.unit)) return null;
    unit = need.unit;
    amount += need.amount;
  }
  return unit == null ? null : { amount, unit };
}

/**
 * A {@link PriceFinder} over the given products (shelf prices, offers, clearances). With a chain,
 * only that chain's products count (a plan bought in one store).
 */
export function priceFinder(products: readonly BuyableProduct[]): PriceFinder {
  const byType = new Map<string, BuyableProduct[]>();
  for (const p of products) {
    const t = typeOf(p.classKey);
    if (!t) continue;
    const list = byType.get(t);
    if (list) list.push(p);
    else byType.set(t, [p]);
  }
  const memo = new Map<string, FoundPrice | null>();
  const remember = (key: string, compute: () => FoundPrice | null) => {
    if (!memo.has(key)) memo.set(key, compute());
    return memo.get(key) ?? null;
  };
  const inChain = (chainId: string | null | undefined) => (p: BuyableProduct) =>
    chainId == null || p.chainId === chainId;
  const byName = (name: string, need: Need | null, chainId: string | null | undefined) => {
    const spec = PANTRY_SPECS[name];
    if (!spec || !need) return null;
    return cheapest(
      products
        .filter(inChain(chainId))
        .filter((p) => matchesSpec(p.label, spec))
        .map((p) => priceFor(p, need, spec)),
    );
  };
  const byTypes = (types: readonly string[], need: Need, chainId: string | null | undefined) =>
    cheapest(
      types
        .flatMap((t) => byType.get(t) ?? [])
        .filter(inChain(chainId))
        .map((p) => priceFor(p, need)),
    );
  return {
    pantry(item, chainId) {
      return remember(`p:${chainId ?? ""}:${item.name}|${item.amount}`, () =>
        byName(item.name, parseAmount(item.amount, PANTRY_SPECS[item.name]), chainId),
      );
    },
    pantryAmounts(name, amounts, chainId) {
      return remember(`pa:${chainId ?? ""}:${name}|${amounts.join("+")}`, () =>
        byName(name, sumAmounts(amounts, PANTRY_SPECS[name]), chainId),
      );
    },
    slot(slot, chainId) {
      return remember(`s:${chainId ?? ""}:${slot.types.join(",")}|${slot.amount}${slot.unit}`, () =>
        byTypes(slot.types, { amount: slot.amount, unit: slot.unit }, chainId),
      );
    },
    slotAmount(types, amount, unit, chainId) {
      return remember(`sa:${chainId ?? ""}:${types.join(",")}|${amount}${unit}`, () =>
        byTypes(types, { amount, unit }, chainId),
      );
    },
  };
}

/** Name stems the server prefilters products with (`ILIKE '%stem%'`). */
export function pantrySearchStems(): string[] {
  const stems = new Set<string>();
  for (const spec of Object.values(PANTRY_SPECS)) {
    for (const w of spec.words) stems.add(words(w).at(-1) ?? w);
  }
  return [...stems];
}

/** The pack text of a found price ("2 × 500 g", "1 kg"). */
export function packText(found: FoundPrice): string | null {
  const p = found.product;
  const size = p.sizeMin ?? p.sizeMax;
  if (size == null || p.unit == null) return found.packs > 1 ? `${found.packs} stk.` : null;
  const one =
    p.unit === "kg"
      ? size < 1
        ? `${Math.round(size * 1000)} g`
        : `${String(size).replace(".", ",")} kg`
      : p.unit === "l"
        ? size < 1
          ? `${Math.round(size * 100) / 10} dl`.replace(".", ",")
          : `${String(size).replace(".", ",")} l`
        : `${String(size).replace(".", ",")} stk.`;
  return found.packs > 1 ? `${found.packs} × ${one}` : one;
}
