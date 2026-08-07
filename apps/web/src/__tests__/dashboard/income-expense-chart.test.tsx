/**
 * sub-0007-04 — unit tests for the income vs expense chart helpers.
 *
 * The `apps/web` package does not currently ship a Jest/Vitest runner
 * (mirrors the convention used by sub-0005-03 / sub-0006-04 / sub-0007-02
 * / sub-0007-03). Until a runner lands, this file runs as a plain
 * Node test:
 *
 *   DASHBOARD_INCOME_EXPENSE_CHART_TEST_RUN=1 node --import tsx \
 *     apps/web/src/__tests__/dashboard/income-expense-chart.test.tsx
 *
 * The env-var guard matches the project convention (see
 * `goals/__tests__/progress-banner.test.tsx` for the reference shape)
 * so importing the module from other files doesn't auto-run the
 * assertions.
 *
 * Assertions cover the AC pinned in the sub-0007-04 issue body:
 *
 *   - `isEmptySeries` picks up arrays of length 0 and all-zero series
 *   - `isEmptyMonth` flags a single per-month all-zero entry
 *   - `computeYMax` honours the `Rp 100.000` ceiling on a flat-zero
 *     series and the 5% padding on a non-zero series (so the tallest
 *     bar never touches the chart frame)
 *   - `buildMonthLayout` splits each month slot into two bars + a
 *     fixed ratio gap, scaling to the plot width
 *   - `formatMonthLabel` formats `YYYY-MM` as `id-ID` short month +
 *     year (e.g. `Jan 2026`)
 *   - `buildAriaLabel` echoes the total income + expense when the
 *     series has any magnitude, and a "belum ada transaksi" fallback
 *     when it doesn't
 *
 * Every assertion below corresponds 1:1 to an `it(...)` case so the
 * file is portable to `describe` / `it` once a Jest config lands.
 */

import assert from "node:assert/strict";

import {
  BAR_GAP_RATIO,
  buildAriaLabel,
  buildMonthLayout,
  computeYMax,
  EMPTY_FALLBACK_MAX_CENTS,
  formatMonthLabel,
  isEmptyMonth,
  isEmptySeries,
  MARGIN,
  VIEWBOX_HEIGHT,
  VIEWBOX_WIDTH,
  Y_AXIS_PADDING_RATIO,
  Y_AXIS_TICK_COUNT,
} from "@/components/dashboard/charts/income-expense-chart";
import type { DashboardIncomeExpenseTrendPoint } from "@/lib/dashboard/types";

interface TestCase {
  name: string;
  run(): void;
}

const POSITIVE_SERIES: DashboardIncomeExpenseTrendPoint[] = Array.from(
  { length: 12 },
  (_, index) => ({
    month: `2025-${String(index + 2).padStart(2, "0")}`,
    incomeCents: 1_000_000_000 + index * 100_000_000,
    expenseCents: 600_000_000 + index * 50_000_000,
  }),
);

const NEGATIVE_DOMINANT_SERIES: DashboardIncomeExpenseTrendPoint[] =
  Array.from({ length: 12 }, (_, index) => ({
    month: `2025-${String(index + 2).padStart(2, "0")}`,
    incomeCents: 200_000_000,
    expenseCents: 800_000_000 + index * 100_000_000,
  }));

const FLAT_ZERO_SERIES: DashboardIncomeExpenseTrendPoint[] = Array.from(
  { length: 12 },
  (_, index) => ({
    month: `2025-${String(index + 2).padStart(2, "0")}`,
    incomeCents: 0,
    expenseCents: 0,
  }),
);

