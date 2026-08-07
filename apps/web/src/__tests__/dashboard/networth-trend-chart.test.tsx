/**
 * sub-0007-03 — unit tests for the networth trend chart helpers.
 *
 * The `apps/web` package does not currently ship a Jest/Vitest runner
 * (mirrors the convention used by sub-0005-03 / sub-0006-04 / sub-0007-02).
 * Until a runner lands, this file runs as a plain Node test:
 *
 *   DASHBOARD_NETWORTH_TREND_CHART_TEST_RUN=1 node --import tsx \
 *     apps/web/src/__tests__/dashboard/networth-trend-chart.test.tsx
 *
 * The env-var guard matches the project convention (see
 * `goals/__tests__/progress-banner.test.tsx` for the reference shape)
 * so importing the module from other files doesn't auto-run the
 * assertions.
 *
 * Assertions cover the AC pinned in the sub-0007-03 issue body:
 *
 *   - `isEmptySeries` picks up arrays of length 0 and all-zero series
 *   - `computeYDomain` honours the ±Rp 1.000 fallback on a flat-zero
 *     series and the 5% padding on a non-zero series
 *   - `classifyTrend` returns "positive" when last >= first, else
 *     "negative" (the color drives the SVG stroke)
 *   - `buildLinePath` produces a `M ... L ...` path so the line is
 *     stable across React re-renders
 *   - `formatMonthLabel` formats `YYYY-MM` as `id-ID` short month +
 *     year (e.g. `Jan 2026`)
 *   - `buildAriaLabel` includes the highest/lowest IDR values when
 *     the series has any magnitude
 *
 * Every assertion below corresponds 1:1 to an `it(...)` case so the
 * file is portable to `describe` / `it` once a Jest config lands.
 */

import assert from "node:assert/strict";

import {
  buildAriaLabel,
  buildLinePath,
  buildProjectedPoints,
  classifyTrend,
  computeYDomain,
  formatMonthLabel,
  isEmptySeries,
} from "@/components/dashboard/charts/networth-trend-chart";
import type { DashboardNetworthTrendPoint } from "@/lib/dashboard/types";

interface TestCase {
  name: string;
  run(): void;
}

const POSITIVE_SERIES: DashboardNetworthTrendPoint[] = [
  { month: "2025-02", networthCents: 1_000_000_000 },
  { month: "2025-03", networthCents: 1_200_000_000 },
  { month: "2025-04", networthCents: 1_400_000_000 },
  { month: "2025-05", networthCents: 1_600_000_000 },
  { month: "2025-06", networthCents: 1_800_000_000 },
  { month: "2025-07", networthCents: 2_000_000_000 },
  { month: "2025-08", networthCents: 2_200_000_000 },
  { month: "2025-09", networthCents: 2_400_000_000 },
  { month: "2025-10", networthCents: 2_600_000_000 },
  { month: "2025-11", networthCents: 2_800_000_000 },
  { month: "2025-12", networthCents: 3_000_000_000 },
  { month: "2026-01", networthCents: 3_200_000_000 },
];

const NEGATIVE_SERIES: DashboardNetworthTrendPoint[] = [
  { month: "2025-02", networthCents: 5_000_000_000 },
  { month: "2025-03", networthCents: 4_500_000_000 },
  { month: "2025-04", networthCents: 4_000_000_000 },
  { month: "2025-05", networthCents: 3_500_000_000 },
  { month: "2025-06", networthCents: 3_000_000_000 },
  { month: "2025-07", networthCents: 2_500_000_000 },
  { month: "2025-08", networthCents: 2_000_000_000 },
  { month: "2025-09", networthCents: 1_500_000_000 },
  { month: "2025-10", networthCents: 1_000_000_000 },
  { month: "2025-11", networthCents: 500_000_000 },
  { month: "2025-12", networthCents: 0 },
  { month: "2026-01", networthCents: -500_000_000 },
];

const FLAT_ZERO_SERIES: DashboardNetworthTrendPoint[] = Array.from(
  { length: 12 },
  (_, index) => ({
    month: `2025-${String(index + 1).padStart(2, "0")}`,
    networthCents: 0,
  }),
);

