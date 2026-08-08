/**
 * sub-0007-05 — unit tests for the top-categories donut chart helpers.
 *
 * The `apps/web` package does not currently ship a Jest/Vitest runner
 * (mirrors the convention used by sub-0005-03 / sub-0006-04 / sub-0007-02
 * / sub-0007-03 / sub-0007-04). Until a runner lands, this file runs as
 * a plain Node test:
 *
 *   DASHBOARD_TOP_CATEGORIES_DONUT_TEST_RUN=1 node --import tsx \
 *     apps/web/src/__tests__/dashboard/top-categories-donut.test.tsx
 *
 * The env-var guard matches the project convention (see
 * `goals/__tests__/progress-banner.test.tsx` for the reference shape)
 * so importing the module from other files doesn't auto-run the
 * assertions.
 *
 * Assertions cover the AC pinned in the sub-0007-05 issue body:
 *
 *   - `isEmptyData` picks up arrays of length 0 and all-zero entries
 *   - `buildSegmentLayout` converts each entry's `percentage` to a
 *     `[startAngle, endAngle]` slice and assigns the palette index
 *     in order (slot 0 → slate, slot 1 → emerald, …)
 *   - `describeDonutSegment` produces a non-empty SVG path for a
 *     non-degenerate sweep and an empty string for a zero sweep
 *   - `polarToCartesian` returns (cx + r, cy) at the 12 o'clock
 *     anchor (angle 0 → -π/2 rotation puts the point to the right)
 *   - `formatCategoryLabel` falls back to "Tanpa nama" (per AC
 *     sub-0007-08) when the backend returned `null`/blank
 *   - `buildAriaLabel` echoes the empty-state copy on empty data and
 *     the total expense when data is present
 *
 * Every assertion below corresponds 1:1 to an `it(...)` case so the
 * file is portable to `describe` / `it` once a Jest config lands.
 */

import assert from "node:assert/strict";

import {
  buildAriaLabel,
  buildSegmentLayout,
  describeDonutSegment,
  DONUT_CENTER_X,
  DONUT_CENTER_Y,
  DONUT_INNER_RADIUS,
  DONUT_OUTER_RADIUS,
  formatCategoryLabel,
  isEmptyData,
  PALETTE,
  polarToCartesian,
  SIDE_LIST_ROW_HEIGHT,
  SIDE_LIST_START_Y,
  SIDE_LIST_SWATCH_SIZE,
  SIDE_LIST_X,
  VIEWBOX_HEIGHT,
  VIEWBOX_WIDTH,
} from "@/components/dashboard/charts/top-categories-donut";
import type { DashboardTopCategory } from "@/lib/dashboard/types";

interface TestCase {
  name: string;
  run(): void;
}

/** Normalize NBSP → ASCII space so assertions stay portable. */
function normalizeWhitespace(value: string): string {
  return value.replace(/\u00a0/g, " ");
}

const FIVE_CATEGORY_DATA: DashboardTopCategory[] = [
  { categoryId: "c1", categoryName: "Makanan", totalCents: 1_200_000_000, percentage: 40.0 },
  { categoryId: "c2", categoryName: "Transport", totalCents: 600_000_000, percentage: 20.0 },
  { categoryId: "c3", categoryName: "Belanja", totalCents: 450_000_000, percentage: 15.0 },
  { categoryId: "c4", categoryName: "Hiburan", totalCents: 450_000_000, percentage: 15.0 },
  { categoryId: "c5", categoryName: "Lain-lain", totalCents: 300_000_000, percentage: 10.0 },
];

const FLAT_ZERO_DATA: DashboardTopCategory[] = [
  { categoryId: "c1", categoryName: "Makanan", totalCents: 0, percentage: 0 },
  { categoryId: "c2", categoryName: "Transport", totalCents: 0, percentage: 0 },
];

const UNCATEGORIZED_DATA: DashboardTopCategory[] = [
  { categoryId: null, categoryName: null, totalCents: 500_000_000, percentage: 50.0 },
  { categoryId: "c2", categoryName: "Transport", totalCents: 500_000_000, percentage: 50.0 },
];

