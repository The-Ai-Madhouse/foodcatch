/**
 * Understands one ingredient line of any recipe ("400 g hakket oksekød, gerne 8-12%") and
 * decides how to find it in the shops (docs/ui.md §27): as a known product type (priced like the
 * catalogue's ingredients), as one of the extra items with tuned name patterns
 * (`PANTRY_SPECS`), or by its own name. Pure and unit tested.
 */
import { PANTRY_SPECS, matchesSpec, parseAmount, type Need, type ProductSpec } from "./pantry";
import taxonomy from "./taxonomy.json";

export interface ParsedIngredient {
  /** The line as written. */
  line: string;
  /** "400 g", or null without an amount ("salt og peber"). */
  amountText: string | null;
  /** The amount in kg, l or pieces, when it can be read. */
  need: Need | null;
  /** The item's name without preparation words ("oksekød" for "hakket oksekød, i tern"). */
  name: string;
  /** The name with them ("hakket oksekød"): product types are named so ("hakkede tomater"). */
  phrase: string;
}

export type IngredientMatch =
  | { kind: "type"; types: string[]; label: string }
  | { kind: "spec"; specName: string; label: string }
  | { kind: "text"; label: string; spec: ProductSpec };

const UNIT_WORDS: Readonly<Record<string, string>> = {
  g: "g",
  gr: "g",
  gram: "g",
  kg: "kg",
  kilo: "kg",
  ml: "ml",
  cl: "cl",
  dl: "dl",
  l: "l",
  liter: "l",
  spsk: "spsk",
  spiseske: "spsk",
  spiseskefuld: "spsk",
  tsk: "tsk",
  teske: "tsk",
  stk: "stk",
  styk: "stk",
  fed: "fed",
  dåse: "dåse",
  dåser: "dåse",
  pose: "pose",
  poser: "pose",
  bundt: "bundt",
  bundter: "bundt",
  håndfuld: "håndfuld",
  håndfulde: "håndfuld",
  knivspids: "knivspids",
  skive: "skive",
  skiver: "skive",
  pakke: "pakke",
  pakker: "pakke",
  pk: "pakke",
  glas: "glas",
  bakke: "bakke",
  bakker: "bakke",
  potte: "potte",
  hoved: "hoved",
  stængel: "stk",
  stængler: "stk",
  drys: "knivspids",
};

/** Words that describe preparation, not the product ("finthakket", "frisk", "i tern"). */
const DESCRIPTORS =
  /\b(fint|groft|fin|grov)?(hakket|hakkede|revet|revne|snittet|snittede|skåret|skårne|presset|pressede|knust|knuste|kogt|kogte|udblødt|udblødte|optøet|optøede|afdryppet|drænet|skyllet|skyllede|smuldret|smeltet|blødt|stuetempereret)\b|\b(frisk|friske|friskkværnet|friskpresset|stødt|god|gode|evt\.?|eventuelt|ca\.?|gerne|økologisk|øko|usprøjtet|små|store|stor|lille|mellem|mellemstore)\b|\bi (tern|skiver|strimler|både|kvarte|halve|stykker|mindre stykker)\b|\btil (servering|stegning|pynt)\b/giu;

const NUMBER = /^(\d+(?:[.,]\d+)?|\d+\/\d+|[½¼¾⅓⅔])(?:\s*-\s*(\d+(?:[.,]\d+)?))?/;

const FRACTIONS: Readonly<Record<string, string>> = {
  "½": "1/2",
  "¼": "1/4",
  "¾": "3/4",
  "⅓": "1/3",
  "⅔": "2/3",
};

