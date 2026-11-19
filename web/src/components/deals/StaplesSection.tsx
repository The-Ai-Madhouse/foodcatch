import type { Route } from "next";
import Link from "next/link";
import { saveStaples } from "@/app/actions";
import { DiscountPill, MemberBadge, VerdictBadge } from "@/components/Badge";
import { ChainDot } from "@/components/ChainDot";
import { ChevronIcon } from "@/components/Icons";
import { chainName } from "@/lib/chains";
import type { ListingDeal } from "@/lib/deals";
import { foodWastePackSize, shownDiscount, type FoodWasteItem } from "@/lib/foodwaste";
import {
  displayTitle,
  formatDistance,
  formatDkk,
  formatUnitPriceRange,
  packSize,
} from "@/lib/format";
import { productPath } from "@/lib/routes";
import { STAPLE_OPTIONS, type StapleMatches } from "@/lib/staples";
import { storeDisplayName } from "@/lib/stores";

const sep = <span aria-hidden="true"> · </span>;

/** One offer of a staple in one line: title, chain, price, size, unit price and verdict. */
function OfferRow({ listing }: { listing: ListingDeal }) {
  const { offer } = listing;
  const size = packSize({
    unit: offer.unit,
    sizeMin: offer.sizeMin,
    sizeMax: offer.sizeMax,
    source: offer.source,
    description: offer.description,
  });
  const unitPrice = formatUnitPriceRange(offer.unitPriceMin, offer.unitPriceMax, offer.unit);
  const title = offer.productKey ? (
    <Link href={productPath(offer.productKey) as Route} className="text-ink">
      {offer.title}
    </Link>
  ) : (
    offer.title
  );
  return (
    <li className="flex items-start justify-between gap-3 py-2">
      <div className="min-w-0">
        <p className="font-medium text-ink">{title}</p>
        <p className="flex flex-wrap items-center gap-x-1 text-meta text-ink-2">
          <ChainDot chainId={offer.chainId} size="xs" />
          <span>{chainName(offer.chainId)}</span>
          {sep}
          <span className="font-bold text-ink tabular">{formatDkk(offer.price)}</span>
          {sep}
          <span>{size.text}</span>
          {unitPrice ? (
            <>
              {sep}
              <span className="whitespace-nowrap tabular">{unitPrice}</span>
            </>
          ) : null}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <VerdictBadge
          status={listing.status}
          memberOnly={offer.memberOnly}
          chainId={offer.chainId}
        />
        {offer.memberOnly ? <MemberBadge chainId={offer.chainId} /> : null}
      </div>
    </li>
  );
}

/** One clearance of a staple: title, store, price and discount. */
function ClearanceRow({ item }: { item: FoodWasteItem }) {
  const discount = shownDiscount(item.discountPct);
  return (
    <li className="flex items-start justify-between gap-3 py-2">
      <div className="min-w-0">
        <p className="font-medium text-ink">{displayTitle(item.title)}</p>
        <p className="flex flex-wrap items-center gap-x-1 text-meta text-ink-2">
          <ChainDot chainId={item.chainId} size="xs" />
          <span>{storeDisplayName(item.storeName, item.chainId)}</span>
          <span className="whitespace-nowrap tabular">· {formatDistance(item.distanceKm)}</span>
          {sep}
          <span className="font-bold text-ink tabular">{formatDkk(item.price)}</span>
          {item.referencePrice != null ? (
            <span className="tabular">
              {" "}
              (før <s>{formatDkk(item.referencePrice)}</s>)
            </span>
          ) : null}
          {sep}
          <span>{foodWastePackSize(item).text}</span>
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="rounded-full border border-warn-line bg-warn-bg px-2 py-0.5 text-micro font-medium text-warn-fg">
          Madspild
        </span>
        {discount ? <DiscountPill percent={discount} /> : null}
      </div>
    </li>
  );
}

