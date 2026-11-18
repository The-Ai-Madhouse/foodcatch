import { chainName } from "@/lib/chains";
import { formatPeriod, formatUnitPriceRange, unitLabel } from "@/lib/format";
import { KIND_LABELS, linearScale, type PriceChartModel, type SeriesKey } from "@/lib/history";

/** Two drawings of the same model: phones get a narrower canvas, so text stays legible. */
const SIZES = {
  wide: { width: 720, height: 300, margin: { top: 30, right: 16, bottom: 32, left: 16 } },
  narrow: { width: 360, height: 240, margin: { top: 30, right: 10, bottom: 32, left: 10 } },
} as const;

const SERIES_COLOR: Readonly<Record<SeriesKey, string>> = {
  netto_offer: "var(--series-1)",
  other_offer: "var(--series-2)",
  regular: "var(--series-3)",
};

/**
 * Unit prices over time as an accessible SVG: each listing is a horizontal segment over its
 * validity period (a band when the pack sizes give a price range). Hovering a mark shows its
 * details; the same data is always available in the list below the chart. Scales to the width of
 * its container (no horizontal scrolling).
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
  const unit = unitLabel(model.unit);
  return (
    <figure className="rounded-xl border border-line bg-surface p-4">
      <figcaption className="mb-2">
        <span className="text-meta font-semibold text-ink">Pris pr. {unit} over tid</span>
        <ul
          className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-meta text-ink-2"
          aria-label="Forklaring"
        >
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
      <div className="md:hidden">
        <ChartSvg model={model} title={title} now={now} size="narrow" />
      </div>
      <div className="hidden md:block">
        <ChartSvg model={model} title={title} now={now} size="wide" />
      </div>
      {model.excluded > 0 ? (
        <p className="mt-2 text-xs text-ink-3">
          {model.excluded} {model.excluded === 1 ? "pris" : "priser"} vises kun i listen (madspild,
          anden enhed, ukendt kilopris, pris for flere forskellige varer eller ældre end et år).
        </p>
      ) : null}
    </figure>
  );
}

function ChartSvg({
  model,
  title,
  now,
  size,
}: {
  model: PriceChartModel;
  title: string;
  now: number;
  size: keyof typeof SIZES;
}) {
  const { width: WIDTH, height: HEIGHT, margin: MARGIN } = SIZES[size];
  const x = linearScale(model.xDomain, [MARGIN.left, WIDTH - MARGIN.right]);
  const y = linearScale(model.yDomain, [HEIGHT - MARGIN.bottom, MARGIN.top]);
  const unit = unitLabel(model.unit);
  const nowX = x(now);
  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="h-auto w-full"
      role="img"
      aria-label={`${title}: pris pr. ${unit} over tid. Samme tal står i listen under grafen.`}
    >
      <g className="text-[12px]" fill="var(--ink-3)">
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
            {/* Labels sit inside the plot, just above their grid line. */}
            <text x={MARGIN.left + 2} y={y(t.value) - 4}>
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
        <text x={MARGIN.left} y={12}>
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
            textAnchor={nowX > WIDTH - 30 ? "end" : "middle"}
            className="text-[12px]"
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
  );
}