/** Reads amount, unit and name of an ingredient line. */
export function parseIngredientLine(line: string): ParsedIngredient {
  let text = line.replace(/\s+/g, " ").trim();
  // A weight in brackets is the best amount: "2 dåser hakkede tomater (ca. 800 g)".
  const bracket = /\((?:ca\.?\s*)?(\d+(?:[.,]\d+)?)\s*(g|gram|kg|ml|dl|l)\b[^)]*\)/i.exec(text);
  text = text
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // "1½" -> "1 1/2" is rare; treat "1½" as 1.5.
  text = text.replace(/(\d)½/g, "$1.5");
  let amountText: string | null = null;
  let need: Need | null = null;
  const num = NUMBER.exec(text);
  if (num) {
    const raw = FRACTIONS[num[1] ?? ""] ?? num[1] ?? "";
    // A range "2-3": the larger amount, to be sure to have enough.
    const value = (num[2] ?? raw).replace(",", ".");
    text = text.slice(num[0].length).trim();
    const unitMatch = /^([\p{L}]+)\.?(?=\s|$)/u.exec(text);
    const unit = unitMatch ? UNIT_WORDS[unitMatch[1]!.toLocaleLowerCase("da-DK")] : undefined;
    if (unit && unitMatch) text = text.slice(unitMatch[0].length).trim();
    const shown = num[2] ? `${raw}-${num[2]}` : raw;
    amountText = `${shown.replace(".", ",")}${unit ? ` ${unit}` : ""}`;
    const asNumber = value.includes("/") ? value : String(Number(value));
    if (unit === "cl") {
      need = { amount: Number(value) / 100, unit: "l" };
    } else if (unit === "knivspids") {
      need = { amount: 0.001, unit: "kg" };
    } else {
      need = parseAmount(`${asNumber} ${unit ?? ""}`.trim());
    }
  }
  if (bracket) {
    const v = Number((bracket[1] ?? "").replace(",", "."));
    const u = (bracket[2] ?? "").toLowerCase();
    const n = u === "kg" ? v : u === "l" ? v : u === "dl" ? v / 10 : v / 1000;
    if (n > 0) need = { amount: n, unit: u === "l" || u === "dl" || u === "ml" ? "l" : "kg" };
  }
  // The name: before a comma ("løg, finthakket"), without descriptions and "eller …".
  const head = (text.split(/,|\beller\b| - /)[0] ?? text).replace(/\b(på dåse|på glas)\b/gi, " ");
  const tidy = (s: string) =>
    s
      .replace(/[^\p{L}\p{N}%\- ]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLocaleLowerCase("da-DK");
  const phrase = tidy(head) || tidy(text);
  const name = tidy(head.replace(DESCRIPTORS, " ").replace(/\b(af|med)\b/g, " ")) || phrase;
  return { line, amountText, need, name, phrase };
}

// ---------------------------------------------------------------- matching

/** Extra names of product types (the taxonomy labels cover the rest). */
const TYPE_SYNONYMS: ReadonlyArray<readonly [string, string]> = [
  ["hakket svinekød", "hakket_grisekød"],
  ["hakket svin", "hakket_grisekød"],
  ["hakket gris", "hakket_grisekød"],
  ["hakket okse", "hakket_oksekød"],
  ["oksekød hakket", "hakket_oksekød"],
  ["hakket kalv og flæsk", "hakket_gris_kalv"],
  ["kalv og flæsk", "hakket_gris_kalv"],
  ["hakket kylling", "hakket_kylling"],
  ["kyllingefilet", "kyllingebryst"],
  ["kyllingefileter", "kyllingebryst"],
  ["kyllingebryst", "kyllingebryst"],
  ["kyllingeinderfilet", "kyllingeinderfilet"],
  ["kyllingeinderfileter", "kyllingeinderfilet"],
  ["kyllingelår", "kyllingelår"],
  ["kyllingeoverlår", "kyllingelår"],
  ["hel kylling", "hel_kylling"],
  ["koteletter", "svinekoteletter"],
  ["svinemørbrad", "svinemørbrad"],
  ["mørbrad", "svinemørbrad"],
  ["æg", "æg"],
  ["æggeblommer", "æg"],
  ["æggehvider", "æg"],
  ["letmælk", "mælk"],
  ["sødmælk", "mælk"],
  ["minimælk", "mælk"],
  ["skummetmælk", "mælk"],
  ["mælk", "mælk"],
  ["kærnemælk", "kærnemælk"],
  ["piskefløde", "piskefløde"],
  ["madlavningsfløde", "madlavningsfløde"],
  ["fløde", "madlavningsfløde"],
  ["creme fraiche", "creme_fraiche"],
  ["cremefraiche", "creme_fraiche"],
  ["fraiche", "creme_fraiche"],
  ["smør", "smør"],
  ["hytteost", "hytteost"],
  ["mozzarella", "mozzarella"],
  ["feta", "feta"],
  ["salatost", "feta"],
  ["parmesan", "fast_ost"],
  ["cheddar", "fast_ost"],
  ["revet ost", "fast_ost"],
  ["skiveost", "fast_ost"],
  ["pastaost", "fast_ost"],
  ["skyr", "skyr"],
  ["græsk yoghurt", "græsk_yoghurt"],
  ["yoghurt", "yoghurt"],
  ["ymer", "a38_ymer"],
  ["a38", "a38_ymer"],
  ["hakkede tomater", "hakkede_tomater"],
  ["flåede tomater", "flåede_tomater"],
  ["passata", "passata"],
  ["tomatpuré", "tomatpuré"],
  ["tomatpure", "tomatpuré"],
  ["tomatkoncentrat", "tomatpuré"],
  ["kikærter", "kikærter"],
  ["kidneybønner", "kidneybønner"],
  ["sorte bønner", "sorte_bønner"],
  ["hvide bønner", "hvide_bønner"],
  ["linser", "linser"],
  ["tun", "tun"],
  ["havregryn", "havregryn"],
];