const testCases: TestCase[] = [
  {
    name: "isEmptySeries([]) → true",
    run(): void {
      assert.equal(isEmptySeries([]), true);
    },
  },
  {
    name: "isEmptySeries(all-zero) → true (brand-new user)",
    run(): void {
      assert.equal(isEmptySeries(FLAT_ZERO_SERIES), true);
    },
  },
  {
    name: "isEmptySeries(mixed) → false",
    run(): void {
      assert.equal(isEmptySeries(POSITIVE_SERIES), false);
    },
  },
  {
    name: "computeYDomain(all-zero) → ±Rp 1.000 fallback",
    run(): void {
      const { yMin, yMax } = computeYDomain(FLAT_ZERO_SERIES);
      assert.equal(yMin, -100_000);
      assert.equal(yMax, 100_000);
    },
  },
  {
    name: "computeYDomain(positive) → padded [0, max]",
    run(): void {
      const { yMin, yMax } = computeYDomain(POSITIVE_SERIES);
      // Min must include 0 (whole positive series) and stay below the
      // smallest data value so the line doesn't sit on the frame.
      assert.ok(yMin < 0, `yMin=${yMin} should be < 0`);
      assert.ok(yMax > 3_200_000_000, `yMax=${yMax} should exceed max data`);
    },
  },
  {
    name: "computeYDomain(negative tail) → padded [min, 0]",
    run(): void {
      const { yMin, yMax } = computeYDomain(NEGATIVE_SERIES);
      // Max must include 0 (series crosses zero) and stay above the
      // largest data value so the line doesn't sit on the frame.
      assert.ok(yMin < -500_000_000, `yMin=${yMin} should be < data min`);
      assert.ok(yMax > 0, `yMax=${yMax} should be > 0`);
    },
  },
  {
    name: "classifyTrend(positive) → 'positive'",
    run(): void {
      assert.equal(classifyTrend(POSITIVE_SERIES), "positive");
    },
  },
  {
    name: "classifyTrend(negative) → 'negative'",
    run(): void {
      assert.equal(classifyTrend(NEGATIVE_SERIES), "negative");
    },
  },
  {
    name: "classifyTrend(flat) → 'positive' (neutral defaults green)",
    run(): void {
      const flat: DashboardNetworthTrendPoint[] = [
        { month: "2025-02", networthCents: 1_000_000_000 },
        { month: "2026-01", networthCents: 1_000_000_000 },
      ];
      assert.equal(classifyTrend(flat), "positive");
    },
  },
  {
    name: "buildLinePath([]) → ''",
    run(): void {
      assert.equal(buildLinePath([]), "");
    },
  },
  {
    name: "buildLinePath(3 points) → 'M x0 y0 L x1 y1 L x2 y2'",
    run(): void {
      const path = buildLinePath([
        { x: 10, y: 20 },
        { x: 30, y: 40 },
        { x: 50, y: 60 },
      ]);
      assert.equal(path, "M 10.00 20.00 L 30.00 40.00 L 50.00 60.00");
    },
  },
  {
    name: "buildProjectedPoints(12-pt series) → 12 points spanning plot width",
    run(): void {
      const points = buildProjectedPoints(POSITIVE_SERIES, 0, 3_200_000_000);
      assert.equal(points.length, 12);
      const xStart = points[0].x;
      const xEnd = points[11].x;
      assert.ok(xEnd > xStart, "x positions should increase left-to-right");
      // SVG `y` grows downward, so a higher networth value projects
      // to a SMALLER y (closer to the top of the chart). The positive
      // series is monotonic, so the first point's y must be GREATER
      // than the last point's y — the line visually rises.
      assert.ok(
        points[0].y > points[11].y,
        `positive trend: first point should sit lower on screen. Got points[0].y=${points[0].y}, points[11].y=${points[11].y}`,
      );
    },
  },
  {
    name: "formatMonthLabel('2025-02') → 'Feb 2025' (id-ID short)",
    run(): void {
      // The id-ID locale emits "Feb 2025" via Intl.DateTimeFormat;
      // older Node runtimes may emit a slightly different casing but
      // the month token + year pair stays stable.
      const label = formatMonthLabel("2025-02");
      assert.match(label, /Feb 2025/i, `unexpected label: ${label}`);
    },
  },
  {
    name: "formatMonthLabel('not-a-date') → raw string fallback",
    run(): void {
      assert.equal(formatMonthLabel("not-a-date"), "not-a-date");
    },
  },
  {
    name: "buildAriaLabel([]) → 'belum ada data'",
    run(): void {
      assert.match(buildAriaLabel([]), /belum ada data/i);
    },
  },
  {
    name: "buildAriaLabel(positive) → includes highest + lowest IDR",
    run(): void {
      const label = buildAriaLabel(POSITIVE_SERIES);
      // IDR formatter uses non-breaking space between `Rp` and the
      // value — normalize before asserting so the test stays portable.
      const normalized = label.replace(/\u00a0/g, " ");
      assert.match(normalized, /tertinggi Rp 32\.000\.000/);
      assert.match(normalized, /terendah Rp 10\.000\.000/);
    },
  },
];

function runTests(): void {
  let passed = 0;
  let failed = 0;
  for (const test of testCases) {
    try {
      test.run();
      passed += 1;
      console.log(`  ✓ ${test.name}`);
    } catch (error) {
      failed += 1;
      console.error(`  ✗ ${test.name}`);
      console.error(`    ${(error as Error).message}`);
    }
  }
  console.log(`\n${passed}/${testCases.length} passed (${failed} failed).`);
  if (failed > 0) {
    process.exit(1);
  }
}

if (process.env.DASHBOARD_NETWORTH_TREND_CHART_TEST_RUN === "1") {
  runTests();
}
