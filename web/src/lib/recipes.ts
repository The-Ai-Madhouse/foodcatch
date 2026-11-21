/**
 * The dish catalogue of "Madideer" (docs/ui.md §13): everyday lunches and dinners built from the
 * staples the pipeline recognizes (taxonomy type ids, pipeline `matching/taxonomy.py`).
 *
 * Amounts are for the stated number of servings. Price estimates (`estimateKr`) are rough Danish
 * discount-store normal prices (late 2026) for the amount used. They are only a fallback when no
 * real product is found near the user (`lib/pantry.ts`, docs/ui.md §23), always shown as "ca.",
 * and never used for a saving.
 */

export type Meal = "frokost" | "aftensmad";

/** The unit of a slot's amount: the comparison unit of its taxonomy types. */
export type SlotUnit = "kg" | "l" | "stk";

/** One ingredient slot of a dish: any of `types` fills it. */
export interface RecipeSlot {
  /** Danish name of the ingredient ("Hakket oksekød"). */
  label: string;
  types: readonly string[];
  /** Amount the dish uses, in `unit`. */
  amount: number;
  unit: SlotUnit;
  /** Rough normal price of `amount` (kr.), for the dish-cost estimate. */
  estimateKr: number;
  /** A core slot must be on offer or cleared for the dish to be suggested. */
  core?: boolean;
}

/** Something else the dish needs, bought at the normal price or found at home. */
export interface PantryItem {
  name: string;
  /** Danish amount text ("500 g", "1 stk.", "2 spsk."). */
  amount: string;
  /** Rough price of the amount used (kr.). */
  estimateKr: number;
  /** A basic most kitchens have (oil, spices, onion): expected at home, pre-ticked. */
  basic?: boolean;
}

export interface Recipe {
  id: string;
  /** Danish dish name. */
  name: string;
  meal: Meal;
  servings: number;
  /** Rough total time from start to table, in minutes. */
  minutes: number;
  /** One Danish sentence on what it is. */
  description: string;
  slots: readonly RecipeSlot[];
  pantry: readonly PantryItem[];
  /** The method, one Danish step per entry. */
  steps: readonly string[];
  /** A real recipe for the same dish on a known Danish recipe site (verified to load). */
  source?: RecipeSource;
}

export interface RecipeSource {
  url: string;
  /** Site name as shown ("Valdemarsro", "Arla"). */
  site: string;
}

const MINCED_BEEF = ["hakket_oksekød", "hakket_okse_gris"];
const MINCED_MIXED = ["hakket_gris_kalv", "hakket_grisekød", "hakket_okse_gris"];
const MINCED_POULTRY = ["hakket_kylling", "hakket_kalkun"];
const CHICKEN_FILLET = ["kyllingebryst", "kyllingeinderfilet"];
const CHICKEN_ANY = ["kyllingebryst", "kyllingeinderfilet", "kyllingelår"];
const TOMATOES = ["hakkede_tomater", "flåede_tomater", "passata"];
const BEANS = ["kidneybønner", "sorte_bønner"];
const CREAM = ["madlavningsfløde", "piskefløde"];
const YOGHURT = ["græsk_yoghurt", "yoghurt", "skyr"];
const CHEESE = ["fast_ost", "mozzarella"];

function slot(
  label: string,
  types: readonly string[],
  amount: number,
  unit: SlotUnit,
  estimateKr: number,
  core = false,
): RecipeSlot {
  return { label, types, amount, unit, estimateKr, core };
}

const p = (name: string, amount: string, estimateKr: number): PantryItem => ({
  name,
  amount,
  estimateKr,
});

/** A basic expected at home (see {@link PantryItem.basic}). */
const b = (name: string, amount: string, estimateKr: number): PantryItem => ({
  ...p(name, amount, estimateKr),
  basic: true,
});

// Shared pantry items.
const ONION = b("løg", "1 stk.", 2);
const GARLIC = b("hvidløg", "2 fed", 1);
const OIL = b("olie", "2 spsk.", 1);
const RICE = p("ris", "300 g", 6);
const PASTA = p("pasta", "400 g", 8);
const RYE = p("rugbrød", "4 skiver", 6);
const PITA = p("pitabrød", "4 stk.", 10);
const TORTILLA = p("tortillas", "6 stk.", 12);
const SALAD = p("salat", "1 hoved", 10);
const CUCUMBER = p("agurk", "1/2 stk.", 4);
const TOMATO_FRESH = p("tomater", "3 stk.", 6);
const POTATOES = p("kartofler", "1 kg", 10);
const BOUILLON = b("bouillon", "1 terning", 1);
const SPICES = b("krydderier", "efter smag", 2);

