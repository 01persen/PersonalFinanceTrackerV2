"use client";

import { formatIdrFromCents } from "@/lib/dashboard/idr";
import type { DashboardTopCategory } from "@/lib/dashboard/types";

/**
 * Hand-rolled SVG donut chart for the dashboard top-5 expense
 * categories (sub-0007-05). Renders up to 5 arc segments inside a
 * fixed `400×400` viewBox alongside a side list that mirrors each
 * category with its colour swatch, name, percentage, and IDR total.
 *
 * Why hand-rolled (per Tech Leader decision, tracked in the tracker
 * as v6.3): the SOP ruled out adding `recharts` / `nivo` / `chart.js`
 * so the FE keeps zero new chart dependencies. The donut only needs
 * 5 `<path>` arc segments + a 5-row side list + a centre label —
 * well within the ~180 LOC budget for this sub-task. SVG scales
 * cleanly to the mobile 390×844 viewport (the chart's `viewBox` +
 * `preserveAspectRatio` handle responsiveness without any JS) and
 * remains accessible because the root carries a single `role="img"`
 * + descriptive `aria-label`.
 */

interface TopCategoriesDonutProps {
  /**
   * Up-to-five top expense categories for the requested month from
   * `GET /dashboard/top-categories?limit=5&month=YYYY-MM`. The
   * component mirrors the backend contract: `totalCents` is a
   * non-negative integer in minor units (1/100 rupiah), `percentage`
   * is a pre-computed 0..100 float, and `categoryName` may be `null`
   * for uncategorized expense — the donut renders that bucket as
   * "Tanpa nama" (per AC sub-0007-08) so the slot still has a
   * readable label, and the parent surfaces a non-blocking
   * `<LookupWarning>` + `<Toast>` so the user knows the real category
   * name is missing.
   */
  data: DashboardTopCategory[];
}

/**
 * ViewBox dimensions. 400×400 keeps the donut + side list readable
 * on the desktop dashboard slot and scales cleanly to the mobile
 * 390×844 viewport via `preserveAspectRatio="xMidYMid meet"`. The
 * `MARGIN` constants below assume this box.
 */
const VIEWBOX_WIDTH = 400;
const VIEWBOX_HEIGHT = 400;

/**
 * Plot layout in viewBox units. The donut sits on the left half so
 * the side list can sit on the right half without overlapping. The
 * `cx` is offset from the centre so the donut + side list together
 * visually balance inside the 400×400 frame.
 */
const DONUT_CENTER_X = 130;
const DONUT_CENTER_Y = 200;
const DONUT_OUTER_RADIUS = 110;
const DONUT_INNER_RADIUS = 60;

/**
 * Side list geometry. Five evenly-spaced rows starting just above
 * the donut centre and extending downward; the row height + vertical
 * padding add up to ~250 viewBox units so the list is vertically
 * centred against the donut.
 */
const SIDE_LIST_X = 260;
const SIDE_LIST_ROW_HEIGHT = 54;
const SIDE_LIST_START_Y = 75;
const SIDE_LIST_SWATCH_SIZE = 12;

/**
 * Donut segment colour palette. Five distinct hues mirror the
 * dashboard's existing token set (used by `goal-progress-bar.tsx`
 * sub-0005-03 + `income-expense-chart.tsx` sub-0007-04) so the
 * donut reads as part of the same surface. Both the SVG `fill`
 * attribute and a Tailwind class are written per segment so the
 * colour survives if Tailwind is ever swapped in `tailwind.config.ts`.
 */
const PALETTE: readonly { fill: string; className: string }[] = [
  { fill: "#64748b", className: "fill-slate-500" }, // slate-500
  { fill: "#10b981", className: "fill-emerald-500" }, // emerald-500
  { fill: "#f43f5e", className: "fill-rose-500" }, // rose-500
  { fill: "#f59e0b", className: "fill-amber-500" }, // amber-500
  { fill: "#0ea5e9", className: "fill-sky-500" }, // sky-500
] as const;

