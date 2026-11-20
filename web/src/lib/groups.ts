/**
 * Product groups ("Kød", "Mejeri", …) for lists that are split into categories (docs/ui.md
 * §14). Offers carry their group (`group_name`); food-waste rows only carry the class key, so
 * their group comes from the taxonomy type id (pipeline `matching/taxonomy.py`). Pure.
 */

import { typeIdOf } from "./meals";
import taxonomy from "./taxonomy.json";

/** Product groups in shopping order (as on the offers page). */
export const GROUP_ORDER = ["Kød", "Fisk", "Æg", "Mejeri", "Frugt og grønt", "Kolonial"] as const;

/** The group of rows whose type is unknown. */
export const OTHER_GROUP = "Andet";

/** Taxonomy types (pipeline `matching/taxonomy.py`; a pipeline test keeps the copy equal). */
export interface TaxonomyType {
  id: string;
  label: string;
  group: string;
}

export const TAXONOMY_TYPES: readonly TaxonomyType[] = taxonomy;

const TYPE_GROUPS: Readonly<Record<string, string>> = Object.fromEntries(
  TAXONOMY_TYPES.map((t) => [t.id, t.group]),
);

/** Every taxonomy type id the web app knows (for tests and the staples picker). */
export const TYPE_IDS: readonly string[] = Object.keys(TYPE_GROUPS);

/** The group of a taxonomy type id, or "Andet". */
export function groupOfType(typeId: string | null | undefined): string {
  return (typeId && TYPE_GROUPS[typeId]) || OTHER_GROUP;
}

/** The group of a row with a class key (food waste), or "Andet". */
export function groupOfClassKey(classKey: string | null | undefined): string {
  return groupOfType(typeIdOf(classKey));
}

/** Rank of a group in shopping order; unknown groups after the known ones. */
export function groupRank(name: string): number {
  const i = (GROUP_ORDER as readonly string[]).indexOf(name);
  return i === -1 ? GROUP_ORDER.length + (name === OTHER_GROUP ? 1 : 0) : i;
}

/** URL-safe slug of a group name ("Frugt og grønt" -> "frugt-og-groent"). */
export function groupSlug(name: string): string {
  return name
    .toLocaleLowerCase("da-DK")
    .replaceAll("æ", "ae")
    .replaceAll("ø", "oe")
    .replaceAll("å", "aa")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export interface GroupCount {
  name: string;
  slug: string;
  count: number;
}

/** Number of rows per group, in shopping order. */
export function countByGroup<T>(rows: readonly T[], groupOf: (row: T) => string): GroupCount[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const g = groupOf(row);
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, slug: groupSlug(name), count }))
    .sort((a, b) => groupRank(a.name) - groupRank(b.name) || a.name.localeCompare(b.name, "da-DK"));
}

/** Parse the `?kategori=` slug against the groups present; null for none or an unknown one. */
export function parseGroupFilter(
  value: string | string[] | undefined,
  groups: readonly GroupCount[],
): string | null {
  if (typeof value !== "string") return null;
  return groups.find((g) => g.slug === value)?.name ?? null;
}
