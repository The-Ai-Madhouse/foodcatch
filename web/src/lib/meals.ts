/**
 * Meal ideas ("Madideer", docs/ui.md §13): a fixed catalogue of everyday dishes matched against
 * this week's offers and the food-waste clearances near the user, with what buying the matched
 * items saves. Pure and unit tested.
 *
 * Savings are only ever computed from our own data, never guessed:
 *
 * - Clearance: Salling's price before the markdown minus the clearance price, per pack.
 * - Offer: the cheapest normal price of exactly the same product (a `regular` shelf price of a
 *   chain near the user, or Salling's EAN price) times the smallest pack of the offer, minus the
 *   offer price. An offer without such a normal price saves an unknown amount (`null`) and adds
 *   nothing to the total.
 *
 * Offers are only used when they are a documented good deal or cheaper than the normal price;
 * an offer that is cheaper elsewhere is never suggested.
 */

import type { EvaluatedDeal } from "./deals";
import type { FoodWasteItem } from "./foodwaste";
import { referenceCounts, toOre, type ReferenceKind } from "./verdict";

/** One ingredient slot of a dish: any of `types` (taxonomy type ids) fills it. */
export interface RecipeSlot {
  /** Danish name of the ingredient ("Hakket oksekød"). */
  label: string;
  types: readonly string[];
  /** A core slot must be on offer or cleared for the dish to be suggested. */
  core?: boolean;
}

export interface Recipe {
  id: string;
  /** Danish dish name. */
  name: string;
  /** One Danish sentence on how it is made. */
  description: string;
  slots: readonly RecipeSlot[];
  /** Other things the dish needs (Danish), bought or found at home. */
  pantry: readonly string[];
}

const MINCED_BEEF = ["hakket_oksekød", "hakket_okse_gris"];
const MINCED_MIXED = ["hakket_gris_kalv", "hakket_grisekød", "hakket_okse_gris"];
const MINCED_POULTRY = ["hakket_kylling", "hakket_kalkun"];
const CHICKEN_FILLET = ["kyllingebryst", "kyllingeinderfilet"];
const CHICKEN_ANY = ["kyllingebryst", "kyllingeinderfilet", "kyllingelår"];
const TOMATOES = ["hakkede_tomater", "flåede_tomater", "passata"];
const BEANS = ["kidneybønner", "sorte_bønner"];
const CREAM = ["madlavningsfløde", "piskefløde"];
const THICK_DAIRY = ["skyr", "græsk_yoghurt", "yoghurt", "a38_ymer"];
const CHEESE = ["mozzarella", "fast_ost"];

