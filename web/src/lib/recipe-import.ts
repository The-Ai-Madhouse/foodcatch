/**
 * Reads a recipe's title, servings and ingredient lines from a recipe page's HTML (docs/ui.md
 * §27). Pure (no network) and defensive: the HTML is untrusted text, parsed with regular
 * expressions only, never executed. Strategies, best first:
 *
 * 1. schema.org `Recipe` in JSON-LD (HelloFresh, Mummum, most WordPress recipe plugins);
 * 2. schema.org microdata, `itemprop="recipeIngredient"` (Valdemarsro, dk-kogebogen);
 * 3. WP Recipe Maker and Tasty Recipes markup (many small blogs);
 * 4. Arla's ingredient table;
 * 5. any page: the list items under a heading "Ingredienser"/"Ingredients" (DR and others).
 */

export interface ImportedRecipe {
  title: string | null;
  servings: number | null;
  ingredients: string[];
  /** Which strategy found the ingredients (for the "how we read it" note). */
  via: "json-ld" | "microdata" | "plugin" | "arla" | "list";
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  aelig: "æ",
  oslash: "ø",
  aring: "å",
  AElig: "Æ",
  Oslash: "Ø",
  Aring: "Å",
  eacute: "é",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  deg: "°",
};

/** Decodes HTML entities (named ones we know, and every numeric one). */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n =
        code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code] ?? m;
  });
}