/** The picker: a checkbox per staple, saved in a cookie by a server action (works without JS). */
function StaplePicker({ selected, open }: { selected: readonly string[]; open: boolean }) {
  return (
    <details open={open} className="group/picker border-t border-line">
      <summary className="flex h-11 items-center gap-1 text-meta font-medium text-link">
        {selected.length ? "Skift basisvarer" : "Vælg dine basisvarer"}
        <ChevronIcon className="details-chevron" />
      </summary>
      <form action={saveStaples} className="pb-3">
        <fieldset>
          <legend className="text-meta text-ink-2">
            Vælg de varer, du altid køber. De vises her, når de er på tilbud eller madspild.
          </legend>
          <div className="mt-2 grid grid-cols-2 gap-x-3 sm:grid-cols-3">
            {STAPLE_OPTIONS.map((o) => (
              <label key={o.id} className="flex min-h-11 items-center gap-2 text-ink">
                <input
                  type="checkbox"
                  name="basisvare"
                  value={o.id}
                  defaultChecked={selected.includes(o.id)}
                  className="size-5 accent-brand"
                />
                {o.label}
              </label>
            ))}
          </div>
        </fieldset>
        <p className="mt-1 text-micro text-ink-3">
          Rugbrød, brød, kaffe og frugt kan ikke vælges endnu: vi genkender dem ikke i
          tilbudsaviserne.
        </p>
        <button
          type="submit"
          className="mt-3 inline-flex h-11 items-center rounded-[10px] bg-brand px-4 font-semibold text-page hover:opacity-90"
        >
          Gem basisvarer
        </button>
      </form>
    </details>
  );
}

/**
 * "Dine basisvarer" (docs/ui.md §15) at the top of the offers page: the staples the user picked
 * that are on offer or cleared nearby, and the picker.
 */
export function StaplesSection({
  selected,
  matches,
}: {
  selected: readonly string[];
  matches: readonly StapleMatches[];
}) {
  const onSale = matches.filter((m) => m.offerCount + m.clearanceCount > 0);
  const quiet = matches.filter((m) => m.offerCount + m.clearanceCount === 0);
  return (
    <section
      aria-labelledby="basisvarer"
      className="rounded-xl border border-line bg-surface px-4 pt-3 lg:px-5"
    >
      <h2 id="basisvarer" className="text-heading font-semibold text-ink">
        Dine basisvarer
      </h2>
      {selected.length === 0 ? (
        <p className="text-meta text-ink-2">
          Vælg fx æg, havregryn og mælk, så ser du dem her, når de er billige.
        </p>
      ) : onSale.length === 0 ? (
        <p className="text-meta text-ink-2">Ingen af dine basisvarer er på tilbud lige nu.</p>
      ) : (
        <div className="divide-y divide-line">
          {onSale.map((m) => {
            const more = m.offerCount - m.offers.length + (m.clearanceCount - m.clearances.length);
            return (
              <div key={m.staple.id} className="py-2">
                <h3 className="text-meta font-semibold text-ink-3">
                  {m.staple.label}{" "}
                  <span className="font-normal tabular">
                    ({m.offerCount} tilbud
                    {m.clearanceCount ? `, ${m.clearanceCount} madspild` : ""})
                  </span>
                </h3>
                <ul className="divide-y divide-line">
                  {m.offers.map((l) => (
                    <OfferRow key={l.listingId} listing={l} />
                  ))}
                  {m.clearances.map((w) => (
                    <ClearanceRow key={w.listingId} item={w} />
                  ))}
                </ul>
                {more > 0 ? <p className="text-micro text-ink-3">+{more} flere</p> : null}
              </div>
            );
          })}
        </div>
      )}
      {quiet.length > 0 && onSale.length > 0 ? (
        <p className="pb-2 text-micro text-ink-3">
          Ikke på tilbud: {quiet.map((m) => m.staple.label).join(", ")}
        </p>
      ) : null}
      <StaplePicker selected={selected} open={selected.length === 0} />
    </section>
  );
}
