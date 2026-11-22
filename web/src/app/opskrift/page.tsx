import type { Metadata } from "next";
import { RecipeImporter } from "@/components/recipe/RecipeImporter";

export const metadata: Metadata = { title: "Fra link" };

/**
 * "Fra link" (docs/ui.md §27): any recipe from the web, priced in the stores near the user.
 */
export default function RecipeFromLinkPage() {
  return (
    <div className="mx-auto max-w-[720px] lg:mx-0">
      <h1 className="text-display shelf text-ink">Fra link</h1>
      <p className="text-meta text-ink-2">
        Har du fundet en opskrift? Indsæt linket, så finder vi ingredienserne og viser, hvad de
        koster i butikkerne nær dig – i én butik eller billigst på tværs.
      </p>
      <RecipeImporter />
      <p className="mt-6 text-micro text-ink-3">
        Vi læser kun ingredienslisten fra siden. Priserne er dagens tilbud, hyldepriser og madspild
        i butikker nær dig; en vare vi ikke kan finde, står som manglende – vi gætter ikke.
      </p>
    </div>
  );
}