/** The dish catalogue. Ingredients are taxonomy type ids (pipeline `matching/taxonomy.py`). */
export const RECIPES: readonly Recipe[] = [
  {
    id: "bolognese",
    name: "Spaghetti bolognese",
    description: "Brun kødet med løg og gulerod, kog det ind i tomat i 30 minutter.",
    slots: [
      { label: "Hakket kød", types: [...MINCED_BEEF, "hakket_grisekød"], core: true },
      { label: "Tomater", types: TOMATOES },
      { label: "Tomatpuré", types: ["tomatpuré"] },
    ],
    pantry: ["spaghetti", "løg", "gulerod", "hvidløg"],
  },
  {
    id: "chili",
    name: "Chili con carne",
    description: "Kødet brunes med løg og krydderier og simrer med bønner og tomat.",
    slots: [
      { label: "Hakket oksekød", types: MINCED_BEEF, core: true },
      { label: "Bønner", types: BEANS },
      { label: "Tomater", types: TOMATOES },
      { label: "Creme fraiche", types: ["creme_fraiche"] },
    ],
    pantry: ["ris", "løg", "chili", "spidskommen"],
  },
  {
    id: "chili-sin-carne",
    name: "Chili sin carne",
    description: "Vegetarisk chili af bønner og tomat med løg, peberfrugt og spidskommen.",
    slots: [
      { label: "Bønner", types: BEANS, core: true },
      { label: "Tomater", types: TOMATOES, core: true },
      { label: "Creme fraiche", types: ["creme_fraiche"] },
    ],
    pantry: ["ris", "løg", "peberfrugt", "spidskommen"],
  },
  {
    id: "lasagne",
    name: "Lasagne",
    description: "Kødsauce og hvid sovs i lag med pasta, ost på toppen og 45 minutter i ovnen.",
    slots: [
      { label: "Hakket kød", types: MINCED_BEEF, core: true },
      { label: "Tomater", types: TOMATOES },
      { label: "Mælk", types: ["mælk"] },
      { label: "Ost", types: CHEESE },
      { label: "Smør", types: ["smør"] },
    ],
    pantry: ["lasagneplader", "hvedemel", "løg"],
  },
  {
    id: "frikadeller",
    name: "Frikadeller med kartofler",
    description: "Fars af kød, æg, mælk og løg, stegt på panden og serveret med kartofler.",
    slots: [
      { label: "Hakket kød", types: MINCED_MIXED, core: true },
      { label: "Æg", types: ["æg"] },
      { label: "Mælk", types: ["mælk"] },
    ],
    pantry: ["kartofler", "løg", "havregryn eller rasp"],
  },
  {
    id: "kyllingefrikadeller",
    name: "Kyllingefrikadeller i pita",
    description: "Små frikadeller af hakket fjerkræ i pitabrød med salat og yoghurtdressing.",
    slots: [
      { label: "Hakket kylling/kalkun", types: MINCED_POULTRY, core: true },
      { label: "Æg", types: ["æg"] },
      { label: "Yoghurt", types: ["græsk_yoghurt", "yoghurt", "skyr"] },
    ],
    pantry: ["pitabrød", "salat", "agurk"],
  },
  {
    id: "kyllingekarry",
    name: "Kylling i karry",
    description: "Kyllingen steges med løg og karry og simrer i fløde. Serveres med ris.",
    slots: [
      { label: "Kylling", types: CHICKEN_ANY, core: true },
      { label: "Fløde", types: CREAM },
    ],
    pantry: ["ris", "løg", "karry", "æble"],
  },
  {
    id: "ovnkylling",
    name: "Ovnstegt kylling med rodfrugter",
    description: "Kyllingen steges i ovnen på et lag af kartofler og rodfrugter.",
    slots: [{ label: "Kylling", types: ["hel_kylling", "kyllingelår"], core: true }],
    pantry: ["kartofler", "gulerødder", "løg", "timian"],
  },
  {
    id: "kylling-kikaerter",
    name: "Kyllingelår med kikærter",
    description: "Kyllingelår og kikærter bages i et fad med citron, hvidløg og paprika.",
    slots: [
      { label: "Kyllingelår", types: ["kyllingelår"], core: true },
      { label: "Kikærter", types: ["kikærter"], core: true },
    ],
    pantry: ["citron", "hvidløg", "paprika", "salat"],
  },
  {
    id: "kylling-tzatziki",
    name: "Kyllingespyd med tzatziki",
    description: "Marineret kylling på panden med tzatziki af yoghurt, agurk og hvidløg.",
    slots: [
      { label: "Kyllingefilet", types: CHICKEN_FILLET, core: true },
      { label: "Græsk yoghurt", types: ["græsk_yoghurt", "yoghurt", "skyr"], core: true },
    ],
    pantry: ["agurk", "hvidløg", "pitabrød", "tomat"],
  },
  {
    id: "kyllingesalat-feta",
    name: "Kyllingesalat med feta",
    description: "Stegt kyllingefilet i skiver over salat med feta, tomat og agurk.",
    slots: [
      { label: "Kyllingefilet", types: CHICKEN_FILLET, core: true },
      { label: "Feta", types: ["feta"], core: true },
    ],
    pantry: ["salat", "tomat", "agurk", "olivenolie"],
  },
  {
    id: "moerbradgryde",
    name: "Mørbradgryde",
    description: "Mørbrad i skiver brunes med løg og svampe og simrer i fløde med tomatpuré.",
    slots: [
      { label: "Svinemørbrad", types: ["svinemørbrad"], core: true },
      { label: "Fløde", types: CREAM },
      { label: "Tomatpuré", types: ["tomatpuré"] },
    ],
    pantry: ["ris", "champignon", "løg", "paprika"],
  },
  {
    id: "koteletter",
    name: "Koteletter i fad",
    description: "Brunede koteletter bages færdige i fløde med løg og serveres med kartofler.",
    slots: [
      { label: "Svinekoteletter", types: ["svinekoteletter"], core: true },
      { label: "Fløde", types: CREAM },
    ],
    pantry: ["kartofler", "løg", "grønne bønner"],
  },
  {
    id: "shakshuka",
    name: "Shakshuka",
    description: "Æg pocheret i krydret tomatsauce med løg og peberfrugt, gerne med feta.",
    slots: [
      { label: "Æg", types: ["æg"], core: true },
      { label: "Tomater", types: TOMATOES, core: true },
      { label: "Feta", types: ["feta"] },
    ],
    pantry: ["løg", "peberfrugt", "spidskommen", "brød"],
  },
  {
    id: "aeggekage",
    name: "Æggekage",
    description: "Æg og mælk på panden med grønt og ost, til rugbrød.",
    slots: [
      { label: "Æg", types: ["æg"], core: true },
      { label: "Mælk", types: ["mælk"] },
      { label: "Ost", types: ["fast_ost"] },
    ],
    pantry: ["rugbrød", "tomat", "purløg"],
  },
  {
    id: "pandekager",
    name: "Pandekager",
    description: "Tynde pandekager af æg, mælk og mel – til aftensmad med fyld eller som dessert.",
    slots: [
      { label: "Æg", types: ["æg"], core: true },
      { label: "Mælk", types: ["mælk"], core: true },
      { label: "Smør", types: ["smør", "smørbar"] },
    ],
    pantry: ["hvedemel", "sukker"],
  },
  {
    id: "tunpasta",
    name: "Pasta med tun og tomat",
    description: "Hurtig tomatsauce med tun, løg og kapers vendt med pasta.",
    slots: [
      { label: "Tun", types: ["tun"], core: true },
      { label: "Tomater", types: TOMATOES },
    ],
    pantry: ["pasta", "løg", "kapers"],
  },
  {
    id: "pizza",
    name: "Hjemmelavet pizza",
    description: "Pizzabund med tomatsauce og mozzarella, bagt ved høj varme.",
    slots: [
      { label: "Mozzarella", types: ["mozzarella"], core: true },
      { label: "Tomatsauce", types: ["passata", "hakkede_tomater", "flåede_tomater"] },
    ],
    pantry: ["hvedemel", "gær", "basilikum"],
  },
  {
    id: "feta-pasta",
    name: "Pasta med bagt feta",
    description: "Feta og cherrytomater bages i ovnen og røres sammen med pastaen.",
    slots: [{ label: "Feta", types: ["feta"], core: true }],
    pantry: ["pasta", "cherrytomater", "hvidløg", "olivenolie"],
  },
  {
    id: "dal",
    name: "Linse-dal",
    description: "Røde linser kogt møre med tomat, løg, ingefær og karry. Serveres med ris.",
    slots: [
      { label: "Linser", types: ["linser"], core: true },
      { label: "Tomater", types: TOMATOES },
    ],
    pantry: ["ris", "løg", "ingefær", "karry"],
  },
  {
    id: "kikaertecurry",
    name: "Kikærtecurry",
    description: "Kikærter i tomat og karry med spinat, serveret med ris.",
    slots: [
      { label: "Kikærter", types: ["kikærter"], core: true },
      { label: "Tomater", types: TOMATOES },
      { label: "Fløde", types: ["madlavningsfløde"] },
    ],
    pantry: ["ris", "løg", "spinat", "karry"],
  },
  {
    id: "boennesuppe",
    name: "Suppe med hvide bønner",
    description: "Hvide bønner, tomat og rodfrugter kogt til en mættende suppe.",
    slots: [
      { label: "Hvide bønner", types: ["hvide_bønner"], core: true },
      { label: "Tomater", types: TOMATOES },
    ],
    pantry: ["løg", "gulerod", "bouillon", "brød"],
  },
  {
    id: "havregrod",
    name: "Havregrød",
    description: "Havregryn kogt i mælk, med frugt eller kanel på toppen.",
    slots: [
      { label: "Havregryn", types: ["havregryn"], core: true },
      { label: "Mælk", types: ["mælk"] },
    ],
    pantry: ["frugt eller kanel"],
  },
  {
    id: "overnight-oats",
    name: "Overnight oats",
    description: "Havregryn rørt i skyr eller yoghurt og sat på køl natten over.",
    slots: [
      { label: "Havregryn", types: ["havregryn"] },
      { label: "Skyr/yoghurt", types: THICK_DAIRY, core: true },
    ],
    pantry: ["bær", "honning"],
  },
  {
    id: "koldskaal",
    name: "Koldskål",
    description: "Kærnemælk pisket med æggeblomme, sukker, citron og vanilje.",
    slots: [
      { label: "Kærnemælk", types: ["kærnemælk"], core: true },
      { label: "Æg", types: ["æg"] },
    ],
    pantry: ["kammerjunkere", "citron", "vanilje", "sukker"],
  },
];

