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
import { ItemLine, type MealContext } from "@/components/meals/RecipeCard";
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
import { RECIPES, mealCatalogue } from "@/lib/meals";
import { chainPins, nearestByChain, shortStoreName } from "@/lib/stores";
import { StoreInfo } from "@/components/StoreInfo";
import { getMealPlan, getUserLocation } from "@/server/location";
import { getCurrentDeals, getFoodWasteNear, getNearbyStores } from "@/server/queries";

export const metadata: Metadata = { title: "Madplan" };

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
        <span className="shrink-0 text-right font-bold text-ink tabular">
          ca. {formatDkk(Math.round(shopping.total))}
        </span>
      </Link>
    </li>
  );
}

/** "Madplan": pick days and dishes, then where to shop, then one shopping list (docs/ui.md §19.2). */
export default async function MealPlanPage({ searchParams }: PageProps<"/madplan">) {
  const now = new Date();
  const [params, location, plan] = await Promise.all([
    searchParams,
    getUserLocation(),
    getMealPlan(now),
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
  const ctx: MealContext = { storesByChain, now };
  const recipes = plannedRecipes(plan);
  const planned = new Set(plan.map((d) => d.date));

  // Price per person of every dish, for the pickers.
  const perPerson = new Map(
    mealCatalogue(deals, foodWaste, nearbyChains, now).map((i) => [i.recipe.id, i]),
  );
  const options =
    recipes.length > 0 ? planOptions(recipes, deals, foodWaste, nearbyChains, now) : null;

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

  let groups: ChecklistGroup[] = [];
  let rows: ChecklistRow[] = [];
  if (chosen) {
    groups = [
      ...chosen.chains.map((c) => {
        const { pins, total } = chainPins(storesByChain, c);
        return {
          group: c,
          title: (
            <StoreInfo chainId={c} stores={pins} total={total}>
              {storeTitle(c)}
            </StoreInfo>
          ),
          hint: "tilbud og madspild",
        };
      }),
      {
        group: "normal",
        title: "Ikke på tilbud",
        hint: chosen.store.kind === "one" ? "skønnet normalpris" : "køb hvor du er – skønnet pris",
      },
      { group: "buy", title: "Også til retterne", hint: "skønnet pris" },
      { group: "basic", title: "Basisvarer", hint: "forventes at være i køkkenet" },
    ];
    rows = chosen.lines.map((l) => ({
      key: l.key,
      group: l.group,
      label: l.label,
      amount: l.amount,
      payKr: l.payKr,
      approx: l.approx,
      note: l.dishes.join(", "),
      defaultHave: l.basic,
      detail: l.item ? <ItemLine item={l.item} ctx={ctx} /> : undefined,
    }));
  }

  return (
    <div className="lg:max-w-[720px]">
      <h1 className="text-display shelf text-ink">Madideer</h1>
      <p className="text-meta text-ink-2">
        Læg en madplan: vælg dage og retter, og se så hvor det hele er billigst at købe.
      </p>
      <MealTabs active="madplan" planCount={recipes.length} />

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
              const dayCost = dayIdeas.reduce((sum, i) => sum + i.dishCost, 0);
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
                          ca. {formatDkk(Math.round(dayCost))}
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
                                          {idea.recipe.minutes} min · {idea.recipe.servings} pers. ·
                                          ca. {formatDkk(Math.round(idea.costPerServing))}/pers.
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
                                      {i.recipe.name} – ca.{" "}
                                      {formatDkk(Math.round(i.costPerServing))}/pers.
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
          <ShoppingChecklist recipeId="madplan" rows={rows} groups={groups} />
        </section>
      ) : null}
    </div>
  );
}
