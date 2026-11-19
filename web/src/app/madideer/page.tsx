import type { Metadata } from "next";
import Link from "next/link";
import { Notice } from "@/components/Notice";
import { OpenLocationButton } from "@/components/location/LocationControl";
import { MealIdeaCard, type MealContext } from "@/components/meals/MealIdeaCard";
import { evaluateDeals, nearbyDeals } from "@/lib/deals";
import { formatDkk } from "@/lib/format";
import { mealIdeas } from "@/lib/meals";
import { nearestByChain } from "@/lib/stores";
import { getUserLocation } from "@/server/location";
import { getCurrentDeals, getFoodWasteNear, getNearbyStores } from "@/server/queries";

export const metadata: Metadata = { title: "Madideer" };

/** "Madideer": 2–5 dishes from this week's offers and nearby food waste (docs/ui.md §13). */
export default async function MealIdeasPage() {
  const location = await getUserLocation();
  const [stores, allRows, foodWaste] = await Promise.all([
    getNearbyStores(location),
    getCurrentDeals(),
    getFoodWasteNear(location),
  ]);
  const now = new Date();
  const storesByChain = nearestByChain(stores);
  const nearbyChains = new Set(storesByChain.keys());
  const deals = evaluateDeals(nearbyDeals(allRows, nearbyChains), nearbyChains);
  const ideas = mealIdeas(deals, foodWaste, nearbyChains, now);
  const ctx: MealContext = { storesByChain, now };
  const best = ideas[0]?.totalSaving ?? 0;

  return (
    <div className="lg:max-w-[640px]">
      <h1 className="text-title font-bold text-ink">Madideer</h1>
      <p className="text-meta text-ink-2">
        Retter du kan lave af ugens tilbud og madspild inden for {location.radiusKm} km.
        {best > 0 ? ` Spar op til ${formatDkk(best)} på én ret.` : ""}
      </p>

      {ideas.length === 0 ? (
        <div className="mt-4">
          <Notice title="Ingen madideer lige nu">
            Vi fandt ingen billige basisvarer i nærheden, som passer til vores retter. Prøv en
            større afstand, eller se <Link href="/">ugens tilbud</Link> og{" "}
            <Link href="/madspild">madspild</Link>.
            <div>
              <OpenLocationButton>Skift afstand</OpenLocationButton>
            </div>
          </Notice>
        </div>
      ) : (
        <>
          {ideas.length === 1 ? (
            <div className="mt-4">
              <Notice>
                Kun én ret passer til ugens billige varer i nærheden. En større afstand giver flere
                idéer.
                <div>
                  <OpenLocationButton>Skift afstand</OpenLocationButton>
                </div>
              </Notice>
            </div>
          ) : null}
          <ul className="mt-4 space-y-3">
            {ideas.map((idea) => (
              <li key={idea.recipe.id}>
                <MealIdeaCard idea={idea} ctx={ctx} />
              </li>
            ))}
          </ul>
        </>
      )}

      <details className="mt-8 rounded-xl border border-line bg-surface px-4">
        <summary className="flex h-11 items-center gap-1 font-medium text-ink">
          Sådan regner vi besparelsen ud
        </summary>
        <ul className="list-disc space-y-1.5 pb-4 pl-5 text-meta text-ink-2">
          <li>
            <strong className="text-ink">Madspild:</strong> prisen før nedsættelsen (fra Salling)
            minus madspildsprisen.
          </li>
          <li>
            <strong className="text-ink">Tilbud:</strong> den laveste normalpris på præcis samme
            vare i en butik i nærheden, for tilbuddets mindste pakning, minus tilbudsprisen.
          </li>
          <li>
            Et godt køb uden kendt normalpris tæller ikke med i beløbet (vist som &quot;+&quot;).
            Tilbud, der er billigere andre steder, foreslår vi aldrig.
          </li>
          <li>
            Besparelsen gælder én pakning af hver vare. &quot;Du skal også bruge&quot; er varer, der
            ikke er på tilbud eller madspild lige nu.
          </li>
          <li>Madspild er et øjebliksbillede og kan være udsolgt.</li>
        </ul>
      </details>
    </div>
  );
}
