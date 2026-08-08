"use client";

import { useMemo, useState } from "react";

import { formatIdrFromCents, formatIdrShortAxis } from "@/lib/dashboard/idr";
import type { DashboardNetworthTrendPoint } from "@/lib/dashboard/types";

/**
 * Hand-rolled SVG line chart for the dashboard networth trend
 * (sub-0007-03). Renders 12 months of networth points as a line +
 * dots, with a hover/tap tooltip that exposes the exact month and
 * IDR value for the engaged point.
 *
 * Why hand-rolled (per Tech Leader decision, tracked in the tracker
 * as v6.3): the SOP ruled out adding `recharts` / `nivo` / `chart.js`
 * so the FE keeps zero new chart dependencies. The chart only needs
 * a 12-point line + axis + tooltip — well within the ~200 LOC we
 * sized for this sub-task. SVG scales cleanly to the mobile 390×844
 * viewport (the chart's `viewBox` + `preserveAspectRatio` handle
 * responsiveness without any JS) and remains accessible because the
 * root carries a single `role="img"` + descriptive `aria-label`.
 */

interface NetworthTrendChartProps {
  /**
   * Per-month networth data points from `GET /dashboard/networth-trend`.
   * The component mirrors the backend contract: `month` is `YYYY-MM`
   * (no day component) and `networthCents` is a signed integer in
   * minor units (1/100 rupiah). A negative `networthCents` is legal
   * and means liabilities > assets — the chart still renders it.
   */
  data: DashboardNetworthTrendPoint[];
}

/**
 * ViewBox dimensions. 800×400 mirrors the desktop card slot (the
 * chart's container applies max-width via Tailwind) and `xMidYMid meet`
 * keeps the line centered when the parent shrinks on mobile — the
 * line never gets clipped, it just gets smaller. Keep this in sync
 * with the `MARGIN` constants below; the helpers assume this box.
 */
const VIEWBOX_WIDTH = 800;
const VIEWBOX_HEIGHT = 400;

/**
 * Plot area margins in viewBox units. Left edge reserves room for the
 * Y-axis tick labels (`formatIdrShortAxis` produces up to 8 chars);
 * bottom edge reserves room for the X-axis month labels.
 */
const MARGIN = {
  top: 24,
  right: 24,
  bottom: 48,
  left: 72,
} as const;

/**
 * Y-domain fall-back when the entire series is flat at zero (which
 * happens for brand-new users with no accounts yet). Without a
 * non-zero domain the chart would collapse to a single horizontal
 * line at the top — the ±Rp 1.000 baseline gives a visible "empty
 * but present" axis that matches the empty-state copy below.
 */
const EMPTY_FALLBACK_MIN_CENTS = -100_000;
const EMPTY_FALLBACK_MAX_CENTS = 100_000;

/**
 * Inclusive lower + upper bound for the Y domain. We pad the raw
 * `min`/`max` by 5% so the line never touches the chart frame — a
 * flat-zero series would otherwise snap to the very top of the plot
 * area and visually disappear.
 */
const Y_AXIS_PADDING_RATIO = 0.05;

/**
 * Number of tick marks to render on the Y axis (including the top
 * and bottom). Five ticks hit the standard "human-readable grid"
 * sweet spot without crowding the axis.
 */
const Y_AXIS_TICK_COUNT = 5;

/**
 * Index of the hovered/tapped data point. `null` means the tooltip is
 * hidden. We key the tooltip off the index rather than the month
 * string so the same point stays sticky across re-renders that don't
 * change the data identity.
 */
type HoverIndex = number | null;

/**
 * `true` iff the supplied series has no rendering-meaningful data —
 * either an empty array or every point's networth is zero. The empty
 * state copy is rendered in that case so the user sees a guided
 * message instead of a flat zero line.
 */
function isEmptySeries(data: DashboardNetworthTrendPoint[]): boolean {
  if (data.length === 0) return true;
  return data.every((point) => point.networthCents === 0);
}

/**
 * Format a `YYYY-MM` month label as `Jan 2026` using the id-ID locale.
 * `Intl.DateTimeFormat` accepts the synthetic `YYYY-MM-DD` date so we
 * don't need a date library. Falls back to the raw `month` string
 * when the format itself fails (older runtimes, malformed locale).
 */
