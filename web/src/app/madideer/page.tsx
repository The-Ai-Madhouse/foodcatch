import type { Metadata } from "next";
import Link from "next/link";
import { Notice } from "@/components/Notice";
import { OpenLocationButton } from "@/components/location/LocationControl";
import { MealIdeaCard, type MealContext } from "@/components/meals/MealIdeaCard";
import { evaluateDeals, nearbyDeals } from "@/lib/deals";
import { formatDkk } from "@/lib/format";
import { mealIdeas, type Meal, type MealIdea } from "@/lib/meals";
import { nearestByChain } from "@/lib/stores";
import { getUserLocation } from "@/server/location";
import { getCurrentDeals, getFoodWasteNear, getNearbyStores } from "@/server/queries";

export const metadata: Metadata = { title: "Madideer" };

const SECTIONS: readonly { meal: Meal; title: string }[] = [
  { meal: "frokost", title: "Frokost" },
  { meal: "aftensmad", title: "Aftensmad" },
];

function MealSection({
  title,
  ideas,
  ctx,
}: {
  title: string;
  ideas: readonly MealIdea[];
  ctx: MealContext;
}) {
  const id = `maaltid-${title.toLocaleLowerCase("da-DK")}`;
  return (
    <section aria-labelledby={id} className="mt-6">
      <h2 id={id} className="text-heading font-bold text-ink">
        {title}
        <span className="ml-2 text-meta font-normal text-ink-3">
          {ideas.length} {ideas.length === 1 ? "idé" : "idéer"}
        </span>
      </h2>
      {ideas.length === 0 ? (
        <p className="mt-2 text-meta text-ink-2">
          Ingen idéer til {title.toLocaleLowerCase("da-DK")} lige nu: ugens billige varer i nærheden
          passer ikke til vores retter.
        </p>
      ) : (
        <ul className="mt-2 space-y-3">
          {ideas.map((idea) => (
            <li key={idea.recipe.id}>
              <MealIdeaCard idea={idea} ctx={ctx} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** "Madideer": 2–5 lunches and dinners from this week's offers and food waste (docs/ui.md §13). */
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
  const sections = SECTIONS.map((s) => ({
    ...s,
    ideas: mealIdeas(deals, foodWaste, nearbyChains, now, s.meal),
  }));
  const ctx: MealContext = { storesByChain, now };
  const all = sections.flatMap((s) => s.ideas);
  const best = Math.max(0, ...all.map((i) => i.totalSaving));

  return (
    <div className="lg:max-w-[640px]">
      <h1 className="text-title font-bold text-ink">Madideer</h1>
      <p className="text-meta text-ink-2">
        Frokost og aftensmad af ugens tilbud og madspild inden for {location.radiusKm} km.
        {best > 0 ? ` Spar op til ${formatDkk(best)} på én ret.` : ""}
      </p>

      {all.length > 0 ? (
        <nav aria-label="Måltider" className="mt-3 flex gap-2">
          {sections.map((s) => (
            <a
              key={s.meal}
              href={`#maaltid-${s.title.toLocaleLowerCase("da-DK")}`}
              className="inline-flex h-9 items-center rounded-full border border-line-strong bg-surface px-3 text-meta font-medium text-ink no-underline hover:bg-surface-2"
            >
              {s.title} ({s.ideas.length})
            </a>
          ))}
        </nav>
      ) : null}

      {all.length === 0 ? (
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
          {sections.some((s) => s.ideas.length < 2) ? (
            <div className="mt-4">
              <Notice>
                Der er få billige varer i nærheden lige nu. En større afstand giver flere idéer.
                <div>
                  <OpenLocationButton>Skift afstand</OpenLocationButton>
                </div>
              </Notice>
            </div>
          ) : null}
          {sections.map((s) => (
            <MealSection key={s.meal} title={s.title} ideas={s.ideas} ctx={ctx} />
          ))}
        </>
      )}

      <details className="mt-8 rounded-xl border border-line bg-surface px-4">
        <summary className="flex h-11 items-center gap-1 font-medium text-ink">
          Sådan regner vi priserne ud
        </summary>
        <ul className="list-disc space-y-1.5 pb-4 pl-5 text-meta text-ink-2">
          <li>
            <strong className="text-ink">Indkøb:</strong> hvad de billige varer koster, når du køber
            hele pakninger.
          </li>
          <li>
            <strong className="text-ink">Du sparer</strong> for madspild: prisen før nedsættelsen
            (fra Salling) minus madspildsprisen. For tilbud: den laveste normalpris på præcis samme
            vare i en butik i nærheden, for tilbuddets mindste pakning, minus tilbudsprisen.
            Procenten er af normalprisen.
          </li>
          <li>
            Et godt køb uden kendt normalpris tæller ikke med i beløbet (vist som &quot;+&quot;).
            Tilbud, der er billigere andre steder, foreslår vi aldrig.
          </li>
          <li>
            <strong className="text-ink">Retten koster ca.</strong> er et skøn: kun den del af de
            billige varer, retten bruger (fx 4 af 10 æg), plus skønnede normalpriser for resten af
            ingredienserne. Ukendt vægt regnes med et skøn, højst hele pakken.
          </li>
          <li>Madspild er et øjebliksbillede og kan være udsolgt.</li>
        </ul>
      </details>
    </div>
  );
}