/**
 * Convert an angle (radians, 0 = top, clockwise) into a 2D point on
 * a circle. We rotate by `-π/2` so the donut's first segment starts
 * at 12 o'clock instead of the SVG-native 3 o'clock position.
 */
function polarToCartesian(
  cx: number,
  cy: number,
  radius: number,
  angleRadians: number,
): { x: number; y: number } {
  return {
    x: cx + radius * Math.cos(angleRadians - Math.PI / 2),
    y: cy + radius * Math.sin(angleRadians - Math.PI / 2),
  };
}

/**
 * Build the SVG path string for a donut segment that spans
 * `[startAngle, endAngle]` (radians, clockwise from 12 o'clock) on a
 * ring with the supplied outer + inner radii. Returns a single
 * `<path d="...">` value that closes back to the start point so the
 * segment reads as a solid wedge.
 */
function describeDonutSegment(
  cx: number,
  cy: number,
  outerRadius: number,
  innerRadius: number,
  startAngle: number,
  endAngle: number,
): string {
  const sweep = Math.max(endAngle - startAngle, 0);
  // A 0° or full-circle sweep would yield a degenerate arc. The
  // caller never feeds that in (a single segment with 100% sweeps
  // 2π − ε), but guard anyway so the path stays valid.
  if (sweep <= 0) return "";
  const largeArcFlag = sweep > Math.PI ? 1 : 0;
  const outerStart = polarToCartesian(cx, cy, outerRadius, startAngle);
  const outerEnd = polarToCartesian(cx, cy, outerRadius, endAngle);
  const innerEnd = polarToCartesian(cx, cy, innerRadius, endAngle);
  const innerStart = polarToCartesian(cx, cy, innerRadius, startAngle);
  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArcFlag} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerEnd.x} ${innerEnd.y}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArcFlag} 0 ${innerStart.x} ${innerStart.y}`,
    "Z",
  ].join(" ");
}

/**
 * Compute the start + end angle (radians, clockwise from 12 o'clock)
 * for each donut segment based on the backend-supplied `percentage`.
 * A full-circle series would have the last segment collide with the
 * first; we trim the final sweep by a 1° margin so the seam stays
 * visually open. The trim is small enough that the segment still
 * reads as "the rest" on screen.
 */
function buildSegmentLayout(data: DashboardTopCategory[]): {
  startAngle: number;
  endAngle: number;
  item: DashboardTopCategory;
  paletteIndex: number;
}[] {
  const layout: {
    startAngle: number;
    endAngle: number;
    item: DashboardTopCategory;
    paletteIndex: number;
  }[] = [];
  let cursor = 0;
  const total = data.reduce((sum, point) => sum + Math.max(point.percentage, 0), 0);
  // If the BE returned all-zero percentages (defensive — the BE clamps
  // to 0..100 but a malformed payload could still slip through), fall
  // back to `totalCents` so each segment still gets a relative share.
  const fallbackTotal = data.reduce(
    (sum, point) => sum + Math.max(point.totalCents, 0),
    0,
  );
  data.forEach((item, index) => {
    let share: number;
    if (total > 0) {
      share = Math.max(item.percentage, 0) / total;
    } else if (fallbackTotal > 0) {
      share = Math.max(item.totalCents, 0) / fallbackTotal;
    } else {
      share = 0;
    }
    const sweep = share * Math.PI * 2;
    const startAngle = cursor;
    const endAngle = cursor + sweep;
    layout.push({
      startAngle,
      endAngle,
      item,
      paletteIndex: index % PALETTE.length,
    });
    cursor = endAngle;
  });
  if (layout.length > 0) {
    const last = layout[layout.length - 1];
    // Trim a tiny seam so the join between the last and first segment
    // stays visible even when the data sums to exactly 100%.
    last.endAngle = Math.max(last.startAngle, last.endAngle - Math.PI / 180);
  }
  return layout;
}

/**
 * Render label for a category. The backend may return `categoryName`
 * as `null` for the uncategorized bucket — we surface that as the
 * conventional "Tanpa nama" string so the donut still has a readable
 * row instead of a blank slot. AC sub-0007-08 pins the exact copy.
 */
function formatCategoryLabel(name: string | null): string {
  if (!name || name.trim().length === 0) return "Tanpa nama";
  return name;
}

/**
 * Accessible summary label for the donut. Mirrors the SOP shape:
 * "Top 5 kategori expense: <list>" with the IDR total. When the
 * series is empty the label collapses to the empty-state copy so a
 * screen-reader user doesn't hear a misleading "Rp 0".
 */
function buildAriaLabel(data: DashboardTopCategory[]): string {
  if (data.length === 0) {
    return "Top 5 kategori expense: belum ada expense bulan ini.";
  }
  const total = data.reduce((sum, point) => sum + point.totalCents, 0);
  const names = data
    .map((point) => `${formatCategoryLabel(point.categoryName)} ${point.percentage.toFixed(1)}%`)
    .join(", ");
  return `Top 5 kategori expense: ${names}. Total ${formatIdrFromCents(total)}.`;
}

/**
 * `true` iff the supplied series has no rendering-meaningful data —
 * an empty array OR every entry carries zero total + zero percentage.
 * The empty-state copy ("Belum ada expense bulan ini") is rendered
 * in that case so the user sees a guided message instead of a blank
 * donut.
 */
function isEmptyData(data: DashboardTopCategory[]): boolean {
  if (data.length === 0) return true;
  return data.every(
    (point) => point.totalCents === 0 && point.percentage === 0,
  );
}

/**
 * Root container for the top-categories donut card. Owns the card
 * chrome (heading + "Bulan ini" hint) and delegates the SVG body to
 * the inner `TopCategoriesDonutSvg` so the card chrome stays a
 * thin server component while the SVG stays a pure function of the
 * supplied data.
 */
export function TopCategoriesDonut({ data }: TopCategoriesDonutProps) {
  const isEmpty = isEmptyData(data);
  const ariaLabel = buildAriaLabel(data);
  const totalCents = data.reduce((sum, point) => sum + point.totalCents, 0);
  const headingId = "dashboard-top-categories-heading";

  return (
    <section
      className="card flex h-full flex-col"
      aria-labelledby={headingId}
      data-chart="top-categories-donut"
      data-empty={isEmpty ? "true" : "false"}
    >
      <header className="flex items-center justify-between gap-3">
        <div>
          <h3
            id={headingId}
            className="text-base font-semibold text-slate-900"
          >
            Kategori Pengeluaran Teratas
          </h3>
          <p className="mt-1 text-xs text-slate-500">Bulan ini</p>
        </div>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[0.65rem] font-semibold uppercase tracking-wide text-slate-500">
          {data.length > 0 ? `Top ${data.length}` : "Kosong"}
        </span>
      </header>
      <div className="mt-6 flex-1">
        {isEmpty ? (
          <p
            className="flex h-full min-h-[16rem] items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-12 text-center text-xs text-slate-500"
            data-empty-message="top-categories"
          >
            Belum ada expense bulan ini
          </p>
        ) : (
          <TopCategoriesDonutSvg
            data={data}
            ariaLabel={ariaLabel}
            totalCents={totalCents}
          />
        )}
      </div>
    </section>
  );
}

/**
 * Pure SVG body of the donut. Kept as a plain function (no client
 * state) because the chart only needs to render the supplied data —
 * there is no hover/tap interaction to lift into a `use client`
 * component (matches the static side of the income/expense chart).
 */
function TopCategoriesDonutSvg({
  data,
  ariaLabel,
  totalCents,
}: {
  data: DashboardTopCategory[];
  ariaLabel: string;
  totalCents: number;
}) {
  const segments = buildSegmentLayout(data);
  const totalLabel = formatIdrFromCents(totalCents);

  return (
    <svg
      viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
      preserveAspectRatio="xMidYMid meet"
      className="h-64 w-full"
      role="img"
      aria-label={ariaLabel}
      data-donut-segments={data.length}
    >
      {/* Donut segments. The path is built by hand so the chart stays
          dependency-free — no `recharts` / `d3-shape`. The fill is set
          on each <path> directly because the segment is a single solid
          wedge (no Tailwind fill utility would be more concise). */}
      <g data-donut-rings>
        {segments.map((segment, index) => {
          const path = describeDonutSegment(
            DONUT_CENTER_X,
            DONUT_CENTER_Y,
            DONUT_OUTER_RADIUS,
            DONUT_INNER_RADIUS,
            segment.startAngle,
            segment.endAngle,
          );
          const palette = PALETTE[segment.paletteIndex];
          return (
            <path
              key={`donut-${index}`}
              d={path}
              className={palette.className}
              fill={palette.fill}
              data-segment-index={index}
              data-segment-name={formatCategoryLabel(segment.item.categoryName)}
              data-segment-percentage={segment.item.percentage.toFixed(2)}
            />
          );
        })}
      </g>

      {/* Donut centre: total expense for the month. Two stacked text
          lines keep the centre readable — the IDR amount is the
          primary read, the "Total" hint sits above as the supporting
          label. */}
      <g data-donut-center aria-hidden="true">
        <text
          x={DONUT_CENTER_X}
          y={DONUT_CENTER_Y - 6}
          textAnchor="middle"
          className="fill-slate-500 text-[0.7rem] font-medium uppercase tracking-wide"
        >
          Total
        </text>
        <text
          x={DONUT_CENTER_X}
          y={DONUT_CENTER_Y + 16}
          textAnchor="middle"
          className="fill-slate-900 text-[0.95rem] font-semibold tabular-nums"
        >
          {totalLabel}
        </text>
      </g>

      {/* Side list. Each row carries a colour swatch + category name
          + percentage + IDR total so the user can read the donut
          without relying on the arc segments alone (the side list is
          also the primary read on mobile when the arcs become very
          thin). */}
      <g data-donut-side-list aria-hidden="true">
        {data.map((point, index) => {
          const palette = PALETTE[index % PALETTE.length];
          const y = SIDE_LIST_START_Y + index * SIDE_LIST_ROW_HEIGHT;
          const label = formatCategoryLabel(point.categoryName);
          const idrText = formatIdrFromCents(point.totalCents);
          return (
            <g
              key={`row-${index}`}
              data-row-index={index}
              data-row-empty="false"
            >
              <rect
                x={SIDE_LIST_X}
                y={y}
                width={SIDE_LIST_SWATCH_SIZE}
                height={SIDE_LIST_SWATCH_SIZE}
                rx={2}
                ry={2}
                className={palette.className}
                fill={palette.fill}
                data-row-swatch={index}
              />
              <text
                x={SIDE_LIST_X + SIDE_LIST_SWATCH_SIZE + 8}
                y={y + SIDE_LIST_SWATCH_SIZE - 1}
                className="fill-slate-700 text-[0.75rem] font-medium"
              >
                {label}
              </text>
              <text
                x={SIDE_LIST_X + SIDE_LIST_SWATCH_SIZE + 8}
                y={y + SIDE_LIST_SWATCH_SIZE + 14}
                className="fill-slate-500 text-[0.65rem]"
              >
                {`${point.percentage.toFixed(1)}% · ${idrText}`}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

// Pure helpers exported for the unit test (sub-0007-05 AC). The
// test pins the donut segment geometry, the empty-state branching,
// the percentage → angle conversion, and the SVG accessibility
// summary so a render regression is caught at the logic layer (the
// FE doesn't ship a Jest/Vitest runner — the env-var guard matches
// the sub-0007-02 `idr.test.ts` pattern).
export {
  buildSegmentLayout,
  buildAriaLabel,
  describeDonutSegment,
  formatCategoryLabel,
  isEmptyData,
  polarToCartesian,
  // re-exports so the test can assert the bare constants too
  DONUT_CENTER_X,
  DONUT_CENTER_Y,
  DONUT_INNER_RADIUS,
  DONUT_OUTER_RADIUS,
  PALETTE,
  SIDE_LIST_ROW_HEIGHT,
  SIDE_LIST_START_Y,
  SIDE_LIST_SWATCH_SIZE,
  SIDE_LIST_X,
  VIEWBOX_HEIGHT,
  VIEWBOX_WIDTH,
};