function formatMonthLabel(month: string): string {
  const fallback = month;
  if (!/^\d{4}-\d{2}$/.test(month)) return fallback;
  const date = new Date(`${month}-01T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return fallback;
  try {
    return new Intl.DateTimeFormat("id-ID", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    }).format(date);
  } catch {
    return fallback;
  }
}

/**
 * Compute the Y domain `[yMin, yMax]` for a non-empty series. We
 * intentionally include zero in the domain so the chart can render
 * a baseline (people read "my networth crossed zero" naturally); if
 * the data is entirely positive or entirely negative the zero is
 * still inside the band automatically.
 */
function computeYDomain(data: DashboardNetworthTrendPoint[]): {
  yMin: number;
  yMax: number;
} {
  if (data.length === 0) {
    return { yMin: EMPTY_FALLBACK_MIN_CENTS, yMax: EMPTY_FALLBACK_MAX_CENTS };
  }
  let min = data[0].networthCents;
  let max = data[0].networthCents;
  for (const point of data) {
    if (point.networthCents < min) min = point.networthCents;
    if (point.networthCents > max) max = point.networthCents;
  }
  if (min === max) {
    // Flat series — give a 1-cent sliver of breathing room so the
    // line doesn't draw on top of itself. If both values are zero
    // return the empty fallback so the chart renders the ±Rp 1.000
    // baseline that mirrors the empty-state visuals.
    if (min === 0) {
      return { yMin: EMPTY_FALLBACK_MIN_CENTS, yMax: EMPTY_FALLBACK_MAX_CENTS };
    }
    const slack = Math.max(Math.abs(min) * Y_AXIS_PADDING_RATIO, 1);
    return { yMin: min - slack, yMax: max + slack };
  }
  // Include zero if it's outside the [min, max] range so the baseline
  // is visually meaningful (a long stretch of negative networth would
  // otherwise squeeze the line into the top of the chart).
  if (min > 0) min = 0;
  if (max < 0) max = 0;
  const span = max - min;
  const pad = Math.max(span * Y_AXIS_PADDING_RATIO, 1);
  return { yMin: min - pad, yMax: max + pad };
}

/**
 * `evenlySpaced` produces N evenly-spaced numbers between `lo` and
 * `hi`, inclusive. Used for the Y-axis grid lines and tick labels.
 */
function evenlySpaced(lo: number, hi: number, count: number): number[] {
  if (count <= 1) return [lo];
  const step = (hi - lo) / (count - 1);
  const ticks: number[] = [];
  for (let i = 0; i < count; i += 1) {
    ticks.push(lo + step * i);
  }
  return ticks;
}

/**
 * Determine the dominant trend of the series. The SOP spec calls for
 * an emerald line on a positive trend and a rose line on a negative
 * trend — the threshold is the difference between the last and first
 * point (later monthly points are more representative of the user's
 * current direction). A flat series (first == last) lands on the
 * positive branch because surfacing a neutral green is friendlier
 * than a warning red for a brand-new user.
 */
function classifyTrend(data: DashboardNetworthTrendPoint[]): "positive" | "negative" {
  if (data.length === 0) return "positive";
  const first = data[0].networthCents;
  const last = data[data.length - 1].networthCents;
  return last >= first ? "positive" : "negative";
}

/**
 * Build the `d` attribute for the line path. Mirrors a `d3-shape`
 * "linear" curve (`M` then `L` per point) so the rendered line is
 * straight between dots — no smoothing artifacts. The caller is
 * expected to render the dots as a separate overlay so the line +
 * dots layer cleanly.
 */
function buildLinePath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return "";
  const head = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  const rest = points
    .slice(1)
    .map((point) => `L ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(" ");
  return `${head} ${rest}`.trim();
}

/**
 * Build the `points` array for the polyline fallback. Used only by
 * the unit tests (the production render uses `<path>` for the line
 * — a polyline would render the same here but the explicit path is
 * how we keep the SVG to a single shape primitive).
 */
function buildProjectedPoints(
  data: DashboardNetworthTrendPoint[],
  yMin: number,
  yMax: number,
): { x: number; y: number; value: number; month: string }[] {
  const plotLeft = MARGIN.left;
  const plotRight = VIEWBOX_WIDTH - MARGIN.right;
  const plotTop = MARGIN.top;
  const plotBottom = VIEWBOX_HEIGHT - MARGIN.bottom;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;
  const span = yMax - yMin;
  const xStep = data.length > 1 ? plotWidth / (data.length - 1) : 0;
  return data.map((point, index) => {
    const x = data.length > 1 ? plotLeft + index * xStep : plotLeft + plotWidth / 2;
    const ratio = span === 0 ? 0.5 : (point.networthCents - yMin) / span;
    const y = plotTop + (1 - ratio) * plotHeight;
    return { x, y, value: point.networthCents, month: point.month };
  });
}

/**
 * Accessible summary label for the chart. Mirrors the format pinned
 * in the SOP: "Networth trend 12 bulan: tertinggi Rp X, terendah Rp Y".
 * When the series is empty (or flat) the label omits the magnitude
 * so screen-reader users don't hear a misleading Rp 0.
 */
function buildAriaLabel(data: DashboardNetworthTrendPoint[]): string {
  if (data.length === 0) {
    return "Networth trend: belum ada data networth.";
  }
  const values = data.map((point) => point.networthCents);
  const highest = Math.max(...values);
  const lowest = Math.min(...values);
  if (highest === 0 && lowest === 0) {
    return "Networth trend 12 bulan: belum ada perubahan nilai.";
  }
  return `Networth trend 12 bulan: tertinggi ${formatIdrFromCents(highest)}, terendah ${formatIdrFromCents(lowest)}.`;
}

/**
 * Root container for the networth trend card. Owns the chart card
 * chrome (heading + 12 bulan terakhir hint) and delegates the SVG
 * body to the inner `NetworthTrendChartSvg` so the card chrome can
 * stay a server component if we ever want to swap the loading state
 * out at the page level.
 */
export function NetworthTrendChart({ data }: NetworthTrendChartProps) {
  const isEmpty = isEmptySeries(data);
  const ariaLabel = buildAriaLabel(data);

  return (
    <section
      className="card flex h-full flex-col"
      aria-labelledby="dashboard-networth-trend-heading"
      data-chart="networth-trend"
      data-empty={isEmpty ? "true" : "false"}
    >
      <header className="flex items-center justify-between gap-3">
        <div>
          <h3
            id="dashboard-networth-trend-heading"
            className="text-base font-semibold text-slate-900"
          >
            Tren Networth
          </h3>
          <p
            className="mt-1 text-xs text-slate-500"
            data-window-months={data.length}
          >
            {data.length > 0
              ? `${data.length} bulan terakhir`
              : "Belum ada jendela waktu"}
          </p>
        </div>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[0.65rem] font-semibold uppercase tracking-wide text-slate-500">
          {data.length > 0 ? `${data.length} bulan` : "Kosong"}
        </span>
      </header>
      <div className="mt-6 flex-1">
        {isEmpty ? (
          <p
            className="flex h-full min-h-[12rem] items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-12 text-center text-xs text-slate-500"
            data-empty-message="networth-trend"
          >
            Belum ada data networth
          </p>
        ) : (
          <NetworthTrendChartSvg data={data} ariaLabel={ariaLabel} />
        )}
      </div>
    </section>
  );
}

/**
 * Pure SVG body of the chart. Kept as a separate `use client`-
 * annotated component so the tooltip state (hover/tap) is localized
 * to the SVG — the surrounding card chrome doesn't need to re-render
 * on every hover tick.
 */
function NetworthTrendChartSvg({
  data,
  ariaLabel,
}: {
  data: DashboardNetworthTrendPoint[];
  ariaLabel: string;
}) {
  const [hoverIndex, setHoverIndex] = useState<HoverIndex>(null);

  const { points, linePath, yTicks, trend, projectedExtreme } = useMemo(() => {
    const { yMin, yMax } = computeYDomain(data);
    const projected = buildProjectedPoints(data, yMin, yMax);
    const path = buildLinePath(projected);
    const ticks = evenlySpaced(yMin, yMax, Y_AXIS_TICK_COUNT);
    const trendDirection = classifyTrend(data);
    const values = data.map((point) => point.networthCents);
    const highest = Math.max(...values);
    const lowest = Math.min(...values);
    return {
      points: projected,
      linePath: path,
      yTicks: ticks,
      trend: trendDirection,
      projectedExtreme: {
        highest,
        lowest,
      },
    };
  }, [data]);

  const plotLeft = MARGIN.left;
  const plotRight = VIEWBOX_WIDTH - MARGIN.right;
  const plotTop = MARGIN.top;
  const plotBottom = VIEWBOX_HEIGHT - MARGIN.bottom;
  const plotHeight = plotBottom - plotTop;
  const yDomain = computeYDomain(data);
  const ySpan = yDomain.yMax - yDomain.yMin;

  const lineStroke = trend === "positive" ? "#059669" : "#e11d48"; // emerald-600 / rose-600
  const lineStrokeClass = trend === "positive" ? "stroke-emerald-600" : "stroke-rose-600";
  const dotFill = trend === "positive" ? "#059669" : "#e11d48";
  const dotFillClass = trend === "positive" ? "fill-emerald-600" : "fill-rose-600";

  const activePoint =
    hoverIndex !== null && hoverIndex >= 0 && hoverIndex < points.length
      ? points[hoverIndex]
      : null;

  return (
    <svg
      viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
      preserveAspectRatio="xMidYMid meet"
      className="h-56 w-full"
      role="img"
      aria-label={ariaLabel}
      data-trend={trend}
      data-points={data.length}
    >
      {/* Y-axis grid + tick labels */}
      <g aria-hidden="true">
        {yTicks.map((tick, index) => {
          const ratio = ySpan === 0 ? 0.5 : (tick - yDomain.yMin) / ySpan;
          const y = plotTop + (1 - ratio) * plotHeight;
          const isBaseline = tick === 0;
          return (
            <g key={`y-tick-${index}`}>
              <line
                x1={plotLeft}
                x2={plotRight}
                y1={y}
                y2={y}
                stroke={isBaseline ? "#cbd5e1" : "#e2e8f0"}
                strokeDasharray={isBaseline ? undefined : "4 4"}
                strokeWidth={1}
              />
              <text
                x={plotLeft - 10}
                y={y}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-slate-500 text-[0.7rem]"
              >
                {formatIdrShortAxis(tick)}
              </text>
            </g>
          );
        })}
      </g>

      {/* X-axis month labels */}
      <g aria-hidden="true">
        {points.map((point, index) => (
          <text
            key={`x-label-${index}`}
            x={point.x}
            y={plotBottom + 18}
            textAnchor="middle"
            className="fill-slate-500 text-[0.7rem]"
          >
            {formatMonthLabel(point.month)}
          </text>
        ))}
      </g>

      {/* Line path */}
      <path
        d={linePath}
        fill="none"
        className={lineStrokeClass}
        stroke={lineStroke}
        strokeWidth={2.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        data-line-path={linePath}
      />

      {/* Dots + interaction overlays */}
      <g>
        {points.map((point, index) => {
          const isActive = hoverIndex === index;
          return (
            <g key={`dot-${index}`}>
              {/* Visible dot */}
              <circle
                cx={point.x}
                cy={point.y}
                r={isActive ? 5 : 3.5}
                className={dotFillClass}
                fill={dotFill}
                stroke="#ffffff"
                strokeWidth={1.5}
                data-index={index}
              />
              {/* Invisible hit area — wider than the dot so taps land
                  cleanly on mobile (SVG circles have no padding). */}
              <circle
                cx={point.x}
                cy={point.y}
                r={14}
                fill="transparent"
                onMouseEnter={() => setHoverIndex(index)}
                onMouseLeave={() => setHoverIndex((current) => (current === index ? null : current))}
                onFocus={() => setHoverIndex(index)}
                onBlur={() => setHoverIndex((current) => (current === index ? null : current))}
                onClick={() =>
                  setHoverIndex((current) => (current === index ? null : index))
                }
                tabIndex={0}
                role="button"
                aria-label={`${formatMonthLabel(point.month)}: ${formatIdrFromCents(point.value)}`}
              />
            </g>
          );
        })}
      </g>

      {/* Tooltip */}
      {activePoint ? (
        <Tooltip point={activePoint} />
      ) : null}

      {/* Hidden summary reused by the unit test (the data-trend +
          data-points attrs are also exposed for easier assertions). */}
      <metadata data-highest={projectedExtreme.highest} data-lowest={projectedExtreme.lowest} />
    </svg>
  );
}

/**
 * Tooltip rendered as a `<g>` anchored at the hovered dot's position.
 * Positioned to the right of the dot when there's room, otherwise
 * flipped to the left, so the tooltip never gets clipped at the
 * chart edge. The background rectangle uses a slate-900 fill so the
 * white text reads on both emerald and rose stems.
 */
function Tooltip({ point }: { point: { x: number; y: number; value: number; month: string } }) {
  const tooltipWidth = 150;
  const tooltipHeight = 38;
  const offset = 12;
  const plotRight = VIEWBOX_WIDTH - MARGIN.right;
  const flipLeft = point.x + offset + tooltipWidth > plotRight;
  const x = flipLeft ? point.x - offset - tooltipWidth : point.x + offset;
  const y = point.y - tooltipHeight / 2;
  const label = formatMonthLabel(point.month);
  const value = formatIdrFromCents(point.value);
  return (
    <g
      role="tooltip"
      aria-hidden="true"
      data-tooltip-month={point.month}
      data-tooltip-value={value}
    >
      <rect
        x={x}
        y={y}
        width={tooltipWidth}
        height={tooltipHeight}
        rx={6}
        ry={6}
        fill="#0f172a"
        opacity={0.92}
      />
      <text
        x={x + 12}
        y={y + 16}
        className="fill-slate-300 text-[0.7rem]"
      >
        {label}
      </text>
      <text
        x={x + 12}
        y={y + 30}
        className="fill-white text-[0.8rem] font-semibold tabular-nums"
      >
        {value}
      </text>
    </g>
  );
}

// Pure helpers exported for the unit test (sub-0007-03 AC). The
// test pins the trend classification, the Y-domain fallback, the
// empty-state branching, and the SVG path string so a render
// regression is caught at the logic layer (the FE doesn't ship a
// Jest/Vitest runner — the env-var guard matches the sub-0007-02
// `idr.test.ts` pattern).
export {
  computeYDomain,
  classifyTrend,
  isEmptySeries,
  formatMonthLabel,
  buildLinePath,
  buildProjectedPoints,
  buildAriaLabel,
};
