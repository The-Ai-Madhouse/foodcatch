import { chainName } from "@/lib/chains";
import { formatPeriod, formatUnitPriceRange, unitLabel } from "@/lib/format";
import { KIND_LABELS, linearScale, type PriceChartModel, type SeriesKey } from "@/lib/history";

const WIDTH = 720;
const HEIGHT = 300;
const MARGIN = { top: 30, right: 16, bottom: 32, left: 56 };

const SERIES_COLOR: Readonly<Record<SeriesKey, string>> = {
  netto_offer: "var(--series-1)",
  other_offer: "var(--series-2)",
  regular: "var(--series-3)",
};

/**
 * Unit prices over time as an accessible SVG: each listing is a horizontal segment over its
 * validity period (a band when the pack sizes give a price range). Hovering a mark shows its
 * details; the same data is always available in the table next to the chart.
 */
export function PriceChart({
  model,
  title,
  now,
}: {
  model: PriceChartModel;
  title: string;
  now: number;
}) {
  const x = linearScale(model.xDomain, [MARGIN.left, WIDTH - MARGIN.right]);
  const y = linearScale(model.yDomain, [HEIGHT - MARGIN.bottom, MARGIN.top]);
  const unit = unitLabel(model.unit);
  const nowX = x(now);

  return (
    <figure className="rounded-xl border border-line bg-surface p-4">
      <figcaption className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold text-ink">Pris pr. {unit} over tid</span>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-2" aria-label="Forklaring">
          {model.series.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <svg width="16" height="8" aria-hidden="true">
                <rect width="16" height="8" rx="2" fill={SERIES_COLOR[s.key]} />
              </svg>
              {s.label}
            </li>
          ))}
        </ul>
      </figcaption>
      <div className="-mx-4 overflow-x-auto px-4">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="h-auto w-full min-w-[540px]"
          role="img"
          aria-label={`${title}: pris pr. ${unit} over tid. Samme tal står i tabellen under grafen.`}
        >
          <g className="text-[13px]" fill="var(--ink-3)">
            {model.yTicks.map((t) => (
              <g key={`y${t.value}`}>
                <line
                  x1={MARGIN.left}
                  x2={WIDTH - MARGIN.right}
                  y1={y(t.value)}
                  y2={y(t.value)}
                  stroke="var(--grid)"
                  strokeWidth={1}
                />
                <text x={MARGIN.left - 8} y={y(t.value)} dy="0.32em" textAnchor="end">
                  {t.label}
                </text>
              </g>
            ))}
            <line
              x1={MARGIN.left}
              x2={WIDTH - MARGIN.right}
              y1={HEIGHT - MARGIN.bottom}
              y2={HEIGHT - MARGIN.bottom}
              stroke="var(--axis)"
            />
            {model.xTicks.map((t) => (
              <g key={`x${t.value}`}>
                <line
                  x1={x(t.value)}
                  x2={x(t.value)}
                  y1={HEIGHT - MARGIN.bottom}
                  y2={HEIGHT - MARGIN.bottom + 4}
                  stroke="var(--axis)"
                />
                <text x={x(t.value)} y={HEIGHT - MARGIN.bottom + 18} textAnchor="middle">
                  {t.label}
                </text>
              </g>
            ))}
            <text x={MARGIN.left - 8} y={12} textAnchor="end">
              kr./{unit}
            </text>
          </g>

          {nowX >= MARGIN.left && nowX <= WIDTH - MARGIN.right ? (
            <g>
              <line
                x1={nowX}
                x2={nowX}
                y1={MARGIN.top}
                y2={HEIGHT - MARGIN.bottom}
                stroke="var(--axis)"
                strokeDasharray="4 4"
              />
              <text
                x={nowX}
                y={MARGIN.top - 8}
                textAnchor="middle"
                className="text-[13px]"
                fill="var(--ink-3)"
              >
                i dag
              </text>
            </g>
          ) : null}

          {model.marks.map((m, i) => {
            const x1 = x(m.start);
            const x2 = Math.max(x(m.end), x1 + 3);
            const yHigh = y(m.high);
            const yLow = y(m.low);
            const color = SERIES_COLOR[m.series];
            const price = formatUnitPriceRange(m.low, m.high, model.unit) ?? "";
            const label = `${chainName(m.row.chainId)}, ${KIND_LABELS[m.row.kind] ?? m.row.kind}: ${price}, ${formatPeriod(m.row.validFrom, m.row.validTo)}`;
            const band = yLow - yHigh >= 2;
            return (
              <g key={`${m.row.listingId}-${i}`} className="opacity-90 hover:opacity-100">
                <title>{`${label}\n${m.row.title}`}</title>
                {band ? (
                  <rect
                    x={x1}
                    y={yHigh}
                    width={x2 - x1}
                    height={yLow - yHigh}
                    rx={2}
                    fill={color}
                    fillOpacity={0.28}
                    stroke={color}
                    strokeWidth={2}
                  />
                ) : (
                  <line
                    x1={x1}
                    x2={x2}
                    y1={yHigh}
                    y2={yHigh}
                    stroke={color}
                    strokeWidth={3}
                    strokeLinecap="round"
                    strokeDasharray={m.openEnded ? "6 3" : undefined}
                  />
                )}
                {/* Larger invisible hit target for the tooltip. */}
                <rect
                  x={x1}
                  y={yHigh - 6}
                  width={x2 - x1}
                  height={yLow - yHigh + 12}
                  fill="transparent"
                />
              </g>
            );
          })}
        </svg>
      </div>
      {model.excluded > 0 ? (
        <p className="mt-2 text-xs text-ink-3">
          {model.excluded} {model.excluded === 1 ? "pris" : "priser"} vises kun i tabellen
          (madspild, anden enhed, ukendt kilopris, pris for flere forskellige varer eller ældre end
          et år).
        </p>
      ) : null}
    </figure>
  );
}