/** Visible text of an HTML fragment, on one line. */
export function textOf(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

/** Cleans ingredient lines: text only, no empties, no duplicates of the whole list. */
function cleanLines(lines: readonly string[]): string[] {
  const out = lines
    .map((l) => textOf(l))
    .map((l) => l.replace(/^[•·*\-–]\s*/, "").trim())
    .filter((l) => l.length > 0 && l.length <= 200);
  // Some pages render the list twice (phone and desktop): keep one copy.
  const half = out.length / 2;
  if (
    Number.isInteger(half) &&
    half > 0 &&
    out.slice(0, half).join("|") === out.slice(half).join("|")
  ) {
    return out.slice(0, half);
  }
  return out;
}

/** The first number in a yield ("4 personer", ["4", "4 portioner"]), or null. */
function parseServings(value: unknown): number | null {
  const text = Array.isArray(value)
    ? value.map(String).join(" ")
    : value == null
      ? ""
      : String(value);
  const m = /(\d{1,2})/.exec(text);
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 && n <= 50 ? n : null;
}

// ---------------------------------------------------------------- 1. JSON-LD

function isRecipe(node: unknown): node is Record<string, unknown> {
  if (!node || typeof node !== "object") return false;
  const t = (node as Record<string, unknown>)["@type"];
  return t === "Recipe" || (Array.isArray(t) && t.includes("Recipe"));
}

function findRecipe(node: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 6 || !node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = findRecipe(n, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (isRecipe(node)) return node;
  const obj = node as Record<string, unknown>;
  for (const key of ["@graph", "mainEntity", "mainEntityOfPage", "itemListElement"]) {
    const r = findRecipe(obj[key], depth + 1);
    if (r) return r;
  }
  return null;
}

function fromJsonLd(html: string): ImportedRecipe | null {
  const re = /<script[^>]*type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    let data: unknown;
    try {
      data = JSON.parse((m[1] ?? "").trim());
    } catch {
      continue;
    }
    const recipe = findRecipe(data);
    if (!recipe) continue;
    const raw = recipe.recipeIngredient ?? recipe.ingredients;
    const lines = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
    const ingredients = cleanLines(lines);
    if (ingredients.length === 0) continue;
    return {
      title: typeof recipe.name === "string" ? textOf(recipe.name) : null,
      servings: parseServings(recipe.recipeYield),
      ingredients,
      via: "json-ld",
    };
  }
  return null;
}

// ---------------------------------------------------------------- 2. microdata

function fromMicrodata(html: string): ImportedRecipe | null {
  const lines = [
    ...html.matchAll(
      /<([a-z0-9]+)[^>]*itemprop=["'](?:recipeIngredient|ingredients)["'][^>]*>([\s\S]*?)<\/\1>/gi,
    ),
  ].map((m) => m[2] ?? "");
  const ingredients = cleanLines(lines);
  if (ingredients.length === 0) return null;
  const yieldMatch =
    /itemprop=["']recipeYield["'][^>]*content=["']([^"']+)["']/i.exec(html) ??
    /itemprop=["']recipeYield["'][^>]*>([^<]*)</i.exec(html);
  return { title: null, servings: parseServings(yieldMatch?.[1]), ingredients, via: "microdata" };
}

// ---------------------------------------------------------------- 3. plugins

function fromPlugins(html: string): ImportedRecipe | null {
  // WP Recipe Maker: <li class="wprm-recipe-ingredient">…</li>; Tasty: .tasty-recipes-ingredients li
  let lines = [
    ...html.matchAll(
      /<li[^>]*class=["'][^"']*wprm-recipe-ingredient[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi,
    ),
  ].map((m) => m[1] ?? "");
  if (lines.length === 0) {
    const tasty =
      /class=["'][^"']*tasty-recipes-ingredients[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(html);
    if (tasty)
      lines = [...(tasty[1] ?? "").matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => m[1] ?? "");
  }
  const ingredients = cleanLines(lines);
  if (ingredients.length === 0) return null;
  const servings = /class=["'][^"']*wprm-recipe-servings[^"']*["'][^>]*>\s*(\d+)/i.exec(html);
  return { title: null, servings: parseServings(servings?.[1]), ingredients, via: "plugin" };
}

// ---------------------------------------------------------------- 4. Arla

function fromArla(html: string): ImportedRecipe | null {
  const start = html.indexOf("c-recipe__ingredients-inner");
  if (start < 0) return null;
  const end = html.indexOf("c-recipe__instructions", start);
  const block = html.slice(start, end > start ? end : start + 60_000);
  const ingredients = cleanLines(
    [...block.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => m[1] ?? ""),
  );
  if (ingredients.length === 0) return null;
  const y = /"recipeYield":"([^"]*)"/.exec(html);
  return { title: null, servings: parseServings(y?.[1]), ingredients, via: "arla" };
}

// ---------------------------------------------------------------- 5. any list

const STOP_HEADINGS =
  /(fremgangsm(å|aa)de|s(å|aa)dan g(ø|oe)r du|tilberedning|metode|instructions|directions|method|preparation|tips)/i;

function fromList(html: string): ImportedRecipe | null {
  const body = html.replace(/<(script|style|nav|header|footer)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const heading =
    /<(h[1-6]|strong|b|p|div|span)[^>]*>\s*(?:<[^>]+>\s*)*(ingredienser|ingredients)\b[^<]*</i.exec(
      body,
    );
  if (!heading) return null;
  const from = heading.index + heading[0].length;
  const rest = body.slice(from, from + 40_000);
  // Up to the method heading, when there is one.
  const stop = new RegExp(
    `<(h[1-6]|strong|b)[^>]*>\\s*(?:<[^>]+>\\s*)*[^<]*${STOP_HEADINGS.source}`,
    "i",
  ).exec(rest);
  const block = stop ? rest.slice(0, stop.index) : rest;
  const ingredients = cleanLines(
    [...block.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => m[1] ?? ""),
  ).filter((l) => l.length <= 120);
  if (ingredients.length === 0) return null;
  return { title: null, servings: null, ingredients: ingredients.slice(0, 60), via: "list" };
}

function titleOf(html: string): string | null {
  const og = /<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i.exec(html);
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const raw = og?.[1] ?? (h1 ? h1[1] : null) ?? t?.[1] ?? null;
  if (!raw) return null;
  // "Lasagne - opskrift på … | Site" -> "Lasagne"
  const text = textOf(raw)
    .split(/\s[|–—-]\s/)[0]
    ?.trim();
  return text ? text.slice(0, 120) : null;
}

/** Reads a recipe from a page; null when no ingredient list is found. */
export function extractRecipe(html: string): ImportedRecipe | null {
  const found =
    fromJsonLd(html) ??
    fromMicrodata(html) ??
    fromPlugins(html) ??
    fromArla(html) ??
    fromList(html);
  if (!found) return null;
  return {
    ...found,
    title: found.title ?? titleOf(html),
    servings: found.servings ?? servingsInText(html),
  };
}

/** "4 personer" / "til 4 pers." / "4 portioner" anywhere in the visible text. */
function servingsInText(html: string): number | null {
  const m = /\b(\d{1,2})\s*(personer|pers\.|portioner|servings|people)\b/i.exec(
    textOf(html).slice(0, 60_000),
  );
  return m ? parseServings(m[1]) : null;
}

/** Whether the page looks like a bot check rather than the recipe. */
export function looksLikeBotCheck(html: string): boolean {
  return /not a bot|are you human|captcha|cf-browser-verification|just a moment/i.test(
    html.slice(0, 20_000),
  );
}
