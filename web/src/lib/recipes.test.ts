import { describe, expect, it } from "vitest";
import { RECIPE_SITES, recipeSearchUrl } from "./recipe-search";
import { RECIPES } from "./recipes";

describe("recipe sources", () => {
  const withSource = RECIPES.filter((r) => r.source);

  it("pairs most dishes with a real recipe page", () => {
    expect(withSource.length).toBeGreaterThanOrEqual(25);
  });

  it.each(withSource.map((r) => [r.id, r.source!] as const))(
    "%s links to a known recipe site under its own name",
    (_id, source) => {
      const url = new URL(source.url);
      expect(url.protocol).toBe("https:");
      const site = RECIPE_SITES.find(
        (s) => url.hostname === s.domain || url.hostname.endsWith(`.${s.domain}`),
      );
      expect(site?.name).toBe(source.site);
    },
  );

  it("uses each recipe page once", () => {
    const urls = withSource.map((r) => r.source!.url);
    expect(new Set(urls).size).toBe(urls.length);
  });
});

describe("recipeSearchUrl", () => {
  it("searches the whole web or one site", () => {
    expect(recipeSearchUrl("Koteletter i fad")).toBe(
      "https://www.google.com/search?q=Koteletter%20i%20fad%20opskrift",
    );
    expect(recipeSearchUrl("Lasagne", "valdemarsro.dk")).toContain("site%3Avaldemarsro.dk");
  });
});
