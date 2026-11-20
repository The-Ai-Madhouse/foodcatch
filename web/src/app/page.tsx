import type { Metadata } from "next";
import Link from "next/link";
import { Disclosure } from "@/components/Disclosure";
import { ChevronIcon } from "@/components/Icons";
import { Notice } from "@/components/Notice";
import { OpenLocationButton } from "@/components/location/LocationControl";
import { AutoSubmitForm } from "@/components/meals/AutoSubmitForm";
import { Segmented } from "@/components/Segmented";
import { RecipeCard, type MealContext } from "@/components/meals/RecipeCard";
import { chainName } from "@/lib/chains";
import { evaluateDeals, groupByListing, isUpcoming, nearbyDeals } from "@/lib/deals";
import { listingSaving, savedAmount } from "@/lib/savings";
import { ChainDot } from "@/components/ChainDot";
import { SavingTag } from "@/components/SavingTag";
import { formatDkk } from "@/lib/format";
import {
  PRICE_CHOICES,
  SORT_LABELS,
  TIME_CHOICES,
  activeFilterCount,
  filterIdeas,
  parseMealFilters,
  type MealFilters,
} from "@/lib/meal-filters";
import { dayLabel, plannableDays, plannedRecipes, todayInDenmark } from "@/lib/meal-plan";
import { mealCatalogue, type Meal } from "@/lib/meals";
import { nearestByChain } from "@/lib/stores";
import { getLikedRecipes, getMealPlan, getUserLocation } from "@/server/location";
import { getCurrentDeals, getFoodWasteNear, getNearbyStores } from "@/server/queries";

export const metadata: Metadata = { title: "Aftensmad" };

/** Offers in the desktop "Største besparelser" column. */
const TOP_SAVINGS = 6;

const fieldClass =
  "h-10 w-full rounded-[10px] border border-line-strong bg-surface px-2 text-meta text-ink";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-micro font-medium text-ink-3">{label}</span>
      {children}
    </label>
  );
}

