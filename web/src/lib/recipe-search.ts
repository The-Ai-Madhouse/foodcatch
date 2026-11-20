/**
 * Links for finding more of a dish on the web ("Søg videre"): a plain web search and a search
 * limited to each known recipe site. Google's documented search URL (`/search?q=`) with
 * `site:` keeps the links stable without depending on each site's own search page.
 */

export const RECIPE_SITES: readonly { name: string; domain: string }[] = [
  { name: "Valdemarsro", domain: "valdemarsro.dk" },
  { name: "Arla", domain: "arla.dk" },
  { name: "HelloFresh", domain: "hellofresh.dk" },
  { name: "Mummum", domain: "mummum.dk" },
  { name: "dk-kogebogen", domain: "dk-kogebogen.dk" },
];

/** A Google search for the dish's recipe, optionally on one site. */
export function recipeSearchUrl(dish: string, domain?: string): string {
  const q = `${dish} opskrift${domain ? ` site:${domain}` : ""}`;
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}
