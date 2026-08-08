"use client";

import { useState } from "react";

import { formatIdrFromCents, formatIdrShortAxis } from "@/lib/dashboard/idr";
import type { DashboardIncomeExpenseTrendPoint } from "@/lib/dashboard/types";

/**
 * Hand-rolled SVG grouped bar chart for the dashboard income vs
 * expense trend (sub-0007-04). Renders 12 months of side-by-side
 * income + expense bars with a legend, hover/tap tooltip, and a
 * per-month empty state.
 *
 * Why hand-rolled (per Tech Leader decision, tracked in the tracker
 * as v6.3): the SOP ruled out adding `recharts` / `nivo` / `chart.js`
 * so the FE keeps zero new chart dependencies. The chart only needs
 * 12 grouped `<rect>` pairs + axis + legend + tooltip — well within
 * the ~200 LOC we sized for this sub-task. SVG scales cleanly to the
 * mobile 390×844 viewport (the chart's `viewBox` +
 * `preserveAspectRatio` handle responsiveness without any JS) and
 * remains accessible because the root carries a single `role="img"`
 * + descriptive `aria-label`.
 */

interface IncomeExpenseChartProps {
  /**
   * Per-month income + expense data points from
   * `GET /dashboard/income-expense-trend`. The component mirrors the
   * backend contract: `month` is `YYYY-MM` (no day component),
   * `incomeCents` and `expenseCents` are non-negative integers in
   * minor units (1/100 rupiah). A per-month all-zero entry is a
   * legitimate state (no transactions that month) and renders the
   * outlined "—" empty stub.
   */
  data: DashboardIncomeExpenseTrendPoint[];
}

/**
 * ViewBox dimensions. 800×400 mirrors the desktop card slot (the
 * chart's container applies max-width via Tailwind) and `xMidYMid meet`
 * keeps the bars centered when the parent shrinks on mobile — the
 * chart never gets clipped, it just gets smaller. Keep this in sync
 * with the `MARGIN` constants below; the helpers assume this box.
 */
const VIEWBOX_WIDTH = 800;
const VIEWBOX_HEIGHT = 400;

/**
 * Plot area margins in viewBox units. Left edge reserves room for the
 * Y-axis tick labels (`formatIdrShortAxis` produces up to ~8 chars);
 * bottom edge reserves room for the X-axis month labels; top edge
 * reserves room for the legend + per-month "—" stub label.
 */
const MARGIN = {
  top: 56,
  right: 24,
  bottom: 56,
  left: 72,
} as const;

/**
 * Y-domain fall-back when the entire series is flat at zero (which
 * happens for brand-new users with no transactions yet). Without a
 * non-zero domain the bars would collapse to a flat zero-height line
 * — the `Rp 100.000` ceiling gives a visible "empty but present"
 * axis that matches the empty-state copy below.
 */
const EMPTY_FALLBACK_MAX_CENTS = 100_000;

/**
 * Inclusive upper bound for the Y domain. We pad the raw `max` by
 * ~5% so the tallest bar never touches the chart frame — a tall bar
 * would otherwise be clipped at the top and visually lose its
 * silhouette.
 */
const Y_AXIS_PADDING_RATIO = 0.05;

/**
 * Number of tick marks to render on the Y axis (including the top
 * and bottom). Five ticks hit the standard "human-readable grid"
 * sweet spot without crowding the axis.
 */
const Y_AXIS_TICK_COUNT = 5;

/**
 * Per-month bar geometry. Two bars per month (income + expense) sit
 * side-by-side inside the per-month slot. The bar width is derived
 * from the slot width so the chart stays readable when the user
 * resizes the window — there's no JS resize listener.
 */
const BAR_GAP_RATIO = 0.18;

/**
 * Color tokens. Mirror the `goal-progress-bar.tsx` (sub-0005-03)
 * palette: emerald = positive (income), rose = expense. Both
 * className + hex are written to the SVG so the inline Tailwind
 * class still wins if the project ever swaps the color scheme in
 * `tailwind.config.ts`.
 */
