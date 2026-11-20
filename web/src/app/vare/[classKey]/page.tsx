import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MemberPriceTag } from "@/components/Badge";
import { ChainDot } from "@/components/ChainDot";
import { PriceChart } from "@/components/PriceChart";
import { SourceLink } from "@/components/SourceLink";
import { cleanClassLabel } from "@/lib/deals";
import {
  formatDkk,
  formatMonth,
  formatShortPeriod,
  formatUnitPriceRange,
  packSize,
  unitLabel,
} from "@/lib/format";
import { KIND_LABELS, buildPriceChart, type PriceHistoryRow } from "@/lib/history";
import { classKeyFromSegment, productPath } from "@/lib/routes";
import { sourceLink } from "@/lib/sources";
import { storeDisplayName } from "@/lib/stores";
import { getClassPriceHistory, getStoresByIds } from "@/server/queries";

export async function generateMetadata({
  params,
}: PageProps<"/vare/[classKey]">): Promise<Metadata> {
  const classKey = classKeyFromSegment((await params).classKey);
  const rows = classKey ? await getClassPriceHistory(classKey) : [];
  return {
    title: rows[0] ? `Prishistorik: ${cleanClassLabel(rows[0].classLabel)}` : "Ukendt vare",
  };
}

/** Rows newest first, grouped by the month they started in. */
function byMonth(rows: readonly PriceHistoryRow[]): { month: string; rows: PriceHistoryRow[] }[] {
  const groups: { month: string; rows: PriceHistoryRow[] }[] = [];
  for (const row of [...rows].sort((a, b) => Date.parse(b.validFrom) - Date.parse(a.validFrom))) {
    const month = formatMonth(row.validFrom);
    const last = groups.at(-1);
    if (last?.month === month) last.rows.push(row);
    else groups.push({ month, rows: [row] });
  }
  return groups;
}

export default async function ClassHistoryPage({ params }: PageProps<"/vare/[classKey]">) {
  const classKey = classKeyFromSegment((await params).classKey);
  if (!classKey) notFound();
  const rows = await getClassPriceHistory(classKey);
  const first = rows[0];
  if (!first) notFound();

  const now = new Date();
  const model = buildPriceChart(rows, now);
  const title = cleanClassLabel(first.classLabel);
  const stores = await getStoresByIds(rows.flatMap((r) => (r.storeId ? [r.storeId] : [])));

  return (
    <div className="mx-auto max-w-[760px]">
      <h1 className="text-display shelf text-ink">{title}</h1>
      <p className="text-meta text-ink-2">
        {rows.length} {rows.length === 1 ? "pris" : "priser"} registreret
      </p>

      <div className="mt-4">
        <PriceChart model={model} title={title} now={now.getTime()} />
      </div>

      <div className="mt-6 space-y-6">
        {byMonth(rows).map((group) => (
          <section key={group.month} aria-labelledby={`maaned-${group.month}`}>
            <h2 id={`maaned-${group.month}`} className="mb-2 text-meta font-semibold text-ink-3">
              {group.month}
            </h2>
            <ul className="divide-y divide-line rounded-xl border border-line bg-surface px-4">
              {group.rows.map((row, i) => {
                const size = packSize({
                  unit: row.unit,
                  sizeMin: row.sizeMin,
                  sizeMax: row.sizeMax,
                  source: row.source,
                  description: row.description,
                });
                const store = row.storeId ? stores.get(row.storeId) : undefined;
                const facts = [
                  size.text,
                  row.price != null ? formatDkk(row.price) : null,
                  formatUnitPriceRange(row.unitPriceMin, row.unitPriceMax, row.unit) ??
                    `ukendt pr. ${unitLabel(row.unit)}`,
                ].filter(Boolean);
                return (
                  <li
                    key={`${row.listingId}-${i}`}
                    className={`py-3 ${row.priceApplies ? "" : "opacity-70"}`}
                  >
                    <p className="flex items-center gap-1.5 text-meta text-ink-2">
                      <ChainDot chainId={row.chainId} size="xs" />
                      <span className="font-semibold text-ink">{row.chainName}</span> ·{" "}
                      {KIND_LABELS[row.kind] ?? row.kind}
                      {row.memberOnly ? <MemberPriceTag /> : null}
                    </p>
                    <p className="text-ink">{row.title}</p>
                    {store ? (
                      <p className="text-meta text-ink-2">
                        {storeDisplayName(store.name, store.chainId)}
                      </p>
                    ) : null}
                    <p className="text-meta text-ink-2 tabular">{facts.join(" · ")}</p>
                    <p className="text-meta text-ink-3">
                      {formatShortPeriod(row.validFrom, row.validTo)}
                    </p>
                    {row.priceApplies ? null : (
                      <p className="text-meta text-ink-3">Gælder flere varer – ikke i grafen</p>
                    )}
                    <div className="flex flex-wrap items-center gap-x-4">
                      <SourceLink
                        link={sourceLink(
                          {
                            source: row.source,
                            chainId: row.chainId,
                            sourceItemId: row.sourceItemId,
                            catalogId: row.catalogId,
                            validTo: row.validTo,
                          },
                          now,
                        )}
                      />
                      {row.productKey ? (
                        <Link
                          href={productPath(row.productKey) as Route}
                          className="inline-flex min-h-11 items-center text-meta"
                        >
                          Prishistorik for varen
                        </Link>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
