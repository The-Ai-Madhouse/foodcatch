import type { Metadata, Route } from "next";
import Link from "next/link";
import {
  addPlanDishAction,
  clearPlanAction,
  removePlanDishAction,
  togglePlanDayAction,
} from "@/app/actions";
import { Badge } from "@/components/Badge";
import { ChainDot } from "@/components/ChainDot";
import { Disclosure } from "@/components/Disclosure";
import { ChevronIcon } from "@/components/Icons";
import { MealTabs } from "@/components/meals/MealTabs";
import { RecipeDetails } from "@/components/meals/RecipeDetails";
import {
  ESTIMATE_SOURCE,
  FoundLine,
  ItemLine,
  foundSource,
  mealItemSource,
  type MealContext,
} from "@/components/meals/RecipeCard";
import {
  ShoppingChecklist,
  type ChecklistGroup,
  type ChecklistRow,
} from "@/components/meals/ShoppingChecklist";
import { chainName } from "@/lib/chains";
import { evaluateDeals, nearbyDeals } from "@/lib/deals";
import { formatDkk } from "@/lib/format";
import {
  MAX_DISHES_PER_DAY,
  dayLabel,
  planOptions,
  plannableDays,
  plannedRecipes,
  todayInDenmark,
  type PlanShopping,
} from "@/lib/meal-plan";
import { RECIPES, itemChain, mealCatalogue } from "@/lib/meals";
import { nearestByChain, shortStoreName } from "@/lib/stores";
import { getMealPlan, getPeople, getUserLocation } from "@/server/location";
import { PeoplePicker } from "@/components/meals/PeoplePicker";
import { dishCost } from "@/lib/dish-cost";
import { portions } from "@/lib/people";
import { packText } from "@/lib/pantry";
import {
  getBuyableProducts,
  getCurrentDeals,
  getFoodWasteNear,
  getNearbyStores,
} from "@/server/queries";
import { clearanceProduct, pantrySearchStems, priceFinder } from "@/lib/pantry";

export const metadata: Metadata = { title: "Madplan" };

/** Every taxonomy type a recipe slot can use (for their shelf prices). */
const SLOT_TYPES = [...new Set(RECIPES.flatMap((r) => r.slots.flatMap((s) => s.types)))];

const STEP = "text-heading font-bold text-ink";
const fieldClass =
  "h-10 min-w-0 flex-1 rounded-[10px] border border-line-strong bg-surface px-2 text-meta text-ink";

type Param = string | string[] | undefined;
const one = (v: Param) => (Array.isArray(v) ? v[0] : v);