/** Normal-price reference kinds an offer's saving is computed against. */
const NORMAL_PRICE_KINDS: ReadonlySet<ReferenceKind> = new Set(["regular", "ean_reference"]);

/** A cheap item that can fill a recipe slot. */
export type MealItem =
  | {
      kind: "offer";
      /** Listing id (one offer can fill only one slot per dish). */
      id: string;
      typeId: string;
      price: number;
      /** What the same pack costs at the normal price, or null when unknown. */
      normalPrice: number | null;
      /** `normalPrice - price`, or null when no normal price is known. */
      saving: number | null;
      deal: EvaluatedDeal;
    }
  | {
      kind: "foodwaste";
      id: string;
      typeId: string;
      price: number;
      normalPrice: number | null;
      saving: number | null;
      item: FoodWasteItem;
    };

/** The taxonomy type id of a class key (`hakket_oksekød|fedt=8-12%|…` -> `hakket_oksekød`). */
export function typeIdOf(classKey: string | null | undefined): string | null {
  const id = classKey?.split("|")[0]?.trim();
  return id ? id : null;
}

/** Kroner rounded to whole øre (as the verdict compares them). */
const roundKr = (value: number): number => toOre(value) / 100;

/**
 * The cheapest normal unit price of exactly the same product for this user: a nearby chain's
 * shelf price or Salling's EAN price, in the offer's unit. Null when there is none.
 */