const INCOME_FILL = "#059669"; // emerald-600
const INCOME_FILL_CLASS = "fill-emerald-600";
const EXPENSE_FILL = "#e11d48"; // rose-600
const EXPENSE_FILL_CLASS = "fill-rose-600";
const EMPTY_STROKE = "#cbd5e1"; // slate-300

/**
 * Index of the hovered/tapped month. `null` means the tooltip is
 * hidden. We key the tooltip off the index rather than the month
 * string so the same month stays sticky across re-renders that
 * don't change the data identity.
 */
type HoverIndex = number | null;

/**
 * `true` iff the supplied series has no rendering-meaningful data —
 * either an empty array or every point has zero income AND zero
 * expense. The empty-state copy is rendered in that case so the user
 * sees a guided message instead of twelve outlined stubs.
 */
function isEmptySeries(data: DashboardIncomeExpenseTrendPoint[]): boolean {
  if (data.length === 0) return true;
  return data.every(
    (point) => point.incomeCents === 0 && point.expenseCents === 0,
  );
}

/**
 * `true` iff this particular month has no income AND no expense —
 * i.e. nothing happened that month. The bar pair renders as outlined
 * stubs with a "—" label above so the user still sees the month slot
 * in the timeline.
 */
function isEmptyMonth(point: DashboardIncomeExpenseTrendPoint): boolean {
  return point.incomeCents === 0 && point.expenseCents === 0;
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
 * Compute the Y domain `[0, yMax]` for a non-empty series. Bars grow
 * from the baseline upward (the SOP keeps the domain zero-anchored
 * so a tall income month is unambiguous). When every bar is zero
 * we fall back to `[0, EMPTY_FALLBACK_MAX_CENTS]` so the axis still
 * shows a meaningful range.
 */
function computeYMax(data: DashboardIncomeExpenseTrendPoint[]): number {
  if (data.length === 0) return EMPTY_FALLBACK_MAX_CENTS;
  let max = 0;
  for (const point of data) {
    if (point.incomeCents > max) max = point.incomeCents;
    if (point.expenseCents > max) max = point.expenseCents;
  }
  if (max === 0) return EMPTY_FALLBACK_MAX_CENTS;
  return Math.round(max * (1 + Y_AXIS_PADDING_RATIO));
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
 * Compute the per-month slot geometry — width of each month band
 * plus the (income bar, expense bar) x-positions inside it. We
 * derive slot width from the plot area width so the chart scales
 * proportionally — `data.length` decides how many slots fill the
 * plot, the bar pair inside each slot is sized as a fraction of
 * the slot via `BAR_GAP_RATIO`.
 */
function buildMonthLayout(dataLength: number): {
  slotWidth: number;
  barWidth: number;
  incomeOffsetX: number;
  expenseOffsetX: number;
} {
  const plotLeft = MARGIN.left;
  const plotRight = VIEWBOX_WIDTH - MARGIN.right;
  const plotWidth = plotRight - plotLeft;
  if (dataLength === 0) {
    return {
      slotWidth: 0,
      barWidth: 0,
      incomeOffsetX: 0,
      expenseOffsetX: 0,
    };
  }
  const slotWidth = plotWidth / dataLength;
  // Two bars + gap inside each slot. `BAR_GAP_RATIO` is the share of
  // the slot reserved as the gap; the remainder splits evenly into
  // two bar widths.
  const totalBarWidth = slotWidth * (1 - BAR_GAP_RATIO);
  const barWidth = totalBarWidth / 2;
  const slotStart = 0;
  // Income bar sits left of the slot centre, expense bar sits right.
  const incomeOffsetX = slotStart + (slotWidth - totalBarWidth) / 2;
  const expenseOffsetX = incomeOffsetX + barWidth;
  return { slotWidth, barWidth, incomeOffsetX, expenseOffsetX };
}

/**
 * Accessible summary label for the chart. Mirrors the format pinned
 * in the SOP: "Income vs expense 12 bulan". When the series is
 * empty (or all-zero) the label omits the magnitude so screen-reader
 * users don't hear a misleading Rp 0.
 */
function buildAriaLabel(data: DashboardIncomeExpenseTrendPoint[]): string {
  if (data.length === 0) {
    return "Income vs expense: belum ada data.";
  }
  const incomeValues = data.map((point) => point.incomeCents);
  const expenseValues = data.map((point) => point.expenseCents);
  const totalIncome = incomeValues.reduce((sum, value) => sum + value, 0);
  const totalExpense = expenseValues.reduce((sum, value) => sum + value, 0);
  if (totalIncome === 0 && totalExpense === 0) {
    return "Income vs expense 12 bulan: belum ada transaksi.";
  }
  return `Income vs expense 12 bulan: total pemasukan ${formatIdrFromCents(totalIncome)}, total pengeluaran ${formatIdrFromCents(totalExpense)}.`;
}

/**
 * Root container for the income vs expense card. Owns the chart card
 * chrome (heading + 12 bulan terakhir hint) and delegates the SVG
 * body to the inner `IncomeExpenseChartSvg` so the card chrome can
 * stay a server component if we ever want to swap the loading state
 * out at the page level.
 */
export function IncomeExpenseChart({ data }: IncomeExpenseChartProps) {
  const isEmpty = isEmptySeries(data);
  const ariaLabel = buildAriaLabel(data);

  return (
    <section
      className="card flex h-full flex-col"
      aria-labelledby="dashboard-income-expense-heading"
      data-chart="income-expense"
      data-empty={isEmpty ? "true" : "false"}
    >
      <header className="flex items-center justify-between gap-3">
        <div>
          <h3
            id="dashboard-income-expense-heading"
            className="text-base font-semibold text-slate-900"
          >
            Pemasukan vs Pengeluaran
          </h3>
          <p className="mt-1 text-xs text-slate-500">12 bulan terakhir</p>
        </div>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[0.65rem] font-semibold uppercase tracking-wide text-slate-500">
          {data.length > 0 ? `${data.length} bulan` : "Kosong"}
        </span>
      </header>
      <div className="mt-6 flex-1">
        {isEmpty ? (
          <p
            className="flex h-full min-h-[12rem] items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-12 text-center text-xs text-slate-500"
            data-empty-message="income-expense"
          >
            Belum ada transaksi
          </p>
        ) : (
          <IncomeExpenseChartSvg data={data} ariaLabel={ariaLabel} />
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
function IncomeExpenseChartSvg({
  data,
  ariaLabel,
}: {
  data: DashboardIncomeExpenseTrendPoint[];
  ariaLabel: string;
}) {
  const [hoverIndex, setHoverIndex] = useState<HoverIndex>(null);

  const plotLeft = MARGIN.left;
  const plotRight = VIEWBOX_WIDTH - MARGIN.right;
  const plotTop = MARGIN.top;
  const plotBottom = VIEWBOX_HEIGHT - MARGIN.bottom;
  const plotHeight = plotBottom - plotTop;
  const yMax = computeYMax(data);
  const yTicks = evenlySpaced(0, yMax, Y_AXIS_TICK_COUNT);
  const layout = buildMonthLayout(data.length);
  const span = yMax === 0 ? 1 : yMax;

  return (
    <svg
      viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
      preserveAspectRatio="xMidYMid meet"
      className="h-56 w-full"
      role="img"
      aria-label={ariaLabel}
      data-chart-bars={data.length}
      data-chart-max={yMax}
    >
      {/* Legend */}
      <g
        data-legend="income-expense"
        aria-hidden="true"
      >
        <rect
          x={plotRight - 144}
          y={MARGIN.top - 32}
          width={12}
          height={12}
          rx={2}
          ry={2}
          className={INCOME_FILL_CLASS}
          fill={INCOME_FILL}
          data-legend-swatch="income"
        />
        <text
          x={plotRight - 128}
          y={MARGIN.top - 22}
          className="fill-slate-700 text-[0.7rem] font-medium"
        >
          Income
        </text>
        <rect
          x={plotRight - 76}
          y={MARGIN.top - 32}
          width={12}
          height={12}
          rx={2}
          ry={2}
          className={EXPENSE_FILL_CLASS}
          fill={EXPENSE_FILL}
          data-legend-swatch="expense"
        />
        <text
          x={plotRight - 60}
          y={MARGIN.top - 22}
          className="fill-slate-700 text-[0.7rem] font-medium"
        >
          Expense
        </text>
      </g>

      {/* Y-axis grid + tick labels */}
      <g aria-hidden="true">
        {yTicks.map((tick, index) => {
          const ratio = tick / span;
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

      {/* Bars + per-month labels */}
      <g>
        {data.map((point, index) => {
          const slotX = plotLeft + index * layout.slotWidth;
          const incomeX = slotX + layout.incomeOffsetX;
          const expenseX = slotX + layout.expenseOffsetX;
          const incomeHeight = (point.incomeCents / span) * plotHeight;
          const expenseHeight = (point.expenseCents / span) * plotHeight;
          const incomeY = plotBottom - incomeHeight;
          const expenseY = plotBottom - expenseHeight;
          const empty = isEmptyMonth(point);
          const isActive = hoverIndex === index;
          const monthLabel = formatMonthLabel(point.month);
          return (
            <g
              key={`bar-${index}`}
              data-bar-month={point.month}
              data-bar-index={index}
              data-bar-empty={empty ? "true" : "false"}
              data-bar-active={isActive ? "true" : "false"}
            >
              {empty ? (
                <text
                  x={slotX + layout.slotWidth / 2}
                  y={plotBottom - Math.max(layout.barWidth, 6) - 4}
                  textAnchor="middle"
                  className="fill-slate-400 text-[0.75rem] font-medium"
                  data-bar-stub={point.month}
                >
                  —
                </text>
              ) : null}
              {/* Income bar. Use SVG presentation attributes (not
                  Tailwind fill classes) so the empty stub branch
                  cleanly toggles fill↔stroke without CSS specificity
                  overriding the attribute. */}
              <rect
                x={incomeX}
                y={incomeY}
                width={layout.barWidth}
                height={Math.max(incomeHeight, 0)}
                rx={2}
                ry={2}
                fill={empty ? "none" : INCOME_FILL}
                stroke={empty ? EMPTY_STROKE : "none"}
                strokeWidth={empty ? 1 : 0}
                data-bar-income={empty ? "stub" : "filled"}
              />
              {/* Expense bar */}
              <rect
                x={expenseX}
                y={expenseY}
                width={layout.barWidth}
                height={Math.max(expenseHeight, 0)}
                rx={2}
                ry={2}
                fill={empty ? "none" : EXPENSE_FILL}
                stroke={empty ? EMPTY_STROKE : "none"}
                strokeWidth={empty ? 1 : 0}
                data-bar-expense={empty ? "stub" : "filled"}
              />
              {/* Invisible hit area covers the whole month slot so
                  taps land cleanly on mobile (SVG rects have no
                  padding). */}
              <rect
                x={slotX}
                y={plotTop}
                width={layout.slotWidth}
                height={plotHeight}
                fill="transparent"
                onMouseEnter={() => setHoverIndex(index)}
                onMouseLeave={() =>
                  setHoverIndex((current) => (current === index ? null : current))
                }
                onFocus={() => setHoverIndex(index)}
                onBlur={() =>
                  setHoverIndex((current) => (current === index ? null : current))
                }
                onClick={() =>
                  setHoverIndex((current) => (current === index ? null : index))
                }
                tabIndex={0}
                role="button"
                aria-label={`${monthLabel}: income ${formatIdrFromCents(point.incomeCents)}, expense ${formatIdrFromCents(point.expenseCents)}`}
              />
              {/* X-axis month label */}
              <text
                x={slotX + layout.slotWidth / 2}
                y={plotBottom + 18}
                textAnchor="middle"
                className="fill-slate-500 text-[0.7rem]"
              >
                {monthLabel}
              </text>
              {isActive ? (
                <Tooltip
                  month={point.month}
                  monthLabel={monthLabel}
                  incomeCents={point.incomeCents}
                  expenseCents={point.expenseCents}
                  anchorX={slotX + layout.slotWidth / 2}
                  anchorY={plotTop}
                />
              ) : null}
            </g>
          );
        })}
      </g>
    </svg>
  );
}

/**
 * Tooltip rendered as a `<g>` anchored above the hovered bar pair.
 * Positioned to the right of the slot centre when there's room,
 * otherwise flipped to the left, so the tooltip never gets clipped
 * at the chart edge. The background rectangle uses a slate-900 fill
 * so the coloured value text reads cleanly on both emerald and rose
 * stems.
 */
function Tooltip({
  month,
  monthLabel,
  incomeCents,
  expenseCents,
  anchorX,
  anchorY,
}: {
  month: string;
  monthLabel: string;
  incomeCents: number;
  expenseCents: number;
  anchorX: number;
  anchorY: number;
}) {
  const tooltipWidth = 170;
  const tooltipHeight = 60;
  const offset = 12;
  const plotRight = VIEWBOX_WIDTH - MARGIN.right;
  const plotLeft = MARGIN.left;
  const flipLeft = anchorX + offset + tooltipWidth > plotRight;
  const x = flipLeft
    ? Math.max(plotLeft, anchorX - offset - tooltipWidth)
    : anchorX + offset;
  const y = anchorY + 4;
  const incomeText = formatIdrFromCents(incomeCents);
  const expenseText = formatIdrFromCents(expenseCents);
  const valueX = x + 96;
  return (
    <g
      role="tooltip"
      aria-hidden="true"
      data-tooltip-month={month}
      data-tooltip-income={incomeText}
      data-tooltip-expense={expenseText}
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
        {monthLabel}
      </text>
      <text
        x={x + 12}
        y={y + 34}
        className="fill-emerald-300 text-[0.7rem] font-semibold"
      >
        Income
      </text>
      <text
        x={valueX}
        y={y + 34}
        textAnchor="end"
        className="fill-white text-[0.75rem] font-semibold tabular-nums"
      >
        {incomeText}
      </text>
      <text
        x={x + 12}
        y={y + 50}
        className="fill-rose-300 text-[0.7rem] font-semibold"
      >
        Expense
      </text>
      <text
        x={valueX}
        y={y + 50}
        textAnchor="end"
        className="fill-white text-[0.75rem] font-semibold tabular-nums"
      >
        {expenseText}
      </text>
    </g>
  );
}

// Pure helpers exported for the unit test (sub-0007-04 AC). The
// test pins the Y-domain fallback, the empty-state branching, the
// per-month layout geometry, and the SVG accessibility summary so a
// render regression is caught at the logic layer (the FE doesn't ship
// a Jest/Vitest runner — the env-var guard matches the sub-0007-02
// `idr.test.ts` pattern).
export {
  isEmptySeries,
  isEmptyMonth,
  formatMonthLabel,
  computeYMax,
  buildMonthLayout,
  buildAriaLabel,
  // re-exports so the test can assert the bare constants too
  EMPTY_FALLBACK_MAX_CENTS,
  Y_AXIS_PADDING_RATIO,
  Y_AXIS_TICK_COUNT,
  BAR_GAP_RATIO,
  MARGIN,
  VIEWBOX_WIDTH,
  VIEWBOX_HEIGHT,
};