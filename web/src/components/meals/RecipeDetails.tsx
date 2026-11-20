import { ExternalLink } from "@/components/SourceLink";
import { formatQuantity } from "@/lib/format";
import type { Recipe } from "@/lib/recipes";
import { RECIPE_SITES, recipeSearchUrl } from "@/lib/recipe-search";

/**
 * The recipe itself: every ingredient with its amount, the method, the original recipe on a
 * known site, and links to search for more on the web.
 */
export function RecipeDetails({
  recipe,
  showIngredients = true,
  cheapSlots,
}: {
  recipe: Recipe;
  showIngredients?: boolean;
  /** Labels of slots that are on offer now ("billig nu"). */
  cheapSlots?: ReadonlySet<string>;
}) {
  return (
    <div className="text-meta text-ink-2">
      {showIngredients ? (
        <>
          <h4 className="font-semibold text-ink">Ingredienser ({recipe.servings} pers.)</h4>
          <ul className="mt-1 space-y-0.5">
            {recipe.slots.map((slot) => (
              <li key={slot.label}>
                <span className="tabular">
                  {formatQuantity(slot.amount, slot.amount, slot.unit)}
                </span>{" "}
                {slot.label.toLocaleLowerCase("da-DK")}
                {cheapSlots?.has(slot.label) ? (
                  <span className="text-good-fg"> · billig nu</span>
                ) : null}
              </li>
            ))}
            {recipe.pantry.map((p) => (
              <li key={p.name}>
                <span className="tabular">{p.amount}</span> {p.name}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <h4 className={`font-semibold text-ink ${showIngredients ? "mt-3" : ""}`}>Sådan gør du</h4>
      <ol className="mt-1 list-decimal space-y-1 pl-5">
        {recipe.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <div className="mt-3 rounded-lg border border-line p-3">
        {recipe.source ? (
          <p>
            <span className="text-ink">Hele opskriften med billeder: </span>
            <ExternalLink href={recipe.source.url} iconSize={14} className="font-medium">
              {recipe.name} på {recipe.source.site}
            </ExternalLink>
          </p>
        ) : null}
        <p className={recipe.source ? "mt-2" : undefined}>
          <span className="text-ink">Søg videre: </span>
          <ExternalLink href={recipeSearchUrl(recipe.name)} iconSize={14}>
            på nettet
          </ExternalLink>
        </p>
        <ul className="mt-1 flex flex-wrap gap-1.5" aria-label="Søg på en opskriftsside">
          {RECIPE_SITES.map((site) => (
            <li key={site.domain}>
              <a
                href={recipeSearchUrl(recipe.name, site.domain)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-8 items-center rounded-full border border-line-strong bg-surface px-3 text-micro font-medium text-ink no-underline hover:bg-surface-2"
              >
                {site.name}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
