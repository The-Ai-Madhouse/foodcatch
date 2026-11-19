import { ChainDot } from "@/components/ChainDot";
import { chainName, chainStyle } from "@/lib/chains";
import { formatDkk, formatPeriod, formatUnitPriceRange, unitLabel } from "@/lib/format";
import { linearScale } from "@/lib/history";
import {
  chartSummary,
  productKindLabel,
  stepPath,
  type ProductChartModel,
  type ProductKind,
  type ProductMark,
} from "@/lib/product";

/** Two drawings of the same model: phones get a narrower canvas, so text stays legible. */
const SIZES = {
  wide: { width: 720, height: 300, margin: { top: 30, right: 16, bottom: 32, left: 16 } },
  narrow: { width: 360, height: 240, margin: { top: 30, right: 10, bottom: 32, left: 10 } },
} as const;

/** An outline under every mark, so light chain colours (Netto's yellow) stay visible. */
const HALO = "var(--dot-ring)";

/** The mark shape of each kind, drawn in neutral ink for the legend. */
function KindGlyph({ kind }: { kind: ProductKind }) {
  const ink = "var(--ink-2)";
  return (
    <svg width="22" height="12" aria-hidden="true" className="shrink-0">
      {kind === "regular" ? (
        <path d="M1,9 H9 V3 H21" fill="none" stroke={ink} strokeWidth={2} />
      ) : kind === "reference" ? (
        <path d="M1,9 H9 V3 H21" fill="none" stroke={ink} strokeWidth={2} strokeDasharray="3 2" />
      ) : kind === "offer" ? (
        <line x1={3} x2={19} y1={6} y2={6} stroke={ink} strokeWidth={5} strokeLinecap="round" />
      ) : (
        <circle cx={11} cy={6} r={4.5} fill={ink} />
      )}
    </svg>
  );
}

function markLabel(m: ProductMark, model: ProductChartModel): string {
  const price =
    model.measure === "pakke"
      ? formatDkk(m.high)
      : (formatUnitPriceRange(m.low, m.high, model.unit) ?? "");
  return `${chainName(m.chainId)}, ${productKindLabel(m.kind)}: ${price}, ${formatPeriod(m.row.validFrom, m.row.validTo)}\n${m.row.title}`;
}

/**
 * The price history of one item as an accessible SVG: shelf prices as step lines (Salling's
 * normal price dashed), offers as segments over their period (a band when pack sizes give a
 * unit-price range), clearances as points; colour = chain (with its monogram in the legend),
 * shape = kind. The same numbers are in the table under the chart.
 */
export function ProductPriceChart({
  model,
  title,
  now,
}: {
  model: ProductChartModel;
  title: string;
  now: number;
}) {
  const caption =
    model.measure === "pakke"
      ? "Pris for pakken over tid"
      : `Pris pr. ${unitLabel(model.unit)} over tid`;
  return (
    <figure className="rounded-xl border border-line bg-surface p-4">
      <figcaption className="mb-2">
        <span className="text-meta font-semibold text-ink">{caption}</span>
        <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-meta text-ink-2" aria-label="Kæder">
          {model.chains.map((chainId) => (
            <li key={chainId} className="flex items-center gap-1.5">
              <ChainDot chainId={chainId} />
              {chainName(chainId)}
            </li>
          ))}
        </ul>
        <ul
          className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-meta text-ink-2"
          aria-label="Pristyper"
        >
          {model.kinds.map((kind) => (
            <li key={kind} className="flex items-center gap-1.5">
              <KindGlyph kind={kind} />
              {productKindLabel(kind)}
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
    </figure>
  );
}

function ChartSvg({
  model,
  title,
  now,
  size,
}: {
  model: ProductChartModel;
  title: string;
  now: number;
  size: keyof typeof SIZES;
}) {
  const { width: WIDTH, height: HEIGHT, margin: MARGIN } = SIZES[size];
  const x = linearScale(model.xDomain, [MARGIN.left, WIDTH - MARGIN.right]);
  const y = linearScale(model.yDomain, [HEIGHT - MARGIN.bottom, MARGIN.top]);
  const nowX = x(now);
  const yUnit = model.measure === "pakke" ? "kr." : `kr./${unitLabel(model.unit)}`;
  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="h-auto w-full"
      role="img"
      aria-label={chartSummary(model, title)}
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
          {yUnit}
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

      {/* Shelf prices: step lines per chain, under the offers. */}
      {model.steps.map((series) => {
        const d = stepPath(series.marks, x, y);
        const color = chainStyle(series.chainId).fill;
        const dash = series.kind === "reference" ? "6 4" : undefined;
        return (
          <g key={series.key}>
            <path d={d} fill="none" stroke={HALO} strokeWidth={4} strokeLinejoin="round" />
            <path
              d={d}
              fill="none"
              stroke={color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeDasharray={dash}
            />
            {series.marks.map((m, i) => (
              // Invisible hit targets per price, for the tooltip.
              <rect
                key={i}
                x={x(m.start)}
                y={y(m.high) - 6}
                width={Math.max(x(m.end) - x(m.start), 4)}
                height={12}
                fill="transparent"
              >
                <title>{markLabel(m, model)}</title>
              </rect>
            ))}
          </g>
        );
      })}

      {model.segments.map((m, i) => {
        const x1 = x(m.start);
        const x2 = Math.max(x(m.end), x1 + 4);
        const yHigh = y(m.high);
        const yLow = y(m.low);
        const color = chainStyle(m.chainId).fill;
        const band = yLow - yHigh >= 3;
        return (
          <g key={`o${i}`}>
            <title>{markLabel(m, model)}</title>
            {band ? (
              <rect
                x={x1}
                y={yHigh}
                width={x2 - x1}
                height={yLow - yHigh}
                rx={2}
                fill={color}
                fillOpacity={0.3}
                stroke={color}
                strokeWidth={2}
              />
            ) : (
              <>
                <line
                  x1={x1}
                  x2={x2}
                  y1={yHigh}
                  y2={yHigh}
                  stroke={HALO}
                  strokeWidth={7}
                  strokeLinecap="round"
                />
                <line
                  x1={x1}
                  x2={x2}
                  y1={yHigh}
                  y2={yHigh}
                  stroke={color}
                  strokeWidth={5}
                  strokeLinecap="round"
                />
              </>
            )}
          </g>
        );
      })}

      {model.points.map((m, i) => (
        <circle
          key={`c${i}`}
          cx={x(m.start)}
          cy={y(m.high)}
          r={5.5}
          fill={chainStyle(m.chainId).fill}
          stroke={HALO}
          strokeWidth={1.5}
        >
          <title>{markLabel(m, model)}</title>
        </circle>
      ))}
    </svg>
  );
}