/** One way to shop the plan, as a choice that links to its list. */
function StoreOption({
  href,
  title,
  shopping,
  active,
  recommended,
  note,
}: {
  href: string;
  title: React.ReactNode;
  shopping: PlanShopping;
  active: boolean;
  recommended?: boolean;
  note?: string;
}) {
  return (
    <li>
      <Link
        href={href as Route}
        scroll={false}
        aria-current={active ? "true" : undefined}
        className={`flex items-center gap-3 rounded-xl border p-3 no-underline ${active ? "border-brand bg-good-bg" : "border-line bg-surface hover:bg-surface-2"}`}
      >
        <span
          aria-hidden="true"
          className={`flex size-5 shrink-0 items-center justify-center rounded-full border-2 ${active ? "border-brand" : "border-line-strong"}`}
        >
          {active ? <span className="size-2.5 rounded-full bg-brand" /> : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2 font-medium text-ink">
            {title}
            {recommended ? (
              <Badge tone="good" icon={null}>
                Anbefalet
              </Badge>
            ) : null}
          </span>
          <span className="block text-micro text-ink-3">
            {shopping.offerCount} {shopping.offerCount === 1 ? "tilbudsvare" : "tilbudsvarer"}
            {shopping.saving > 0 ? ` · spar ${formatDkk(shopping.saving)}` : ""}
            {note ? ` · ${note}` : ""}
          </span>
        </span>
        <span
          title="Summen af indkøbslisten nedenfor – hver pris dér linker til sin kilde"
          className="shrink-0 text-right font-bold text-ink tabular"
        >
          {shopping.lines.some((l) => !l.basic && l.approx) ? "ca. " : ""}
          {formatDkk(shopping.total)}
        </span>
      </Link>
    </li>
  );
}

/** "Madplan": pick days and dishes, then where to shop, then one shopping list (docs/ui.md §19.2). */
export default async function MealPlanPage({ searchParams }: PageProps<"/madplan">) {
  const now = new Date();
  const [params, location, plan, people] = await Promise.all([
    searchParams,
    getUserLocation(),
    getMealPlan(now),
    getPeople(),
  ]);
  const [stores, allRows, foodWaste] = await Promise.all([
    getNearbyStores(location),
    getCurrentDeals(),
    getFoodWasteNear(location),
  ]);
  const today = todayInDenmark(now);
  const storesByChain = nearestByChain(stores);
  const nearbyChains = new Set(storesByChain.keys());
  const deals = evaluateDeals(nearbyDeals(allRows, nearbyChains), nearbyChains);
  const recipes = plannedRecipes(plan);
  // Real prices for what is not on offer (docs/ui.md §23).
  const finder = recipes.length
    ? priceFinder([
        ...(await getBuyableProducts([...nearbyChains], pantrySearchStems(), SLOT_TYPES)),
        ...foodWaste.map(clearanceProduct),
      ])
    : undefined;
  const ctx: MealContext = { storesByChain, now, ...(finder ? { finder } : {}) };
  const planned = new Set(plan.map((d) => d.date));

  // Price per person of every dish, for the pickers.
  const perPerson = new Map(
    mealCatalogue(deals, foodWaste, nearbyChains, now).map((i) => [i.recipe.id, i]),
  );
  const options =
    recipes.length > 0 ? planOptions(recipes, deals, foodWaste, nearbyChains, now, finder) : null;
  // What each dish costs from real prices (docs/ui.md §23), and per day for the chosen people.
  const costs = new Map(
    [...perPerson.values()].map((i) => [i.recipe.id, dishCost(i, finder, () => "")]),
  );
  const dishText = (id: string): string => {
    const idea = perPerson.get(id);
    const cost = costs.get(id);
    if (!idea || !cost) return "";
    const ca = cost.dishApprox ? "ca. " : "";
    if (people != null && people !== idea.recipe.servings) {
      const share = portions(idea.recipe.servings, people, cost.dishKr);
      if (share.days != null) {
        return `rækker til ${share.days} ${share.days === 1 ? "dag" : "dage"} for ${people === 1 ? "1 person" : `${people} pers.`} · ${ca}${formatDkk(share.perDayKr)} pr. dag`;
      }
      return `lav den ${String(share.times).replace(".", ",")} gange · ${ca}${formatDkk(share.perDayKr)}`;
    }
    return `${ca}${formatDkk(cost.perServingKr)}/pers.`;
  };

  const wanted = one(params.butik);
  const bestSingle = options?.single[0];
  const manyIsCheaper = Boolean(options && bestSingle && options.many.total < bestSingle.total);
  const chosen: PlanShopping | undefined =
    wanted === "flere"
      ? options?.many
      : (options?.single.find((s) => s.store.kind === "one" && s.store.chainId === wanted) ??
        bestSingle);
  const chosenKey =
    chosen?.store.kind === "many"
      ? "flere"
      : chosen?.store.kind === "one"
        ? chosen.store.chainId
        : null;

  const storeTitle = (chainId: string) => {
    const nearest = storesByChain.get(chainId)?.[0];
    return nearest
      ? `${chainName(chainId)} ${shortStoreName(nearest.name, chainId)}`
      : chainName(chainId);
  };

  // One flat list (docs/ui.md §26): every item with its price from the chosen store; where it is
  // bought and for which dishes is in its note. Basics last, ticked as at home.
  const groups: ChecklistGroup[] = [{ group: "all", title: "Alt til madplanen" }];
  const where = (l: PlanShopping["lines"][number]): string => {
    if (l.item) {
      return `${l.item.kind === "foodwaste" ? "Madspild" : "Tilbud"} i ${chainName(itemChain(l.item))}`;
    }
    if (l.found) {
      const pack = packText(l.found);
      return `${l.found.product.kind === "regular" ? "Normalpris" : l.found.product.kind === "offer" ? "Tilbud" : "Madspild"} i ${chainName(l.found.product.chainId)}${pack ? ` – ${pack}` : ""}`;
    }
    return chosen?.store.kind === "one"
      ? `Ingen pris i ${chainName(chosen.store.chainId)} – skøn`
      : "Ingen pris i butikkerne nær dig – skøn";
  };
  const rows: ChecklistRow[] = chosen
    ? [...chosen.lines]
        .sort((a, b) => Number(a.basic) - Number(b.basic))
        .map((l) => ({
          key: l.key,
          group: "all",
          label: l.label,
          amount: l.amount,
          payKr: l.payKr,
          portionKr: l.portionKr,
          approx: l.approx,
          source: l.item
            ? mealItemSource(l.item, ctx.now)
            : l.found
              ? foundSource(l.found, ctx.now)
              : ESTIMATE_SOURCE,
          note: `${where(l)} · til ${l.dishes.join(", ")}`,
          defaultHave: l.basic,
          detail: l.item ? (
            <ItemLine item={l.item} ctx={ctx} />
          ) : l.found ? (
            <FoundLine found={l.found} ctx={ctx} />
          ) : undefined,
        }))
    : [];
  const planServings = recipes.reduce((sum, r) => sum + r.servings, 0);

  return (
    <div className="lg:max-w-[720px]">
      <h1 className="text-display shelf text-ink">Madplan</h1>
      <p className="text-meta text-ink-2">
        Læg en madplan: vælg dage og retter, og se så hvor det hele er billigst at købe.
      </p>
      <MealTabs active="madplan" planCount={recipes.length} />
      <PeoplePicker people={people} />

      {/* ------------------------------------------------ 1. days */}
      <section aria-labelledby="trin-dage" className="mt-5">
        <h2 id="trin-dage" className={STEP}>
          1. Vælg dage
        </h2>
        <ul className="mt-2 flex flex-wrap gap-2">
          {plannableDays(today).map((date) => {
            const on = planned.has(date);
            return (
              <li key={date}>
                <form action={togglePlanDayAction}>
                  <input type="hidden" name="dato" value={date} />
                  <button
                    type="submit"
                    aria-pressed={on}
                    className={`h-9 rounded-full border px-3 text-meta font-medium ${on ? "border-brand bg-brand text-page" : "border-line-strong bg-surface text-ink hover:bg-surface-2"}`}
                  >
                    {dayLabel(date, today)}
                  </button>
                </form>
              </li>
            );
          })}
        </ul>
      </section>

      {/* ------------------------------------------------ 2. dishes */}
      {plan.length > 0 ? (
        <section aria-labelledby="trin-retter" className="mt-6">
          <div className="flex items-baseline justify-between gap-3">
            <h2 id="trin-retter" className={STEP}>
              2. Vælg retter
            </h2>
            <Link href="/" className="text-meta">
              Find retter i kataloget
            </Link>
          </div>
          <ul className="mt-2 space-y-3">
            {plan.map((day) => {
              const dayIdeas = day.recipes.map((id) => perPerson.get(id)).filter((i) => i != null);
              const dayCost = dayIdeas.reduce(
                (sum, i) => sum + (costs.get(i.recipe.id)?.dishKr ?? i.dishCost),
                0,
              );
              const dayApprox = dayIdeas.some((i) => costs.get(i.recipe.id)?.dishApprox ?? true);
              return (
                <li key={day.date}>
                  <Disclosure
                    initialOpen={day.recipes.length === 0}
                    className="group/day rounded-xl border border-line bg-surface"
                  >
                    <summary className="flex min-h-12 cursor-pointer items-center gap-2 px-3 py-2 lg:px-4">
                      <span className="min-w-0 flex-1">
                        <span className="block font-semibold text-ink">
                          {dayLabel(day.date, today, true)}
                        </span>
                        <span className="block truncate text-micro text-ink-3">
                          {dayIdeas.length === 0
                            ? "Ingen retter endnu"
                            : dayIdeas.map((i) => i.recipe.name).join(", ")}
                        </span>
                      </span>
                      {dayIdeas.length > 0 ? (
                        <span className="shrink-0 text-meta font-medium text-ink tabular">
                          {dayApprox ? "ca. " : ""}
                          {formatDkk(dayCost)}
                        </span>
                      ) : null}
                      <ChevronIcon className="shrink-0 details-chevron" />
                    </summary>
                    <div className="border-t border-line px-3 pb-3 lg:px-4">
                      {dayIdeas.length > 0 ? (
                        <ul className="divide-y divide-line">
                          {day.recipes.map((id, index) => {
                            const idea = perPerson.get(id);
                            if (!idea) return null;
                            return (
                              <li key={`${id}-${index}`} className="py-1">
                                <div className="flex items-start gap-2">
                                  <details className="min-w-0 flex-1">
                                    <summary className="flex min-h-11 cursor-pointer items-center gap-1">
                                      <span className="min-w-0 flex-1">
                                        <span className="font-medium text-ink">
                                          {idea.recipe.name}
                                        </span>
                                        <span className="block text-micro text-ink-3 tabular">
                                          {idea.recipe.minutes} min · {idea.recipe.servings} pers. ·{" "}
                                          {dishText(id)}
                                          {idea.totalSaving > 0
                                            ? ` · spar ${formatDkk(idea.totalSaving)}`
                                            : ""}
                                        </span>
                                      </span>
                                      <span className="shrink-0 text-micro font-medium text-link">
                                        Opskrift
                                      </span>
                                      <ChevronIcon className="shrink-0 details-chevron" />
                                    </summary>
                                    <div className="pt-1 pb-3">
                                      <RecipeDetails
                                        recipe={idea.recipe}
                                        cheapSlots={new Set(idea.filled.map((f) => f.slot.label))}
                                      />
                                    </div>
                                  </details>
                                  <form action={removePlanDishAction}>
                                    <input type="hidden" name="dato" value={day.date} />
                                    <input type="hidden" name="nr" value={index} />
                                    <button
                                      type="submit"
                                      aria-label={`Fjern ${idea.recipe.name}`}
                                      title="Fjern fra dagen"
                                      className="flex size-11 items-center justify-center rounded-full text-ink-3 hover:bg-surface-2 hover:text-ink"
                                    >
                                      ✕
                                    </button>
                                  </form>
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      ) : null}
                      {day.recipes.length < MAX_DISHES_PER_DAY ? (
                        <form action={addPlanDishAction} className="mt-2 flex gap-2">
                          <input type="hidden" name="dato" value={day.date} />
                          <select name="ret" aria-label="Vælg ret" className={fieldClass} required>
                            <option value="">Vælg en ret …</option>
                            {(["aftensmad", "frokost"] as const).map((meal) => (
                              <optgroup
                                key={meal}
                                label={meal === "frokost" ? "Frokost" : "Aftensmad"}
                              >
                                {RECIPES.filter((r) => r.meal === meal)
                                  .map((r) => perPerson.get(r.id))
                                  .filter((i) => i != null)
                                  .sort(
                                    (a, b) =>
                                      b.totalSaving - a.totalSaving ||
                                      a.costPerServing - b.costPerServing,
                                  )
                                  .map((i) => (
                                    <option key={i.recipe.id} value={i.recipe.id}>
                                      {i.recipe.name} – {dishText(i.recipe.id)}
                                      {i.totalSaving > 0
                                        ? ` (spar ${formatDkk(i.totalSaving)})`
                                        : ""}
                                    </option>
                                  ))}
                              </optgroup>
                            ))}
                          </select>
                          <button
                            type="submit"
                            className="h-10 shrink-0 rounded-[10px] bg-brand px-4 text-meta font-medium text-page"
                          >
                            Tilføj
                          </button>
                        </form>
                      ) : null}
                    </div>
                  </Disclosure>
                </li>
              );
            })}
          </ul>
          <form action={clearPlanAction} className="mt-2 text-right">
            <button type="submit" className="min-h-9 text-micro text-ink-3 hover:text-ink">
              Ryd madplanen
            </button>
          </form>
        </section>
      ) : (
        <p className="mt-4 text-meta text-ink-3">Vælg en eller flere dage for at komme i gang.</p>
      )}

      {/* ------------------------------------------------ 3. where */}
      {options && chosen ? (
        <section aria-labelledby="trin-butik" className="mt-6">
          <h2 id="trin-butik" className={STEP}>
            3. Hvor vil du handle?
          </h2>
          <p className="text-meta text-ink-2">
            {recipes.length} {recipes.length === 1 ? "ret" : "retter"}. Priserne er hele pakker af
            tilbudsvarerne plus skønnede normalpriser for resten; basisvarer er ikke regnet med.
          </p>
          <h3 className="mt-3 text-micro font-semibold text-ink-3 uppercase">Én butik</h3>
          <ul className="mt-1 space-y-2">
            {options.single
              .filter(
                (s) =>
                  s.offerCount > 0 || (s.store.kind === "one" && s.store.chainId === chosenKey),
              )
              .map((s) =>
                s.store.kind === "one" ? (
                  <StoreOption
                    key={s.store.chainId}
                    href={`/madplan?butik=${s.store.chainId}`}
                    title={
                      <>
                        <ChainDot chainId={s.store.chainId} size="sm" />
                        {storeTitle(s.store.chainId)}
                      </>
                    }
                    shopping={s}
                    active={chosenKey === s.store.chainId}
                    recommended={s.store.chainId === options.recommended}
                  />
                ) : null,
              )}
          </ul>
          {(() => {
            const none = options.single.filter(
              (s) =>
                s.offerCount === 0 && !(s.store.kind === "one" && s.store.chainId === chosenKey),
            );
            const first = none[0];
            return first ? (
              <p className="mt-2 text-micro text-ink-3">
                Ingen tilbud der gør dine retter billigere (ca. {formatDkk(Math.round(first.total))}
                ):{" "}
                {none.map((s, i) =>
                  s.store.kind === "one" ? (
                    <span key={s.store.chainId}>
                      {i > 0 ? ", " : ""}
                      <Link href={`/madplan?butik=${s.store.chainId}` as Route} scroll={false}>
                        {chainName(s.store.chainId)}
                      </Link>
                    </span>
                  ) : null,
                )}
              </p>
            ) : null;
          })()}
          <h3 className="mt-4 text-micro font-semibold text-ink-3 uppercase">Flere butikker</h3>
          <ul className="mt-1">
            <StoreOption
              href="/madplan?butik=flere"
              title={
                <>
                  <span className="flex -space-x-1">
                    {options.many.chains.map((c) => (
                      <ChainDot key={c} chainId={c} size="sm" />
                    ))}
                  </span>
                  Billigst i alt
                </>
              }
              shopping={options.many}
              active={chosenKey === "flere"}
              note={
                manyIsCheaper && bestSingle
                  ? `${options.many.chains.length} butikker, ${formatDkk(Math.round(bestSingle.total - options.many.total))} billigere`
                  : "ikke billigere end én butik lige nu"
              }
            />
          </ul>
        </section>
      ) : null}

      {/* ------------------------------------------------ 4. list */}
      {chosen ? (
        <section aria-labelledby="trin-liste" className="mt-6">
          <h2 id="trin-liste" className={STEP}>
            4. Indkøbsliste
          </h2>
          <p className="text-micro text-ink-3">
            {chosen.store.kind === "one"
              ? `Alt i ${storeTitle(chosen.store.chainId)}.`
              : `Fordelt på ${chosen.chains.map(chainName).join(", ")}.`}{" "}
            Sæt hak ved det, du allerede har.
          </p>
          <ShoppingChecklist
            recipeId="madplan"
            rows={rows}
            groups={groups}
            servings={planServings}
            people={people}
            whole="madplanen"
          />
        </section>
      ) : null}
    </div>
  );
}