export function normalUnitPrice(
  deal: EvaluatedDeal,
  nearbyChains: ReadonlySet<string>,
): number | null {
  if (!deal.isExact) return null;
  const prices = deal.references
    .filter(
      (r) =>
        NORMAL_PRICE_KINDS.has(r.kind) &&
        referenceCounts(r, nearbyChains) &&
        (r.unit == null || r.unit === deal.unit),
    )
    .map((r) => r.unit_price);
  return prices.length ? Math.min(...prices) : null;
}

/**
 * An offer as a meal item, or null when it should not be suggested: not yet valid, its price
 * covers other products, it is cheaper elsewhere, or it is neither a good deal nor cheaper than
 * the normal price.
 *
 * The saving uses the offer's smallest pack (`sizeMin`), so for "250–400 g" it is what the
 * smallest pack would cost at the normal price: never more than the user can be sure of.
 */
export function offerItem(
  deal: EvaluatedDeal,
  nearbyChains: ReadonlySet<string>,
  now: Date,
): MealItem | null {
  if (Date.parse(deal.validFrom) > now.getTime()) return null;
  if (deal.priceApplies !== true) return null;
  if (deal.status === "cheaper_elsewhere" || deal.status === "pending") return null;
  const typeId = deal.typeId || typeIdOf(deal.classKey);
  if (!typeId) return null;
  const unitPrice = normalUnitPrice(deal, nearbyChains);
  const size = deal.sizeMin ?? deal.sizeMax;
  let normalPrice: number | null = null;
  let saving: number | null = null;
  if (unitPrice != null && size != null && size > 0) {
    normalPrice = roundKr(unitPrice * size);
    saving = Math.max(0, roundKr(normalPrice - deal.price));
  }
  if (deal.status !== "good_deal" && !(saving != null && saving > 0)) return null;
  return {
    kind: "offer",
    id: deal.listingId,
    typeId,
    price: deal.price,
    normalPrice,
    saving,
    deal,
  };
}

/** A clearance as a meal item; its saving is Salling's price before the markdown. */
export function foodWasteItem(item: FoodWasteItem): MealItem | null {
  const typeId = typeIdOf(item.classKey);
  if (!typeId) return null;
  const before = item.referencePrice;
  const known = before != null && Number.isFinite(before) && before > item.price;
  return {
    kind: "foodwaste",
    id: item.listingId,
    typeId,
    price: item.price,
    normalPrice: known ? before : null,
    saving: known ? roundKr(before - item.price) : null,
    item,
  };
}

/** Every suggestible item, grouped by taxonomy type id. */
export function mealItemsByType(
  deals: readonly EvaluatedDeal[],
  foodWaste: readonly FoodWasteItem[],
  nearbyChains: ReadonlySet<string>,
  now: Date,
): Map<string, MealItem[]> {
  const byType = new Map<string, MealItem[]>();
  const seen = new Set<string>();
  const add = (entry: MealItem | null) => {
    // One offer can have several variants of the same type; keep its first suggestible one.
    if (!entry || seen.has(`${entry.kind}:${entry.id}:${entry.typeId}`)) return;
    seen.add(`${entry.kind}:${entry.id}:${entry.typeId}`);
    const list = byType.get(entry.typeId);
    if (list) list.push(entry);
    else byType.set(entry.typeId, [entry]);
  };
  for (const deal of deals) add(offerItem(deal, nearbyChains, now));
  for (const item of foodWaste) add(foodWasteItem(item));
  for (const list of byType.values()) list.sort(compareItems);
  return byType;
}