const PARTIAL_EMPTY_SERIES: DashboardIncomeExpenseTrendPoint[] = [
  { month: "2025-02", incomeCents: 1_000_000, expenseCents: 500_000 },
  { month: "2025-03", incomeCents: 0, expenseCents: 0 },
  { month: "2025-04", incomeCents: 1_500_000, expenseCents: 800_000 },
];

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
    name: "isEmptyMonth(all-zero entry) → true",
    run(): void {
      assert.equal(
        isEmptyMonth({ month: "2025-03", incomeCents: 0, expenseCents: 0 }),
        true,
      );
    },
  },
  {
    name: "isEmptyMonth(income > 0) → false",
    run(): void {
      assert.equal(
        isEmptyMonth({ month: "2025-03", incomeCents: 1, expenseCents: 0 }),
        false,
      );
    },
  },
  {
    name: "isEmptyMonth(expense > 0) → false",
    run(): void {
      assert.equal(
        isEmptyMonth({ month: "2025-03", incomeCents: 0, expenseCents: 1 }),
        false,
      );
    },
  },
  {
    name: "computeYMax([]) → EMPTY_FALLBACK_MAX_CENTS (Rp 100.000)",
    run(): void {
      assert.equal(computeYMax([]), EMPTY_FALLBACK_MAX_CENTS);
    },
  },
  {
    name: "computeYMax(all-zero) → EMPTY_FALLBACK_MAX_CENTS (Rp 100.000)",
    run(): void {
      assert.equal(computeYMax(FLAT_ZERO_SERIES), EMPTY_FALLBACK_MAX_CENTS);
    },
  },
  {
    name: "computeYMax(positive) → padded max income/expense",
    run(): void {
      const max = computeYMax(POSITIVE_SERIES);
      // POSITIVE_SERIES peaks at index 11: income 1.000.000.000 +
      // 11 × 100.000.000 = 2.100.000.000; expense 600.000.000 +
      // 11 × 50.000.000 = 1.150.000.000. The dominant peak is income.
      assert.equal(max, Math.round(2_100_000_000 * (1 + Y_AXIS_PADDING_RATIO)));
    },
  },
  {
    name: "computeYMax(negative-dominant) → padded expense max",
    run(): void {
      const max = computeYMax(NEGATIVE_DOMINANT_SERIES);
      // Expense peaks at index 11: 800.000.000 + 11 × 100.000.000 =
      // 1.900.000.000. The income is constant 200.000.000 so the
      // series max is the expense peak.
      assert.equal(max, Math.round(1_900_000_000 * (1 + Y_AXIS_PADDING_RATIO)));
    },
  },
  {
    name: "computeYMax(partial-empty) → padded max ignores all-zero months",
    run(): void {
      // PARTIAL_EMPTY_SERIES has an all-zero entry in the middle.
      // computeYMax must skip that month and still cap the domain at
      // the tallest non-zero bar (income 1.500.000 cents at index 2).
      const max = computeYMax(PARTIAL_EMPTY_SERIES);
      assert.equal(max, Math.round(1_500_000 * (1 + Y_AXIS_PADDING_RATIO)));
    },
  },
  {
    name: "isEmptySeries(partial-empty) → false (one non-zero month is enough)",
    run(): void {
      assert.equal(isEmptySeries(PARTIAL_EMPTY_SERIES), false);
    },
  },
  {
    name: "isEmptyMonth at index 1 of partial-empty series → true",
    run(): void {
      assert.equal(isEmptyMonth(PARTIAL_EMPTY_SERIES[1]), true);
    },
  },
  {
    name: "buildMonthLayout(12) → 12 slots sized to plot width",
    run(): void {
      const layout = buildMonthLayout(12);
      const expectedSlot =
        (VIEWBOX_WIDTH - MARGIN.left - MARGIN.right) / 12;
      assert.equal(layout.slotWidth, expectedSlot);
      assert.ok(layout.barWidth > 0);
      assert.ok(layout.expenseOffsetX > layout.incomeOffsetX);
    },
  },
  {
    name: "buildMonthLayout bars respect BAR_GAP_RATIO",
    run(): void {
      const layout = buildMonthLayout(12);
      // Two bars must consume `(1 - BAR_GAP_RATIO)` of each slot,
      // split evenly into the two bar widths.
      const expectedTotalBarWidth = layout.slotWidth * (1 - BAR_GAP_RATIO);
      assert.equal(
        layout.incomeOffsetX + layout.barWidth,
        layout.expenseOffsetX,
      );
      assert.ok(Math.abs(layout.barWidth * 2 - expectedTotalBarWidth) < 1e-9);
    },
  },
  {
    name: "buildMonthLayout(0) → zero-width slot",
    run(): void {
      const layout = buildMonthLayout(0);
      assert.equal(layout.slotWidth, 0);
      assert.equal(layout.barWidth, 0);
    },
  },
  {
    name: "formatMonthLabel('2025-02') → 'Feb 2025' (id-ID short)",
    run(): void {
      // The id-ID locale emits "Feb 2025" via Intl.DateTimeFormat;
      // older Node runtimes may emit slightly different casing but
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
    name: "buildAriaLabel(all-zero) → 'belum ada transaksi'",
    run(): void {
      assert.match(buildAriaLabel(FLAT_ZERO_SERIES), /belum ada transaksi/i);
    },
  },
  {
    name: "buildAriaLabel(mixed) → includes total income + expense",
    run(): void {
      const label = buildAriaLabel(POSITIVE_SERIES);
      // IDR formatter uses non-breaking space between `Rp` and the
      // value — normalize before asserting so the test stays portable.
      const normalized = label.replace(/\u00a0/g, " ");
      // Sum income for the 12-pt series: 12 × 1.000.000.000 + 100.000.000 × (0+1+…+11)
      const expectedIncome =
        12 * 1_000_000_000 + 100_000_000 * (11 * 12) / 2;
      const expectedExpense =
        12 * 600_000_000 + 50_000_000 * (11 * 12) / 2;
      const incomeText = new Intl.NumberFormat("id-ID", {
        style: "currency",
        currency: "IDR",
        maximumFractionDigits: 0,
      }).format(expectedIncome / 100);
      const expenseText = new Intl.NumberFormat("id-ID", {
        style: "currency",
        currency: "IDR",
        maximumFractionDigits: 0,
      }).format(expectedExpense / 100);
      const incomeNorm = incomeText.replace(/\u00a0/g, " ");
      const expenseNorm = expenseText.replace(/\u00a0/g, " ");
      assert.match(normalized, new RegExp(`total pemasukan ${incomeNorm}`));
      assert.match(normalized, new RegExp(`total pengeluaran ${expenseNorm}`));
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
  assert.equal(Y_AXIS_TICK_COUNT, 5);
  assert.equal(VIEWBOX_WIDTH, 800);
  assert.equal(VIEWBOX_HEIGHT, 400);
  if (failed > 0) {
    process.exit(1);
  }
}

if (
  process.env["DASHBOARD_INCOME_EXPENSE_CHART_TEST_RUN"] === "1"
) {
  runTests();
}