/** Names that look like a type but are not ("kokosmælk", "smørbart", "æggenudler"). */
const NOT_A_TYPE =
  /(kokosmælk|kokosfløde|mandelmælk|havremælk|sojamælk|smørdej|butterdej|æggenudler|ægge?pasta|tunfisk ?salat|peanutbutter|jordnøddesmør|kærnemælksdressing|fløde ?boller)/;

const words = (s: string) =>
  s
    .toLocaleLowerCase("da-DK")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** Whether the phrase occurs as whole words in the name. */
function hasPhrase(name: string, phrase: string): boolean {
  const n = words(name);
  const p = words(phrase);
  for (let i = 0; i + p.length <= n.length; i++) {
    if (p.every((w, j) => n[i + j] === w)) return true;
  }
  return false;
}

const TAXONOMY_PHRASES: ReadonlyArray<readonly [string, string]> = [
  ...TYPE_SYNONYMS,
  ...(taxonomy as { id: string; label: string }[]).map(
    (t) => [t.label.replace(/\(.*?\)/g, "").toLocaleLowerCase("da-DK"), t.id] as const,
  ),
].sort((a, b) => b[0].length - a[0].length);

const TYPE_LABELS = new Map(
  (taxonomy as { id: string; label: string }[]).map((t) => [t.id, t.label]),
);

/** Words that are never worth searching a product by on their own. */
const WEAK_WORDS = new Set(["salt", "peber", "vand", "og", "til", "de", "en", "et", "the", "a"]);

/**
 * How to find an ingredient: a product type, a tuned extra item, or its own name. `phrase` is
 * the name with its preparation words ("hakkede tomater"), tried first for product types.
 */
export function matchIngredient(name: string, phrase: string = name): IngredientMatch {
  const n = name.toLocaleLowerCase("da-DK");
  for (const candidate of [phrase.toLocaleLowerCase("da-DK"), n]) {
    if (NOT_A_TYPE.test(candidate)) break;
    for (const [typePhrase, id] of TAXONOMY_PHRASES) {
      if (hasPhrase(candidate, typePhrase)) {
        return { kind: "type", types: [id], label: TYPE_LABELS.get(id) ?? typePhrase };
      }
    }
  }
  let best: { specName: string; len: number } | null = null;
  for (const [specName, spec] of Object.entries(PANTRY_SPECS)) {
    // The ingredient name, read as a product name, must match the item's pattern.
    if (matchesSpec(n, spec) && (!best || specName.length > best.len)) {
      best = { specName, len: specName.length };
    }
  }
  if (best) return { kind: "spec", specName: best.specName, label: best.specName };
  const strong = words(n).filter((w) => w.length >= 3 && !WEAK_WORDS.has(w));
  const searchText = strong.slice(-2).join(" ") || n;
  return { kind: "text", label: searchText, spec: { words: [searchText], compound: true } };
}

/** Whether an ingredient is usually at home (salt, pepper, water, oil, sugar, flour, spices). */
export function usuallyAtHome(name: string): boolean {
  return /^(salt|peber|salt og peber|vand|olie|olivenolie|rapsolie|sukker|hvedemel|mel|bagepulver|natron|eddike|stødt\b|tørret\b|laurbærblade|karry|paprika|spidskommen|kanel|muskatnød|oregano|timian|chiliflager|bouillon|bouillonterning|hønsebouillon|grøntsagsbouillon|oksebouillon|soja|sojasauce|honning|sennep)/.test(
    name.toLocaleLowerCase("da-DK"),
  );
}