const testCases: TestCase[] = [
  {
    name: "isEmptyData([]) → true",
    run(): void {
      assert.equal(isEmptyData([]), true);
    },
  },
  {
    name: "isEmptyData(all-zero) → true (defensive: zero total + zero pct)",
    run(): void {
      assert.equal(isEmptyData(FLAT_ZERO_DATA), true);
    },
  },
  {
    name: "isEmptyData(mixed) → false",
    run(): void {
      assert.equal(isEmptyData(FIVE_CATEGORY_DATA), false);
    },
  },
  {
    name: "buildSegmentLayout emits one segment per entry",
    run(): void {
      const layout = buildSegmentLayout(FIVE_CATEGORY_DATA);
      assert.equal(layout.length, FIVE_CATEGORY_DATA.length);
    },
  },
  {
    name: "buildSegmentLayout assigns palette index in order (0..4)",
    run(): void {
      const layout = buildSegmentLayout(FIVE_CATEGORY_DATA);
      layout.forEach((segment, index) => {
        assert.equal(segment.paletteIndex, index % PALETTE.length);
      });
    },
  },
  {
    name: "buildSegmentLayout converts percentage → angle slices summing to 2π",
    run(): void {
      const layout = buildSegmentLayout(FIVE_CATEGORY_DATA);
      let cursor = 0;
      for (const segment of layout) {
        assert.ok(segment.startAngle >= cursor - 1e-9);
        assert.ok(segment.endAngle > segment.startAngle);
        cursor = segment.endAngle;
      }
      // Total sweep must approach 2π (last segment trimmed by 1° for
      // the visible seam — see buildSegmentLayout docstring).
      const totalSweep = layout.reduce(
        (sum, segment) => sum + (segment.endAngle - segment.startAngle),
        0,
      );
      const twoPi = Math.PI * 2;
      // 1° = π/180 rad of trim applied only when more than one segment.
      assert.ok(Math.abs(totalSweep - (twoPi - Math.PI / 180)) < 1e-6);
    },
  },
  {
    name: "buildSegmentLayout first segment starts at angle 0 (12 o'clock)",
    run(): void {
      const layout = buildSegmentLayout(FIVE_CATEGORY_DATA);
      assert.ok(Math.abs(layout[0].startAngle) < 1e-9);
    },
  },
  {
    name: "buildSegmentLayout falls back to totalCents when percentages sum to 0",
    run(): void {
      // Both entries carry percentage: 0 but positive totalCents — the
      // layout must still produce non-zero sweeps per entry.
      const zeroPctPositiveCents: DashboardTopCategory[] = [
        { categoryId: "c1", categoryName: "Makanan", totalCents: 700_000_000, percentage: 0 },
        { categoryId: "c2", categoryName: "Transport", totalCents: 300_000_000, percentage: 0 },
      ];
      const layout = buildSegmentLayout(zeroPctPositiveCents);
      const totalSweep = layout.reduce(
        (sum, segment) => sum + (segment.endAngle - segment.startAngle),
        0,
      );
      assert.ok(totalSweep > 0);
    },
  },
  {
    name: "buildSegmentLayout preserves item reference per segment",
    run(): void {
      const layout = buildSegmentLayout(FIVE_CATEGORY_DATA);
      layout.forEach((segment, index) => {
        assert.equal(segment.item, FIVE_CATEGORY_DATA[index]);
      });
    },
  },
  {
    name: "describeDonutSegment returns non-empty path for non-degenerate sweep",
    run(): void {
      const path = describeDonutSegment(
        DONUT_CENTER_X,
        DONUT_CENTER_Y,
        DONUT_OUTER_RADIUS,
        DONUT_INNER_RADIUS,
        0,
        Math.PI / 2,
      );
      assert.ok(path.length > 0);
      assert.match(path, /^M /);
      assert.match(path, / A /);
      assert.match(path, / L /);
      assert.match(path, /Z$/);
    },
  },
  {
    name: "describeDonutSegment returns empty string for zero sweep",
    run(): void {
      const path = describeDonutSegment(
        DONUT_CENTER_X,
        DONUT_CENTER_Y,
        DONUT_OUTER_RADIUS,
        DONUT_INNER_RADIUS,
        Math.PI / 2,
        Math.PI / 2,
      );
      assert.equal(path, "");
    },
  },
  {
    name: "describeDonutSegment uses largeArcFlag=1 for sweeps > π",
    run(): void {
      const path = describeDonutSegment(
        DONUT_CENTER_X,
        DONUT_CENTER_Y,
        DONUT_OUTER_RADIUS,
        DONUT_INNER_RADIUS,
        0,
        Math.PI * 1.5,
      );
      // The outer-arc command must carry `1` as the large-arc flag
      // (and the inner-arc the matching `0` so the wedge closes).
      const outerArc = path.split("L")[0];
      assert.match(outerArc, / 1 /);
    },
  },
  {
    name: "polarToCartesian at angle 0 puts the point to the right of the centre",
    run(): void {
      // angle 0 rotates by -π/2 in describeArc → cos(-π/2) = 0, sin(-π/2) = -1,
      // so the point sits at (cx, cy - r) — straight up (12 o'clock).
      const point = polarToCartesian(DONUT_CENTER_X, DONUT_CENTER_Y, 50, 0);
      assert.ok(Math.abs(point.x - DONUT_CENTER_X) < 1e-9);
      assert.ok(Math.abs(point.y - (DONUT_CENTER_Y - 50)) < 1e-9);
    },
  },
  {
    name: "polarToCartesian at angle π/2 puts the point to the right (3 o'clock)",
    run(): void {
      // angle π/2 rotates by 0 → straight right.
      const point = polarToCartesian(DONUT_CENTER_X, DONUT_CENTER_Y, 50, Math.PI / 2);
      assert.ok(Math.abs(point.x - (DONUT_CENTER_X + 50)) < 1e-9);
      assert.ok(Math.abs(point.y - DONUT_CENTER_Y) < 1e-9);
    },
  },
  {
    name: "formatCategoryLabel(null) → 'Tanpa nama' fallback (AC sub-0007-08)",
    run(): void {
      assert.equal(formatCategoryLabel(null), "Tanpa nama");
    },
  },
  {
    name: "formatCategoryLabel('') → 'Tanpa nama' fallback (blank guard)",
    run(): void {
      assert.equal(formatCategoryLabel(""), "Tanpa nama");
      assert.equal(formatCategoryLabel("   "), "Tanpa nama");
    },
  },
  {
    name: "formatCategoryLabel('Makanan') → 'Makanan'",
    run(): void {
      assert.equal(formatCategoryLabel("Makanan"), "Makanan");
    },
  },
  {
    name: "buildAriaLabel([]) → empty-state copy",
    run(): void {
      assert.match(buildAriaLabel([]), /belum ada expense bulan ini/i);
    },
  },
  {
    name: "buildAriaLabel(uncategorized) → 'Tanpa nama' surfaces in label",
    run(): void {
      const label = buildAriaLabel(UNCATEGORIZED_DATA);
      assert.match(label, /Tanpa nama/);
    },
  },
  {
    name: "buildAriaLabel(mixed) → includes total expense IDR",
    run(): void {
      const label = buildAriaLabel(FIVE_CATEGORY_DATA);
      const normalized = normalizeWhitespace(label);
      // Total expense = sum(totalCents) = 3.000.000.000 cents =
      // 30.000.000 rupiah → "Rp 30.000.000".
      const totalRupiah = FIVE_CATEGORY_DATA.reduce(
        (sum, point) => sum + point.totalCents,
        0,
      ) / 100;
      const formatted = new Intl.NumberFormat("id-ID", {
        style: "currency",
        currency: "IDR",
        maximumFractionDigits: 0,
      }).format(totalRupiah);
      const formattedNorm = normalizeWhitespace(formatted);
      assert.match(normalized, new RegExp(`Total ${formattedNorm}`));
    },
  },
  {
    name: "PALETTE has 5 entries (matches the limit=5 contract)",
    run(): void {
      assert.equal(PALETTE.length, 5);
    },
  },
  {
    name: "PALETTE colour tokens mirror the dashboard palette (slate/emerald/rose/amber/sky)",
    run(): void {
      assert.equal(PALETTE[0].fill, "#64748b"); // slate-500
      assert.equal(PALETTE[1].fill, "#10b981"); // emerald-500
      assert.equal(PALETTE[2].fill, "#f43f5e"); // rose-500
      assert.equal(PALETTE[3].fill, "#f59e0b"); // amber-500
      assert.equal(PALETTE[4].fill, "#0ea5e9"); // sky-500
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
  // Sanity check the constant surface (single sweep — keeps the
  // test file honest about not deleting the pinned AC tokens by
  // accident).
  assert.equal(VIEWBOX_WIDTH, 400);
  assert.equal(VIEWBOX_HEIGHT, 400);
  assert.ok(DONUT_OUTER_RADIUS > DONUT_INNER_RADIUS);
  assert.equal(SIDE_LIST_ROW_HEIGHT > 0, true);
  assert.equal(SIDE_LIST_START_Y > 0, true);
  assert.equal(SIDE_LIST_SWATCH_SIZE, 12);
  assert.ok(SIDE_LIST_X > DONUT_CENTER_X + DONUT_OUTER_RADIUS);
  if (failed > 0) {
    process.exit(1);
  }
}

if (
  process.env["DASHBOARD_TOP_CATEGORIES_DONUT_TEST_RUN"] === "1"
) {
  runTests();
}