/** The distance used to break ties: the clearance's store; offers are chain-wide. */
const itemDistance = (i: MealItem): number =>
  i.kind === "foodwaste" ? i.item.distanceKm : Number.POSITIVE_INFINITY;

/** Largest known saving first, then the cheaper pack, then the nearer clearance. */
function compareItems(a: MealItem, b: MealItem): number {
  return (
    (b.saving ?? 0) - (a.saving ?? 0) ||
    a.price - b.price ||
    itemDistance(a) - itemDistance(b) ||
    a.id.localeCompare(b.id)
  );
}

export interface FilledSlot {
  slot: RecipeSlot;
  item: MealItem;
}

export interface MealIdea {
  recipe: Recipe;
  filled: FilledSlot[];
  /** Slots with nothing on offer or cleared: bought at the normal price. */
  missing: RecipeSlot[];
  /** Sum of the known savings of the filled slots (kr., whole øre). */
  totalSaving: number;
  /** Number of filled slots whose saving is unknown (good deals without a normal price). */
  unknownSavings: number;
}

/** A recipe filled with the best item per slot, or null when a core slot cannot be filled. */
export function fillRecipe(
  recipe: Recipe,
  byType: ReadonlyMap<string, readonly MealItem[]>,
): MealIdea | null {
  const used = new Set<string>();
  const filled: FilledSlot[] = [];
  const missing: RecipeSlot[] = [];
  for (const slot of recipe.slots) {
    const options = slot.types
      .flatMap((t) => byType.get(t) ?? [])
      .filter((i) => !used.has(`${i.kind}:${i.id}`))
      .sort(compareItems);
    const best = options[0];
    if (best) {
      used.add(`${best.kind}:${best.id}`);
      filled.push({ slot, item: best });
    } else if (slot.core) {
      return null;
    } else {
      missing.push(slot);
    }
  }
  if (filled.length === 0) return null;
  const totalSaving = roundKr(filled.reduce((sum, f) => sum + (f.item.saving ?? 0), 0));
  const unknownSavings = filled.filter((f) => f.item.saving == null).length;
  return { recipe, filled, missing, totalSaving, unknownSavings };
}

/** At most this many ideas are shown. */
export const MAX_IDEAS = 5;

/** Best idea first: largest saving, then most ingredients covered, then using both sources. */
function compareIdeas(a: MealIdea, b: MealIdea): number {
  const mixed = (i: MealIdea) => new Set(i.filled.map((f) => f.item.kind)).size;
  return (
    b.totalSaving - a.totalSaving ||
    b.filled.length - a.filled.length ||
    mixed(b) - mixed(a) ||
    a.recipe.name.localeCompare(b.recipe.name, "da-DK")
  );
}

/** The main item of an idea: its first core slot (the item the dish is built around). */
function mainItemKey(idea: MealIdea): string {
  const main = idea.filled.find((f) => f.slot.core) ?? idea.filled[0];
  return main ? `${main.item.kind}:${main.item.id}` : idea.recipe.id;
}

/**
 * Up to {@link MAX_IDEAS} dishes from this week's cheap items, best saving first. Each idea is
 * built around a different main item, so five ideas never all hinge on the same pack of mince.
 */
export function mealIdeas(
  deals: readonly EvaluatedDeal[],
  foodWaste: readonly FoodWasteItem[],
  nearbyChains: ReadonlySet<string>,
  now: Date,
  recipes: readonly Recipe[] = RECIPES,
): MealIdea[] {
  const byType = mealItemsByType(deals, foodWaste, nearbyChains, now);
  const ideas = recipes
    .map((r) => fillRecipe(r, byType))
    .filter((i): i is MealIdea => i != null)
    .sort(compareIdeas);
  const chosen: MealIdea[] = [];
  const mains = new Set<string>();
  for (const idea of ideas) {
    const main = mainItemKey(idea);
    if (mains.has(main)) continue;
    mains.add(main);
    chosen.push(idea);
    if (chosen.length === MAX_IDEAS) break;
  }
  return chosen;
}
