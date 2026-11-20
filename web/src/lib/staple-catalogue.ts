/**
 * The staples a user can follow ("Dine basisvarer", docs/ui.md §15 and §18) and the cookie that
 * stores them. Pure and free of server code, so the picker's search can run in the browser.
 *
 * A staple id is one of
 * - a suggestion (`aeg`, `yoghurt`, …): a label for one or more taxonomy types;
 * - `t:<type id>`: any other taxonomy type (`t:linser`);
 * - `q:<text>`: free text, matched against the names of all current offers (also items the
 *   pipeline does not recognize, such as rugbrød), without a verdict.
 */

import taxonomy from "./taxonomy.json";

export const STAPLES_COOKIE = "fc_staples";

/** At most this many staples are kept. */
export const MAX_STAPLES = 30;
/** Free text must be this long (after normalizing) … */
export const MIN_TEXT_LENGTH = 2;
/** … and is cut at this length. */
export const MAX_TEXT_LENGTH = 40;

export interface StapleOption {
  id: string;
  /** Danish label in the picker and the section. */
  label: string;
  /** Taxonomy type ids that count as this staple. */
  types: readonly string[];
  /** Product group ("Mejeri"), shown next to search hits. */
  group: string;
}

/** A staple the user follows. */
export type Staple =
  | { kind: "types"; id: string; label: string; types: readonly string[] }
  | { kind: "text"; id: string; label: string; text: string };

/** Breakfast and everyday basics, offered as checkboxes. */
export const STAPLE_OPTIONS: readonly StapleOption[] = [
  { id: "aeg", label: "Æg", types: ["æg"], group: "Æg" },
  { id: "havregryn", label: "Havregryn", types: ["havregryn"], group: "Kolonial" },
  { id: "maelk", label: "Mælk", types: ["mælk"], group: "Mejeri" },
  { id: "skyr", label: "Skyr", types: ["skyr"], group: "Mejeri" },
  { id: "yoghurt", label: "Yoghurt", types: ["yoghurt", "græsk_yoghurt"], group: "Mejeri" },
  { id: "ymer", label: "A38/ymer", types: ["a38_ymer"], group: "Mejeri" },
  { id: "smoer", label: "Smør", types: ["smør", "smørbar"], group: "Mejeri" },
  { id: "ost", label: "Ost", types: ["fast_ost"], group: "Mejeri" },
  { id: "hytteost", label: "Hytteost", types: ["hytteost"], group: "Mejeri" },
  { id: "kaernemaelk", label: "Kærnemælk", types: ["kærnemælk"], group: "Mejeri" },
];

const SUGGESTED_TYPES = new Set(STAPLE_OPTIONS.flatMap((o) => o.types));

/** Every other recognized type, found through the picker's search. */
export const TYPE_STAPLES: readonly StapleOption[] = taxonomy
  .filter((t) => !SUGGESTED_TYPES.has(t.id))
  .map((t) => ({ id: `t:${t.id}`, label: t.label, types: [t.id], group: t.group }));

/** Suggestions first, then the other types in taxonomy order. */
export const STAPLE_CATALOGUE: readonly StapleOption[] = [...STAPLE_OPTIONS, ...TYPE_STAPLES];

const BY_ID = new Map(STAPLE_CATALOGUE.map((o) => [o.id, o]));

const lower = (s: string): string => s.toLocaleLowerCase("da-DK");

/** Free text as stored: one line, lower case, no commas, single spaces; null when too short. */
export function normalizeStapleText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = lower(raw)
    .replace(/[,;"]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT_LENGTH)
    .trim();
  return text.length >= MIN_TEXT_LENGTH ? text : null;
}

/** The id of a free-text staple, or null when the text is too short. */
export function textStapleId(raw: unknown): string | null {
  const text = normalizeStapleText(raw);
  return text ? `q:${text}` : null;
}

/** The staple behind an id, or null for an unknown or malformed id. */
export function resolveStaple(id: string): Staple | null {
  const option = BY_ID.get(id);
  if (option) return { kind: "types", id, label: option.label, types: option.types };
  if (id.startsWith("q:")) {
    const text = normalizeStapleText(id.slice(2));
    if (text && `q:${text}` === id) {
      return {
        kind: "text",
        id,
        label: text.replace(/^./, (c) => c.toLocaleUpperCase("da-DK")),
        text,
      };
    }
  }
  return null;
}

/** Valid ids in the given order, without duplicates, at most {@link MAX_STAPLES}. */
export function cleanStaples(ids: readonly unknown[]): string[] {
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id === "string" && resolveStaple(id) && !seen.has(id)) seen.add(id);
    if (seen.size === MAX_STAPLES) break;
  }
  return [...seen];
}

function decode(part: string): string | null {
  try {
    return decodeURIComponent(part.trim());
  } catch {
    return null;
  }
}

/** Parse the cookie: comma-separated, URI-encoded ids (valid ones, in the stored order). */
export function parseStaples(value: string | null | undefined): string[] {
  if (!value) return [];
  return cleanStaples(value.split(",").map(decode));
}

/** The cookie value for a selection (valid ids only, URI-encoded, comma-separated). */
export function serializeStaples(ids: readonly unknown[]): string {
  return cleanStaples(ids).map(encodeURIComponent).join(",");
}

/** The selection with `id` added at the end (unchanged when invalid or already there). */
export function withStaple(selected: readonly string[], id: string): string[] {
  return cleanStaples([...selected, id]);
}

/**
 * Catalogue entries whose label (or type id) contains every word of `query`, not yet selected;
 * labels starting with the query first.
 */
export function searchStaples(
  query: string,
  selected: readonly string[],
  limit = 8,
): StapleOption[] {
  const words = lower(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const taken = new Set(selected);
  const haystack = (o: StapleOption) =>
    lower(`${o.label} ${o.types.join(" ").replaceAll("_", " ")}`);
  return STAPLE_CATALOGUE.filter((o) => !taken.has(o.id))
    .filter((o) => words.every((w) => haystack(o).includes(w)))
    .map((o, i) => ({ o, i, starts: lower(o.label).startsWith(words[0] as string) }))
    .sort((a, b) => Number(b.starts) - Number(a.starts) || a.i - b.i)
    .slice(0, limit)
    .map(({ o }) => o);
}