export const RECIPES: readonly Recipe[] = [
  // ------------------------------------------------------------------ frokost
  {
    id: "aeggemadder",
    name: "Rugbrød med æg og tomat",
    meal: "frokost",
    servings: 2,
    minutes: 15,
    description: "Klassisk dansk frokost: kogte æg i skiver på rugbrød med tomat og karse.",
    slots: [slot("Æg", ["æg"], 4, "stk", 12, true)],
    pantry: [RYE, TOMATO_FRESH, p("karse", "1 bakke", 8), p("mayonnaise", "2 spsk.", 2)],
    steps: [
      "Kog æggene i 8–9 minutter, og køl dem af i koldt vand.",
      "Smør rugbrødet med lidt mayonnaise.",
      "Pil æggene, skær dem i skiver, og læg dem på brødet med tomatskiver.",
      "Drys med karse, salt og peber.",
    ],
  },
  {
    id: "tunsalat",
    name: "Tunsalat på rugbrød",
    source: { site: "Valdemarsro", url: "https://www.valdemarsro.dk/tunsalat/" },
    meal: "frokost",
    servings: 2,
    minutes: 10,
    description: "Cremet tunsalat med rødløg og citron på rugbrød.",
    slots: [
      slot("Tun", ["tun"], 0.13, "kg", 14, true),
      slot("Creme fraiche/skyr", ["creme_fraiche", "skyr", "græsk_yoghurt"], 0.1, "kg", 5),
    ],
    pantry: [RYE, p("rødløg", "1/2 stk.", 1), p("citron", "1/2 stk.", 2), CUCUMBER],
    steps: [
      "Hæld tunen fra, og mos den med en gaffel.",
      "Rør creme fraiche, finthakket rødløg, citronsaft, salt og peber i.",
      "Server på rugbrød med agurkeskiver.",
    ],
  },
  {
    id: "tun-pastasalat",
    name: "Pastasalat med tun",
    source: { site: "Mummum", url: "https://mummum.dk/pastasalat-med-tun/" },
    meal: "frokost",
    servings: 2,
    minutes: 20,
    description: "Kold pastasalat med tun, ærter og en let dressing – god i madpakken.",
    slots: [
      slot("Tun", ["tun"], 0.13, "kg", 14, true),
      slot("Creme fraiche/yoghurt", ["creme_fraiche", ...YOGHURT], 0.1, "kg", 5),
    ],
    pantry: [p("pasta", "200 g", 4), p("frosne ærter", "100 g", 3), p("citron", "1/2 stk.", 2)],
    steps: [
      "Kog pastaen, og skyl den kold. Kom ærterne i de sidste 2 minutter.",
      "Rør creme fraiche med citronsaft, salt og peber.",
      "Vend pasta, ærter og tun i dressingen.",
    ],
  },
  {
    id: "kyllingewraps",
    name: "Wraps med kylling",
    source: { site: "Arla", url: "https://www.arla.dk/opskrifter/lun-kyllingewrap/" },
    meal: "frokost",
    servings: 2,
    minutes: 25,
    description: "Tortillas med stegt kylling, grønt og yoghurtdressing.",
    slots: [
      slot("Kyllingefilet", CHICKEN_FILLET, 0.3, "kg", 30, true),
      slot("Yoghurt/creme fraiche", [...YOGHURT, "creme_fraiche"], 0.1, "kg", 4),
    ],
    pantry: [p("tortillas", "4 stk.", 8), SALAD, p("peberfrugt", "1 stk.", 5), SPICES],
    steps: [
      "Skær kyllingen i strimler, krydr med salt, peber og paprika, og steg den gennem.",
      "Rør yoghurt med salt, peber og lidt hvidløg.",
      "Varm tortillas, fyld dem med salat, peberfrugt, kylling og dressing, og rul dem.",
    ],
  },
  {
    id: "kyllingesalat-feta",
    name: "Kyllingesalat med feta",
    meal: "frokost",
    servings: 2,
    minutes: 25,
    description: "Stegt kyllingefilet over salat med feta, tomat og agurk.",
    slots: [
      slot("Kyllingefilet", CHICKEN_FILLET, 0.3, "kg", 30, true),
      slot("Feta", ["feta"], 0.1, "kg", 8, true),
    ],
    pantry: [SALAD, TOMATO_FRESH, CUCUMBER, OIL],
    steps: [
      "Steg kyllingen gennem, og skær den i skiver.",
      "Skyl og skær salat, tomat og agurk.",
      "Fordel kyllingen over salaten, smuldr feta over, og dryp med olie og salt.",
    ],
  },
  {
    id: "graesk-salat",
    name: "Græsk salat med brød",
    source: { site: "Valdemarsro", url: "https://www.valdemarsro.dk/graesk-salat/" },
    meal: "frokost",
    servings: 2,
    minutes: 10,
    description: "Tomat, agurk og rødløg med feta og oliven, serveret med brød.",
    slots: [slot("Feta", ["feta"], 0.15, "kg", 12, true)],
    pantry: [TOMATO_FRESH, CUCUMBER, p("rødløg", "1/2 stk.", 1), p("oliven", "50 g", 5), OIL],
    steps: [
      "Skær tomat og agurk i tern og rødløg i tynde ringe.",
      "Vend med oliven, olie, salt og oregano.",
      "Læg fetaen over i skiver, og server med brød.",
    ],
  },
  {
    id: "shakshuka",
    name: "Shakshuka",
    source: { site: "Valdemarsro", url: "https://www.valdemarsro.dk/shakshuka/" },
    meal: "frokost",
    servings: 2,
    minutes: 30,
    description: "Æg pocheret i krydret tomatsauce med løg og peberfrugt, gerne med feta.",
    slots: [
      slot("Æg", ["æg"], 4, "stk", 12, true),
      slot("Tomater", TOMATOES, 0.4, "kg", 6, true),
      slot("Feta", ["feta"], 0.05, "kg", 4),
    ],
    pantry: [
      ONION,
      p("peberfrugt", "1 stk.", 5),
      b("spidskommen", "1 tsk.", 1),
      p("brød", "4 skiver", 5),
    ],
    steps: [
      "Svits hakket løg og peberfrugt i olie, til det er blødt. Tilsæt spidskommen.",
      "Hæld tomaterne i, og lad saucen simre i 10 minutter. Smag til med salt og peber.",
      "Lav fire huller i saucen, slå æggene ud i dem, og læg låg på i 6–8 minutter.",
      "Smuldr feta over, og server med brød.",
    ],
  },
  {
    id: "aeggekage",
    name: "Æggekage",
    source: { site: "Valdemarsro", url: "https://www.valdemarsro.dk/aeggekage-opskrift/" },
    meal: "frokost",
    servings: 2,
    minutes: 20,
    description: "Æg og mælk på panden med grønt og ost, til rugbrød.",
    slots: [
      slot("Æg", ["æg"], 6, "stk", 18, true),
      slot("Mælk", ["mælk"], 0.1, "l", 1),
      slot("Ost", ["fast_ost"], 0.05, "kg", 5),
    ],
    pantry: [RYE, TOMATO_FRESH, p("purløg", "1 bundt", 6)],
    steps: [
      "Pisk æg, mælk, salt og peber sammen.",
      "Hæld det på en varm pande med lidt fedtstof, og lad det stivne ved svag varme under låg.",
      "Drys revet ost over til sidst, og pynt med tomat og purløg. Server med rugbrød.",
    ],
  },
  {
    id: "quesadillas",
    name: "Quesadillas med bønner og ost",
    source: {
      site: "Valdemarsro",
      url: "https://www.valdemarsro.dk/vegetar-quesadillas-med-stegte-boenner/",
    },
    meal: "frokost",
    servings: 2,
    minutes: 20,
    description: "Sprøde tortillas fyldt med krydrede bønner og smeltet ost.",
    slots: [
      slot("Bønner", BEANS, 0.24, "kg", 8, true),
      slot("Ost", CHEESE, 0.1, "kg", 9, true),
      slot("Creme fraiche", ["creme_fraiche"], 0.1, "kg", 5),
    ],
    pantry: [p("tortillas", "4 stk.", 8), p("majs", "1/2 dåse", 4), SPICES],
    steps: [
      "Skyl bønnerne, og mos dem groft med spidskommen, salt og majs.",
      "Fordel bønnerne og revet ost på halvdelen af hver tortilla, og fold den sammen.",
      "Steg på tør pande 2–3 minutter på hver side, til osten er smeltet.",
      "Skær i trekanter, og server med creme fraiche.",
    ],
  },
  {
    id: "hummus",
    name: "Pitabrød med hjemmelavet hummus",
    source: { site: "Mummum", url: "https://mummum.dk/hjemmelavet-hummus/" },
    meal: "frokost",
    servings: 2,
    minutes: 15,
    description: "Hummus af kikærter med citron og hvidløg i pitabrød med grønt.",
    slots: [slot("Kikærter", ["kikærter"], 0.24, "kg", 8, true)],
    pantry: [p("tahin", "2 spsk.", 5), p("citron", "1 stk.", 3), GARLIC, PITA, CUCUMBER],
    steps: [
      "Skyl kikærterne, og blend dem med tahin, citronsaft, hvidløg, olie og lidt vand.",
      "Smag til med salt og spidskommen.",
      "Fyld pitabrødene med hummus, agurk og andet grønt.",
    ],
  },
  {
    id: "linsesalat",
    name: "Linsesalat med feta",
    source: {
      site: "Arla",
      url: "https://www.arla.dk/opskrifter/linsesalat-med-salatost-og-hvidlogsbrod/",
    },
    meal: "frokost",
    servings: 2,
    minutes: 30,
    description: "Lune linser med rødløg, persille og citron, toppet med feta.",
    slots: [slot("Linser", ["linser"], 0.15, "kg", 6, true), slot("Feta", ["feta"], 0.1, "kg", 8)],
    pantry: [
      p("rødløg", "1/2 stk.", 1),
      p("persille", "1 bundt", 6),
      p("citron", "1 stk.", 3),
      OIL,
    ],
    steps: [
      "Kog linserne møre efter anvisningen (ca. 15–20 minutter), og hæld vandet fra.",
      "Vend dem med hakket rødløg, persille, citronsaft, olie, salt og peber.",
      "Smuldr feta over.",
    ],
  },
  {
    id: "tomatsuppe",
    name: "Tomatsuppe med brød",
    source: { site: "Arla", url: "https://www.arla.dk/opskrifter/tomatsuppe-med-fraiche/" },
    meal: "frokost",
    servings: 2,
    minutes: 30,
    description: "Hurtig tomatsuppe med løg og hvidløg, rundet af med lidt fløde.",
    slots: [slot("Tomater", TOMATOES, 0.8, "kg", 12, true), slot("Fløde", CREAM, 0.1, "l", 4)],
    pantry: [ONION, GARLIC, BOUILLON, p("brød", "4 skiver", 5)],
    steps: [
      "Svits hakket løg og hvidløg i olie.",
      "Tilsæt tomater, bouillon og 3 dl vand, og lad det simre i 15 minutter.",
      "Blend suppen, rør fløden i, og smag til med salt, peber og lidt sukker.",
    ],
  },
  {
    id: "boennesuppe",
    name: "Suppe med hvide bønner",
    source: { site: "Valdemarsro", url: "https://www.valdemarsro.dk/minestronesuppe/" },
    meal: "frokost",
    servings: 2,
    minutes: 30,
    description: "Hvide bønner, tomat og gulerod kogt til en mættende suppe.",
    slots: [
      slot("Hvide bønner", ["hvide_bønner"], 0.24, "kg", 8, true),
      slot("Tomater", TOMATOES, 0.4, "kg", 6),
    ],
    pantry: [ONION, p("gulerødder", "2 stk.", 2), BOUILLON, p("brød", "4 skiver", 5)],
    steps: [
      "Svits løg og gulerod i tern i olie.",
      "Tilsæt tomater, bouillon og 5 dl vand, og kog i 15 minutter.",
      "Kom de skyllede bønner i, og varm igennem. Smag til med salt, peber og timian.",
    ],
  },
  {
    id: "hytteost-rugbroed",
    name: "Rugbrød med hytteost og grønt",
    meal: "frokost",
    servings: 2,
    minutes: 5,
    description: "Hytteost på rugbrød med radiser, agurk og karse.",
    slots: [slot("Hytteost", ["hytteost"], 0.25, "kg", 12, true)],
    pantry: [RYE, p("radiser", "1 bundt", 8), CUCUMBER, p("karse", "1 bakke", 8)],
    steps: [
      "Fordel hytteosten på rugbrødet.",
      "Top med skiver af radiser og agurk og karse. Drys med salt og peber.",
    ],
  },
  {
    id: "kyllingefrikadeller",
    name: "Kyllingefrikadeller i pita",
    source: { site: "Valdemarsro", url: "https://www.valdemarsro.dk/kyllingefrikadeller/" },
    meal: "frokost",
    servings: 2,
    minutes: 35,
    description: "Små frikadeller af hakket fjerkræ i pitabrød med salat og yoghurtdressing.",
    slots: [
      slot("Hakket kylling/kalkun", MINCED_POULTRY, 0.4, "kg", 30, true),
      slot("Æg", ["æg"], 1, "stk", 3),
      slot("Yoghurt", YOGHURT, 0.1, "kg", 4),
    ],
    pantry: [PITA, SALAD, CUCUMBER, b("havregryn", "3 spsk.", 1)],
    steps: [
      "Rør farsen med æg, havregryn, salt, peber og eventuelt revet løg.",
      "Form små frikadeller, og steg dem gennem ved middel varme, ca. 4 minutter på hver side.",
      "Rør yoghurt med hvidløg og salt.",
      "Fyld pitabrødene med salat, agurk, frikadeller og dressing.",
    ],
  },
  // ------------------------------------------------------------------ aftensmad
  {
    id: "bolognese",
    name: "Spaghetti bolognese",
    source: { site: "Valdemarsro", url: "https://www.valdemarsro.dk/spaghetti-bolognese/" },
    meal: "aftensmad",
    servings: 4,
    minutes: 50,
    description: "Kødsauce med løg, gulerod og tomat, kogt ind og serveret med spaghetti.",
    slots: [
      slot("Hakket kød", [...MINCED_BEEF, "hakket_grisekød"], 0.5, "kg", 45, true),
      slot("Tomater", TOMATOES, 0.8, "kg", 12),
      slot("Tomatpuré", ["tomatpuré"], 0.05, "kg", 3),
    ],
    pantry: [p("spaghetti", "500 g", 10), ONION, p("gulerødder", "2 stk.", 2), GARLIC],
    steps: [
      "Brun kødet i en gryde, og tag det op. Svits hakket løg, revet gulerod og hvidløg.",
      "Kom kødet tilbage med tomatpuré, tomater, salt, peber og oregano.",
      "Lad saucen simre under låg i mindst 30 minutter.",
      "Kog spaghettien efter anvisningen, og server med saucen.",
    ],
  },
  {
    id: "chili",
    name: "Chili con carne",
    source: { site: "Valdemarsro", url: "https://www.valdemarsro.dk/chili-con-carne/" },
    meal: "aftensmad",
    servings: 4,
    minutes: 45,
    description: "Kødet brunes med løg og krydderier og simrer med bønner og tomat.",
    slots: [
      slot("Hakket oksekød", MINCED_BEEF, 0.5, "kg", 45, true),
      slot("Bønner", BEANS, 0.48, "kg", 16),
      slot("Tomater", TOMATOES, 0.8, "kg", 12),
      slot("Creme fraiche", ["creme_fraiche"], 0.2, "kg", 10),
    ],
    pantry: [RICE, ONION, GARLIC, b("chili og spidskommen", "2 tsk.", 2)],
    steps: [
      "Brun kødet med hakket løg og hvidløg. Tilsæt chili og spidskommen.",
      "Kom tomater og skyllede bønner i, og lad det simre i 20–30 minutter.",
      "Smag til med salt og peber, og server med ris og creme fraiche.",
    ],
  },
  {
    id: "chili-sin-carne",
    name: "Chili sin carne",
    source: { site: "Valdemarsro", url: "https://www.valdemarsro.dk/chili-sin-carne/" },
    meal: "aftensmad",
    servings: 4,
    minutes: 35,
    description: "Vegetarisk chili af bønner og tomat med løg, peberfrugt og spidskommen.",
    slots: [
      slot("Bønner", BEANS, 0.72, "kg", 24, true),
      slot("Tomater", TOMATOES, 0.8, "kg", 12, true),
      slot("Creme fraiche", ["creme_fraiche"], 0.2, "kg", 10),
    ],
    pantry: [RICE, ONION, p("peberfrugt", "2 stk.", 10), b("chili og spidskommen", "2 tsk.", 2)],
    steps: [
      "Svits løg og peberfrugt i tern med chili og spidskommen.",
      "Tilsæt tomater og skyllede bønner, og lad det simre i 20 minutter.",
      "Smag til med salt, og server med ris og creme fraiche.",
    ],
  },
  {
    id: "lasagne",
    name: "Lasagne",
    source: { site: "Valdemarsro", url: "https://www.valdemarsro.dk/lasagne/" },
    meal: "aftensmad",
    servings: 4,
    minutes: 90,
    description: "Kødsauce og hvid sovs i lag med pasta, ost på toppen og 45 minutter i ovnen.",
    slots: [
      slot("Hakket kød", MINCED_BEEF, 0.5, "kg", 45, true),
      slot("Tomater", TOMATOES, 0.8, "kg", 12),
      slot("Mælk", ["mælk"], 0.5, "l", 6),
      slot("Ost", CHEESE, 0.1, "kg", 9),
      slot("Smør", ["smør"], 0.04, "kg", 5),
    ],
    pantry: [p("lasagneplader", "250 g", 8), b("hvedemel", "4 spsk.", 1), ONION],
    steps: [
      "Lav en kødsauce: brun kødet med løg, tilsæt tomater, salt og peber, og lad det simre i 20 minutter.",
      "Lav hvid sovs: smelt smørret, rør mel i, og pisk mælken i lidt ad gangen. Kog op, og smag til.",
      "Læg kødsauce, lasagneplader og hvid sovs i lag i et fad. Slut med hvid sovs og ost.",
      "Bag ved 200 °C i ca. 45 minutter.",
    ],
  },
  {
    id: "frikadeller",
    name: "Frikadeller med kartofler",
    source: { site: "Valdemarsro", url: "https://www.valdemarsro.dk/frikadeller/" },
    meal: "aftensmad",
    servings: 4,
    minutes: 50,
    description: "Fars af kød, æg, mælk og løg, stegt på panden og serveret med kartofler.",
    slots: [
      slot("Hakket kød", MINCED_MIXED, 0.5, "kg", 35, true),
      slot("Æg", ["æg"], 1, "stk", 3),
      slot("Mælk", ["mælk"], 0.1, "l", 1),
    ],
    pantry: [POTATOES, ONION, b("havregryn eller rasp", "4 spsk.", 1), p("grønt", "efter smag", 8)],
    steps: [
      "Rør farsen med revet løg, æg, havregryn, mælk, salt og peber. Lad den hvile 15 minutter.",
      "Kog kartoflerne.",
      "Form frikadeller med en ske, og steg dem i fedtstof ca. 5 minutter på hver side.",
      "Server med kartofler og grønt.",
    ],
  },
  {
    id: "kyllingekarry",
    name: "Kylling i karry",
    source: { site: "Arla", url: "https://www.arla.dk/opskrifter/kylling-i-karry/" },
    meal: "aftensmad",
    servings: 4,
    minutes: 35,
    description: "Kyllingen steges med løg og karry og simrer i fløde. Serveres med ris.",
    slots: [slot("Kylling", CHICKEN_ANY, 0.6, "kg", 50, true), slot("Fløde", CREAM, 0.25, "l", 10)],
    pantry: [RICE, ONION, b("karry", "2 tsk.", 1), p("æble", "1 stk.", 3)],
    steps: [
      "Skær kyllingen i stykker, og brun den. Tag den op.",
      "Svits løg og æble i tern med karry.",
      "Kom kyllingen tilbage med fløden, og lad det simre i 10–15 minutter.",
      "Smag til med salt, og server med ris.",
    ],
  },
  {
    id: "ovnkylling",
    name: "Ovnstegt kylling med rodfrugter",
    source: {
      site: "Valdemarsro",
      url: "https://www.valdemarsro.dk/alt-i-en-gryde-med-hanekylling-og-rodfrugter/",
    },
    meal: "aftensmad",
    servings: 4,
    minutes: 60,
    description: "Kyllingen steges i ovnen på et lag af kartofler og rodfrugter.",
    slots: [slot("Kylling", ["hel_kylling", "kyllingelår"], 1.2, "kg", 45, true)],
    pantry: [POTATOES, p("gulerødder", "4 stk.", 4), ONION, OIL],
    steps: [
      "Skær kartofler, gulerødder og løg i stykker, og vend dem med olie, salt og timian i et fad.",
      "Læg kyllingen ovenpå, og krydr den med salt og peber.",
      "Steg ved 200 °C, til kødet er gennemstegt: lår ca. 45 minutter, hel kylling ca. 1 time og 15 minutter.",
    ],
  },
  {
    id: "kylling-kikaerter",
    name: "Kyllingelår med kikærter",
    meal: "aftensmad",
    servings: 4,
    minutes: 55,
    description: "Kyllingelår og kikærter bages i et fad med citron, hvidløg og paprika.",
    slots: [
      slot("Kyllingelår", ["kyllingelår"], 1, "kg", 35, true),
      slot("Kikærter", ["kikærter"], 0.48, "kg", 16, true),
    ],
    pantry: [p("citron", "1 stk.", 3), GARLIC, b("paprika", "2 tsk.", 1), SALAD],
    steps: [
      "Vend skyllede kikærter med olie, hvidløg, paprika og salt i et fad.",
      "Læg kyllingelårene ovenpå, krydr dem, og læg citronbåde imellem.",
      "Bag ved 200 °C i ca. 45 minutter, til kyllingen er gennemstegt.",
      "Server med salat.",
    ],
  },
  {
    id: "kylling-tzatziki",
    name: "Kyllingespyd med tzatziki",
    source: { site: "Valdemarsro", url: "https://www.valdemarsro.dk/krydrede-kyllingelaar/" },
    meal: "aftensmad",
    servings: 4,
    minutes: 35,
    description: "Marineret kylling på panden med tzatziki af yoghurt, agurk og hvidløg.",
    slots: [
      slot("Kyllingefilet", CHICKEN_FILLET, 0.6, "kg", 55, true),
      slot("Græsk yoghurt", YOGHURT, 0.3, "kg", 12, true),
    ],
    pantry: [CUCUMBER, GARLIC, PITA, TOMATO_FRESH],
    steps: [
      "Skær kyllingen i tern, vend med olie, citron, oregano og salt, og sæt på spyd.",
      "Riv agurken, pres væden ud, og rør den med yoghurt, hvidløg og salt.",
      "Steg spyddene på pande eller grill, til de er gennemstegte.",
      "Server i pitabrød med tomat og tzatziki.",
    ],
  },
  {
    id: "moerbradgryde",
    name: "Mørbradgryde",
    source: { site: "Arla", url: "https://www.arla.dk/opskrifter/morbradgryde/" },
    meal: "aftensmad",
    servings: 4,
    minutes: 35,
    description: "Mørbrad i skiver brunes med løg og svampe og simrer i fløde med tomatpuré.",
    slots: [
      slot("Svinemørbrad", ["svinemørbrad"], 0.6, "kg", 60, true),
      slot("Fløde", CREAM, 0.25, "l", 10),
      slot("Tomatpuré", ["tomatpuré"], 0.05, "kg", 3),
    ],
    pantry: [RICE, p("champignon", "250 g", 10), ONION, b("paprika", "1 tsk.", 1)],
    steps: [
      "Skær mørbraden i skiver, og brun dem. Tag dem op.",
      "Svits løg og svampe. Rør tomatpuré og paprika i.",
      "Tilsæt fløde og mørbrad, og lad det simre i 10 minutter.",
      "Smag til med salt og peber, og server med ris.",
    ],
  },
  {
    id: "koteletter",
    name: "Koteletter i fad",
    source: { site: "Valdemarsro", url: "https://www.valdemarsro.dk/koteletter-i-fad/" },
    meal: "aftensmad",
    servings: 4,
    minutes: 45,
    description: "Brunede koteletter bages færdige i fløde med løg og serveres med kartofler.",
    slots: [
      slot("Svinekoteletter", ["svinekoteletter"], 0.8, "kg", 50, true),
      slot("Fløde", CREAM, 0.25, "l", 10),
    ],
    pantry: [POTATOES, ONION, p("grønne bønner", "400 g", 12)],
    steps: [
      "Brun koteletterne på panden, krydr dem, og læg dem i et fad.",
      "Svits løg i ringe, fordel dem over kødet, og hæld fløden over.",
      "Bag ved 200 °C i ca. 25 minutter.",
      "Server med kartofler og grønne bønner.",
    ],
  },
  {
    id: "tunpasta",
    name: "Pasta med tun og tomat",
    source: { site: "Valdemarsro", url: "https://www.valdemarsro.dk/pasta-med-tunsauce/" },
    meal: "aftensmad",
    servings: 4,
    minutes: 25,
    description: "Hurtig tomatsauce med tun, løg og kapers vendt med pasta.",
    slots: [slot("Tun", ["tun"], 0.26, "kg", 28, true), slot("Tomater", TOMATOES, 0.8, "kg", 12)],
    pantry: [PASTA, ONION, GARLIC, p("kapers", "2 spsk.", 4)],
    steps: [
      "Svits løg og hvidløg i olie, tilsæt tomaterne, og lad det simre i 10 minutter.",
      "Kog pastaen.",
      "Rør tun og kapers i saucen, smag til, og vend med pastaen.",
    ],
  },
  {
    id: "pizza",
    name: "Hjemmelavet pizza",
    source: { site: "Valdemarsro", url: "https://www.valdemarsro.dk/hjemmelavet-pizza/" },
    meal: "aftensmad",
    servings: 4,
    minutes: 90,
    description: "Pizzabund med tomatsauce og mozzarella, bagt ved høj varme.",
    slots: [
      slot("Mozzarella", ["mozzarella"], 0.25, "kg", 16, true),
      slot("Tomatsauce", ["passata", "hakkede_tomater", "flåede_tomater"], 0.4, "kg", 8),
    ],
    pantry: [
      p("hvedemel", "500 g", 5),
      b("gær", "1/2 pakke", 1),
      OIL,
      p("basilikum", "1 potte", 10),
    ],
    steps: [
      "Rør dej af mel, gær, 3 dl lunkent vand, olie og salt, og lad den hæve i 1 time.",
      "Smag tomaterne til med salt, oregano og hvidløg.",
      "Rul dejen ud, fordel sauce og mozzarella, og bag ved 250 °C i 10–12 minutter.",
      "Top med frisk basilikum.",
    ],
  },
  {
    id: "feta-pasta",
    name: "Pasta med bagt feta",
    source: { site: "Valdemarsro", url: "https://www.valdemarsro.dk/feta-pasta-med-tomat/" },
    meal: "aftensmad",
    servings: 4,
    minutes: 40,
    description: "Feta og cherrytomater bages i ovnen og røres sammen med pastaen.",
    slots: [slot("Feta", ["feta"], 0.2, "kg", 15, true)],
    pantry: [PASTA, p("cherrytomater", "500 g", 15), GARLIC, OIL],
    steps: [
      "Læg feta midt i et fad med cherrytomater og hvidløg rundt om. Dryp med olie.",
      "Bag ved 200 °C i 30 minutter.",
      "Kog pastaen, mos feta og tomater sammen, og vend pastaen i.",
    ],
  },
  {
    id: "dal",
    name: "Linse-dal",
    source: { site: "Valdemarsro", url: "https://www.valdemarsro.dk/dhal/" },
    meal: "aftensmad",
    servings: 4,
    minutes: 35,
    description: "Røde linser kogt møre med tomat, løg, ingefær og karry. Serveres med ris.",
    slots: [
      slot("Linser", ["linser"], 0.3, "kg", 12, true),
      slot("Tomater", TOMATOES, 0.4, "kg", 6),
    ],
    pantry: [RICE, ONION, p("ingefær", "1 stk.", 3), b("karry", "2 tsk.", 1)],
    steps: [
      "Svits løg, revet ingefær og karry i olie.",
      "Tilsæt linser, tomater og 8 dl vand, og kog i ca. 20 minutter, til linserne er møre.",
      "Smag til med salt og citron, og server med ris.",
    ],
  },
  {
    id: "kikaertecurry",
    name: "Kikærtecurry",
    source: { site: "Valdemarsro", url: "https://www.valdemarsro.dk/chana-masala/" },
    meal: "aftensmad",
    servings: 4,
    minutes: 30,
    description: "Kikærter i tomat og karry med spinat, serveret med ris.",
    slots: [
      slot("Kikærter", ["kikærter"], 0.48, "kg", 16, true),
      slot("Tomater", TOMATOES, 0.4, "kg", 6),
      slot("Fløde", ["madlavningsfløde"], 0.25, "l", 10),
    ],
    pantry: [RICE, ONION, p("frossen spinat", "250 g", 8), b("karry", "2 tsk.", 1)],
    steps: [
      "Svits løg og karry i olie.",
      "Tilsæt tomater, skyllede kikærter og fløde, og lad det simre i 15 minutter.",
      "Rør spinaten i til sidst, smag til, og server med ris.",
    ],
  },
  {
    id: "tacos",
    name: "Tacos med oksekød",
    source: { site: "Arla", url: "https://www.arla.dk/opskrifter/tacos-med-oksekod/" },
    meal: "aftensmad",
    servings: 4,
    minutes: 25,
    description: "Krydret oksekød med bønner i tortillas med grønt og creme fraiche.",
    slots: [
      slot("Hakket oksekød", MINCED_BEEF, 0.5, "kg", 45, true),
      slot("Bønner", BEANS, 0.24, "kg", 8),
      slot("Creme fraiche", ["creme_fraiche"], 0.2, "kg", 10),
      slot("Ost", ["fast_ost"], 0.1, "kg", 9),
    ],
    pantry: [TORTILLA, SALAD, TOMATO_FRESH, b("tacokrydderi", "2 spsk.", 3)],
    steps: [
      "Brun kødet, og krydr det med tacokrydderi og lidt vand.",
      "Rør de skyllede bønner i, og varm igennem.",
      "Server i tortillas med salat, tomat, revet ost og creme fraiche.",
    ],
  },
];
