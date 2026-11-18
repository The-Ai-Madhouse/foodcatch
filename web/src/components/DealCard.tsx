import type { Route } from "next";
import Link from "next/link";
import { chainName } from "@/lib/chains";
import {
  REFERENCE_KIND_LABELS,
  STATUS_META,
  explainStatus,
  referenceViews,
  type EvaluatedDeal,
} from "@/lib/deals";
import {
  formatDkk,
  formatPeriod,
  formatUnitPrice,
  formatUnitPriceRange,
  unitLabel,
} from "@/lib/format";
import { classPath } from "@/lib/routes";
import { Badge } from "./Badge";

/** One Netto offer variant with its verdict, explanation and expandable reference list. */
export function DealCard({
  deal,
  nearbyChains,
}: {
  deal: EvaluatedDeal;
  nearbyChains: ReadonlySet<string>;
}) {
  const meta = STATUS_META[deal.status];
  const unitPrice = formatUnitPriceRange(
    deal.nettoUnitPriceBest ?? deal.unitPriceMin,
    deal.nettoUnitPriceWorst ?? deal.unitPriceMax,
    deal.unit,
  );
  const refs = referenceViews(deal, nearbyChains);
  const counted = refs.filter((r) => r.counts).length;
  const headingId = `deal-${deal.listingId}-${deal.variantIndex}`;

  return (
    <article
      aria-labelledby={headingId}
      className="rounded-xl border border-line bg-surface p-4 shadow-xs"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 id={headingId} className="font-semibold text-ink">
            {deal.title}
          </h4>
          <p className="text-sm text-ink-2">
            {deal.classLabel} ·{" "}
            <Link href={classPath(deal.classKey) as Route} className="whitespace-nowrap">
              Prishistorik
            </Link>
          </p>
        </div>
        <Badge tone={meta.tone}>{meta.label}</Badge>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-ink-3">Pris</dt>
          <dd className="font-semibold text-ink tabular">{formatDkk(deal.price)}</dd>
        </div>
        <div>
          <dt className="text-ink-3">Pris pr. {unitLabel(deal.unit)}</dt>
          <dd className="font-semibold text-ink tabular">{unitPrice ?? "Ukendt"}</dd>
        </div>
        <div className="col-span-2 sm:col-span-1">
          <dt className="text-ink-3">Periode</dt>
          <dd className="text-ink">{formatPeriod(deal.validFrom, deal.validTo)}</dd>
        </div>
      </dl>

      <p className="mt-3 text-sm text-ink-2">{explainStatus(deal)}</p>
      {deal.notes.length > 0 ? (
        <ul className="mt-1 list-disc pl-5 text-xs text-ink-3">
          {deal.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}

      {refs.length > 0 ? (
        <details className="group mt-3 rounded-lg border border-line">
          <summary className="px-3 py-2 text-sm font-medium text-ink">
            Sammenligninger ({counted} af {refs.length} tæller med)
          </summary>
          <div className="overflow-x-auto border-t border-line">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Sammenligningspriser for {deal.classLabel}</caption>
              <thead className="text-xs text-ink-3">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Kæde
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Type
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Pris pr. {unitLabel(deal.unit)}
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Periode
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Tæller
                  </th>
                </tr>
              </thead>
              <tbody>
                {refs.map((ref, i) => (
                  <tr
                    key={`${ref.kind}-${ref.listing_id ?? i}`}
                    className={`border-t border-line ${ref.counts ? "" : "text-ink-3"}`}
                  >
                    <td className="px-3 py-2">
                      <span className="font-medium">{chainName(ref.chain_id)}</span>
                      {ref.title ? (
                        <span className="block text-xs text-ink-3">{ref.title}</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">{REFERENCE_KIND_LABELS[ref.kind]}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap tabular">
                      {formatUnitPrice(ref.unit_price, ref.unit ?? deal.unit)}
                      {ref.isCheapest ? (
                        <span className="ml-1 text-xs font-semibold text-ink">(billigst)</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {ref.valid_from || ref.valid_to
                        ? formatPeriod(ref.valid_from, ref.valid_to)
                        : "–"}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {ref.counts ? "Ja" : "Nej – ikke i nærheden"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </article>
  );
}
