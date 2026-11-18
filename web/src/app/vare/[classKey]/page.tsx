import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { PriceChart } from "@/components/PriceChart";
import { formatDate, formatUnitPriceRange, unitLabel } from "@/lib/format";
import { KIND_LABELS, buildPriceChart } from "@/lib/history";
import { classKeyFromSegment } from "@/lib/routes";
import { getClassPriceHistory } from "@/server/queries";

export async function generateMetadata({
  params,
}: PageProps<"/vare/[classKey]">): Promise<Metadata> {
  const classKey = classKeyFromSegment((await params).classKey);
  const rows = classKey ? await getClassPriceHistory(classKey) : [];
  return { title: rows[0] ? `Prishistorik: ${rows[0].classLabel}` : "Ukendt vare" };
}

export default async function ClassHistoryPage({ params }: PageProps<"/vare/[classKey]">) {
  const classKey = classKeyFromSegment((await params).classKey);
  if (!classKey) notFound();
  const rows = await getClassPriceHistory(classKey);
  const first = rows[0];
  if (!first) notFound();

  const now = new Date();
  const model = buildPriceChart(rows, now);
  const newestFirst = [...rows].reverse();

  return (
    <>
      <PageHeader
        title={first.classLabel}
        lead={`Prishistorik for præcis denne vare: Netto-tilbud, andre kæders tilbud og normalpriser, som vi har registreret dem (${rows.length} ${rows.length === 1 ? "pris" : "priser"}). Tilbud, hvor én pris dækker flere forskellige varer, vises kun i tabellen.`}
      />
      <PriceChart model={model} title={first.classLabel} now={now.getTime()} />

      <section aria-labelledby="pris-tabel" className="mt-8">
        <h2 id="pris-tabel" className="text-lg font-bold text-ink">
          Alle registrerede priser
        </h2>
        <div className="mt-3 overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Priser for {first.classLabel}, nyeste først</caption>
            <thead className="text-xs text-ink-3">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Periode
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Kæde
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Type
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Vare
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Pris pr. enhed
                </th>
              </tr>
            </thead>
            <tbody>
              {newestFirst.map((r, i) => (
                <tr key={`${r.listingId}-${i}`} className="border-t border-line">
                  <td className="px-3 py-2 whitespace-nowrap">
                    {formatDate(r.validFrom)} – {r.validTo ? formatDate(r.validTo) : "nu"}
                  </td>
                  <td className="px-3 py-2">{r.chainName}</td>
                  <td className="px-3 py-2">{KIND_LABELS[r.kind] ?? r.kind}</td>
                  <td className="px-3 py-2">{r.title}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap tabular">
                    {formatUnitPriceRange(r.unitPriceMin, r.unitPriceMax, r.unit) ??
                      `ukendt pr. ${unitLabel(r.unit)}`}
                    {r.priceApplies ? null : (
                      <span className="block text-xs text-ink-3">
                        gælder flere varer – ikke i grafen
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