function Filters({
  filters,
  chains,
  likedCount,
}: {
  filters: MealFilters;
  chains: readonly string[];
  likedCount: number;
}) {
  // The meal is chosen above the filters, so it does not count as a filter here.
  const active = activeFilterCount({ ...filters, meal: null });
  return (
    // Folded by default: the dishes are the point, filters are for when you want them.
    <Disclosure
      initialOpen={false}
      className="group/filters mt-3 rounded-xl border border-line bg-surface"
    >
      <summary className="flex min-h-11 items-center gap-2 px-3 lg:px-4">
        <span className="font-medium text-ink">Filtre og sortering</span>
        <span className="text-meta text-ink-2">
          {active > 0 ? `${active} valgt` : SORT_LABELS[filters.sort]}
        </span>
        <ChevronIcon className="ml-auto details-chevron text-ink-3" />
      </summary>
      <AutoSubmitForm action="/" className="border-t border-line p-3 lg:p-4">
        {filters.meal === "frokost" ? <input type="hidden" name="maaltid" value="frokost" /> : null}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label="Tid">
            <select name="tid" defaultValue={filters.maxMinutes ?? ""} className={fieldClass}>
              <option value="">Ligegyldigt</option>
              {TIME_CHOICES.map((m) => (
                <option key={m} value={m}>
                  Højst {m} min
                </option>
              ))}
            </select>
          </Field>
          <Field label="Pris pr. person">
            <select name="pris" defaultValue={filters.maxPerPerson ?? ""} className={fieldClass}>
              <option value="">Ligegyldigt</option>
              {PRICE_CHOICES.map((kr) => (
                <option key={kr} value={kr}>
                  Højst {formatDkk(kr)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Butik du mest handler i">
            <select name="butik" defaultValue={filters.store.chainId ?? ""} className={fieldClass}>
              <option value="">Alle butikker</option>
              {chains.map((c) => (
                <option key={c} value={c}>
                  {chainName(c)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Sortér efter">
            <select name="sorter" defaultValue={filters.sort} className={fieldClass}>
              {Object.entries(SORT_LABELS).map(([value, label]) => (
                <option key={value} value={value === "spar" ? "" : value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1">
          <label className="flex min-h-11 items-center gap-2 text-meta text-ink">
            <input
              type="checkbox"
              name="kun"
              value="1"
              defaultChecked={filters.store.only}
              className="size-5 accent-[var(--brand)]"
            />
            Alt fra én butik
          </label>
          <label className="flex min-h-11 items-center gap-2 text-meta text-ink">
            <input
              type="checkbox"
              name="gemte"
              value="1"
              defaultChecked={filters.liked}
              className="size-5 accent-[var(--brand)]"
            />
            Kun gemte ♥ ({likedCount})
          </label>
          <span className="ml-auto flex items-center gap-3">
            {active > 0 ? (
              <Link
                href={filters.meal === "frokost" ? "/?maaltid=frokost" : "/"}
                className="text-meta"
              >
                Nulstil filtre
              </Link>
            ) : null}
            <button
              type="submit"
              className="h-10 rounded-[10px] bg-brand px-4 text-meta font-medium text-page"
            >
              Vis retter
            </button>
          </span>
        </div>
        {filters.store.only ? (
          <p className="text-micro text-ink-3">
            {filters.store.chainId
              ? `Kun tilbud og madspild fra ${chainName(filters.store.chainId)}; resten regnes til normalpris.`
              : "Hver ret får den butik, hvor den samlet sparer mest."}
          </p>
        ) : filters.store.chainId ? (
          <p className="text-micro text-ink-3">
            Tilbud fra {chainName(filters.store.chainId)} vælges først; andre butikker bruges, hvor{" "}
            {chainName(filters.store.chainId)} intet har.
          </p>
        ) : null}
      </AutoSubmitForm>
    </Disclosure>
  );
}

/**
 * The front page, "Aftensmad" (docs/ui.md §21): dishes priced with this week's offers and food
 * waste near the user, the biggest real saving first, so a dinner idea is one glance away.
 */
export default async function DinnerPage({ searchParams }: PageProps<"/">) {
  const now = new Date();
  const [params, location, liked, plan] = await Promise.all([
    searchParams,
    getUserLocation(),
    getLikedRecipes(),
    getMealPlan(now),
  ]);
  const [stores, allRows, foodWaste] = await Promise.all([
    getNearbyStores(location),
    getCurrentDeals(),
    getFoodWasteNear(location),
  ]);
  const storesByChain = nearestByChain(stores);
  const nearbyChains = new Set(storesByChain.keys());
  const chains = [...storesByChain.entries()]
    .sort((a, b) => (a[1][0]?.distanceKm ?? 0) - (b[1][0]?.distanceKm ?? 0))
    .map(([c]) => c);
  // Dinner unless lunch is asked for: the page answers "what's for dinner tonight".
  const meal: Meal = [params.maaltid].flat()[0] === "frokost" ? "frokost" : "aftensmad";
  const filters = { ...parseMealFilters(params, nearbyChains), meal };
  const deals = evaluateDeals(nearbyDeals(allRows, nearbyChains), nearbyChains);
  const all = mealCatalogue(deals, foodWaste, nearbyChains, now, filters.store);
  const likedSet = new Set(liked);
  const ideas = filterIdeas(all, filters, likedSet);
  const today = todayInDenmark(now);
  const planDays = (
    plan.length > 0 ? plan.map((d) => d.date) : plannableDays(today).slice(0, 7)
  ).map((date) => ({ date, label: dayLabel(date, today) }));
  const ctx: MealContext = { storesByChain, now, planDays };
  const onOffer = all.filter((i) => i.filled.length > 0).length;
  // Desktop side column: the biggest real savings this week, to cook from.
  const topSavings = groupByListing(deals)
    .filter((l) => !isUpcoming(l, now))
    .map((l) => ({ listing: l, saving: listingSaving(l, nearbyChains) }))
    .filter((x) => x.saving.kind === "saving")
    .sort((a, b) => savedAmount(b.saving) - savedAmount(a.saving))
    .slice(0, TOP_SAVINGS);
  const planCount = plannedRecipes(plan).length;

  return (
    <div className="lg:grid lg:grid-cols-[minmax(0,720px)_minmax(0,1fr)] lg:gap-8">
      <div className="min-w-0">
        <h1 className="text-display shelf text-ink">
          {meal === "frokost" ? "Frokost" : "Aftensmad"}
        </h1>
        <p className="text-meta text-ink-2">
          Retter med varer, der er billige inden for {location.radiusKm} km lige nu. Mest sparet
          først – åbn en ret for indkøbslisten.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Segmented
            label="Måltid"
            items={[
              { href: "/", label: "Aftensmad", active: meal === "aftensmad" },
              { href: "/?maaltid=frokost", label: "Frokost", active: meal === "frokost" },
            ]}
          />
          <Link
            href="/madplan"
            className="inline-flex h-11 items-center rounded-[10px] border border-line-strong bg-surface px-3 text-meta font-medium text-ink no-underline hover:bg-surface-2"
          >
            {planCount > 0 ? `Min madplan (${planCount})` : "Planlæg ugen"}
          </Link>
        </div>

        <Filters filters={filters} chains={chains} likedCount={liked.length} />

        <p className="mt-4 text-meta text-ink-3" aria-live="polite">
          {ideas.length} {ideas.length === 1 ? "ret" : "retter"}
        </p>

        {ideas.length === 0 ? (
          <div className="mt-2">
            <Notice title="Ingen retter passer">
              {filters.liked && liked.length === 0
                ? "Du har ikke gemt nogen retter endnu. Tryk på ♡ ved en ret for at gemme den."
                : "Prøv at løsne filtrene."}{" "}
              <Link href={meal === "frokost" ? "/?maaltid=frokost" : "/"}>Vis alle retter</Link>
              {onOffer === 0 ? (
                <div>
                  <OpenLocationButton>Skift afstand</OpenLocationButton>
                </div>
              ) : null}
            </Notice>
          </div>
        ) : (
          <ul className="mt-2 space-y-3">
            {ideas.map((idea) => (
              <li key={idea.recipe.id}>
                <RecipeCard idea={idea} ctx={ctx} liked={likedSet.has(idea.recipe.id)} />
              </li>
            ))}
          </ul>
        )}

        <details className="mt-8 rounded-xl border border-line bg-surface px-4">
          <summary className="flex h-11 items-center gap-1 font-medium text-ink">
            Sådan regner vi priserne ud
          </summary>
          <ul className="list-disc space-y-1.5 pb-4 pl-5 text-meta text-ink-2">
            <li>
              <strong className="text-ink">Pr. person</strong> er et skøn: kun den del af de billige
              varer, retten bruger (fx 4 af 10 æg), plus skønnede normalpriser for resten, delt med
              antal personer.
            </li>
            <li>
              <strong className="text-ink">Spar</strong> for madspild: prisen før nedsættelsen (fra
              Salling) minus madspildsprisen. For tilbud: den laveste normalpris på præcis samme
              vare i en butik i nærheden, for tilbuddets mindste pakning, minus tilbudsprisen. Et
              godt køb uden kendt normalpris tæller ikke med (vist som &quot;+&quot;).
            </li>
            <li>
              <strong className="text-ink">Indkøbslisten</strong> viser hele pakker af
              tilbudsvarerne og skønnede normalpriser for resten. Basisvarer (olie, krydderier, løg
              …) er sat hak ved på forhånd. Dine hak huskes i denne browser.
            </li>
            <li>Tilbud, der er billigere andre steder, foreslår vi aldrig.</li>
            <li>Madspild er et øjebliksbillede og kan være udsolgt.</li>
          </ul>
        </details>
      </div>
      {topSavings.length > 0 ? (
        <aside aria-labelledby="stoerst-besparelse" className="hidden lg:block">
          <div className="sticky top-20 rounded-xl border border-line bg-surface p-4">
            <h2 id="stoerst-besparelse" className="text-heading font-semibold text-ink">
              Største besparelser lige nu
            </h2>
            <p className="text-meta text-ink-2">Varer at bygge en ret op omkring.</p>
            <ul className="mt-2 divide-y divide-line">
              {topSavings.map(({ listing, saving }) => (
                <li
                  key={listing.listingId}
                  className="flex items-center justify-between gap-3 py-2"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-meta font-medium text-ink">
                      {listing.offer.title}
                    </span>
                    <span className="flex items-center gap-1 text-micro text-ink-2">
                      <ChainDot chainId={listing.offer.chainId} size="xs" />
                      {chainName(listing.offer.chainId)} · {formatDkk(listing.offer.price)}
                    </span>
                  </span>
                  <SavingTag saving={saving} size="sm" />
                </li>
              ))}
            </ul>
            <Link href="/tilbud" className="mt-1 inline-flex min-h-11 items-center text-meta">
              Alle tilbud
            </Link>
          </div>
        </aside>
      ) : null}
    </div>
  );
}
