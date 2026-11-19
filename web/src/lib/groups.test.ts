import { describe, expect, it } from "vitest";
import {
  TYPE_IDS,
  countByGroup,
  groupOfClassKey,
  groupOfType,
  groupSlug,
  parseGroupFilter,
} from "./groups";
import { RECIPES } from "./recipes";

describe("groups", () => {
  it("maps type ids and class keys to their group", () => {
    expect(groupOfType("hakket_oksekød")).toBe("Kød");
    expect(groupOfType("æg")).toBe("Æg");
    expect(groupOfClassKey("skyr|smag=naturel")).toBe("Mejeri");
    expect(groupOfClassKey(null)).toBe("Andet");
    expect(groupOfType("rugbrød")).toBe("Andet");
  });

  it("knows the 39 taxonomy types, including every recipe ingredient", () => {
    expect(TYPE_IDS).toHaveLength(39);
    for (const r of RECIPES)
      for (const s of r.slots)
        for (const t of s.types) {
          expect(TYPE_IDS, `${r.id}: ${t}`).toContain(t);
        }
  });

  it("makes URL-safe slugs", () => {
    expect(groupSlug("Kød")).toBe("koed");
    expect(groupSlug("Frugt og grønt")).toBe("frugt-og-groent");
  });

  it("counts rows per group in shopping order, unknown last", () => {
    const rows = ["Mejeri", "Andet", "Kød", "Mejeri", "Kolonial"];
    expect(countByGroup(rows, (r) => r).map((g) => [g.name, g.count])).toEqual([
      ["Kød", 1],
      ["Mejeri", 2],
      ["Kolonial", 1],
      ["Andet", 1],
    ]);
  });

  it("parses the category filter against the groups present", () => {
    const groups = countByGroup(["Kød", "Mejeri"], (r) => r);
    expect(parseGroupFilter("koed", groups)).toBe("Kød");
    expect(parseGroupFilter("kolonial", groups)).toBeNull();
    expect(parseGroupFilter(undefined, groups)).toBeNull();
  });
});
