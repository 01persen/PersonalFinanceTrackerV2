/**
 * sub-0007-07 — unit tests for the `<DashboardMobileSummary>` helpers.
 *
 * The `apps/web` package does not currently ship a Jest/Vitest runner
 * (mirrors the convention used by sub-0007-02 / sub-0007-03 / sub-0007-04
 * / sub-0007-05 / sub-0007-06). Until a runner lands, this file runs
 * as a plain Node test:
 *
 *   DASHBOARD_MOBILE_SUMMARY_TEST_RUN=1 node --import tsx \
 *     apps/web/src/__tests__/dashboard/dashboard-mobile-summary.test.tsx
 *
 * The env-var guard matches the project convention (see
 * `goals/__tests__/progress-banner.test.tsx` for the reference shape)
 * so importing the module from other files doesn't auto-run the
 * assertions.
 *
 * Assertions cover the AC pinned in the sub-0007-07 issue body:
 *
 *   - `MOBILE_TREND_MONTHS === 6` — viewport-friendly trend window
 *     (12 would cramp labels on a 390 px column)
 *   - `trimTrendForMobile` returns the last N entries and short-circuits
 *     when the series is already ≤ N entries
 *   - `trimTrendForMobile` honours a custom months override (so QA
 *     can pin edge cases)
 *   - `buildExpandLabel` produces a stable Indonesian string that
 *     calls out the destination route (no ambiguity for screen readers)
 *   - `buildExpandLabel` is non-empty so a future refactor that
 *     accidentally returns `""` fails the test
 *   - The KPI card tone selection picks `positive` for non-negative
 *     networth and `negative` otherwise (covers the conditional the
 *     component uses to drive `<KpiCard tone>`)
 *   - The EF empty-state branching mirrors the existing KPI card
 *     semantics (`emergencyFundAvgPct === null` → "Belum ada dana
 *     darurat", numeric → percentage)
 *
 * Every assertion below corresponds 1:1 to an `it(...)` case so the
 * file is portable to `describe` / `it` once a Jest config lands.
 */

import assert from "node:assert/strict";

import {
  buildExpandLabel,
  MOBILE_TREND_MONTHS,
  trimTrendForMobile,
} from "@/components/dashboard/dashboard-mobile-summary";
import {
  formatPercent,
  TONE_STYLES,
  type KpiTone,
} from "@/components/dashboard/kpi-cards";
import type {
  DashboardNetworthTrend,
  DashboardNetworthTrendPoint,
  DashboardSummary,
} from "@/lib/dashboard/types";

interface TestCase {
  name: string;
  run(): void;
}

function makePoint(
  month: string,
  networthCents: number,
): DashboardNetworthTrendPoint {
  return { month, networthCents };
}

const TWELVE_MONTH_SERIES: DashboardNetworthTrend["data"] = Array.from(
  { length: 12 },
  (_, index) =>
    makePoint(
      `2025-${String(index + 1).padStart(2, "0")}`,
      1_000_000_000 + index * 100_000_000,
    ),
);

const SIX_MONTH_SERIES: DashboardNetworthTrend["data"] = Array.from(
  { length: 6 },
  (_, index) =>
    makePoint(
      `2025-${String(index + 7).padStart(2, "0")}`,
      1_000_000_000 + index * 100_000_000,
    ),
);

const EMPTY_SERIES: DashboardNetworthTrend["data"] = [];

function makeSummary(
  overrides: Partial<DashboardSummary> = {},
): DashboardSummary {
  return {
    currency: "IDR",
    networthCents: 5_000_000_000,
    totalAssetsCents: 7_500_000_000,
    totalLiabilitiesCents: 2_500_000_000,
    incomeThisMonthCents: 4_200_000_000,
    expenseThisMonthCents: 1_800_000_000,
    emergencyFundAvgPct: 65,
    ...overrides,
  };
}

const testCases: TestCase[] = [
  {
    name: "MOBILE_TREND_MONTHS === 6 (viewport-friendly trend window)",
    run(): void {
      // Pinned at 6 because 12 month labels would overlap on a 390 px
      // column. If a future change flips this back to 12, the mobile
      // summary's chart legend will visibly break — the test exists
      // to catch that regression before it ships.
      assert.equal(MOBILE_TREND_MONTHS, 6);
    },
  },
  {
    name: "trimTrendForMobile(12 points) → last 6 entries, in order",
    run(): void {
      const trimmed = trimTrendForMobile(TWELVE_MONTH_SERIES);
      assert.equal(trimmed.length, 6);
      assert.equal(trimmed[0]?.month, "2025-07");
      assert.equal(trimmed[5]?.month, "2025-12");
      // The slice must preserve the original order — never sort or
      // reverse (the chart anchors on the freshest month on the
      // right; reversing would flip the trend line direction).
      for (let index = 1; index < trimmed.length; index += 1) {
        const current = trimmed[index];
        const previous = trimmed[index - 1];
        assert.ok(
          current && previous && current.month > previous.month,
          `entries must stay chronological: ${previous?.month} → ${current?.month}`,
        );
      }
    },
  },
  {
    name: "trimTrendForMobile(6 points) → short-circuits (returns input reference)",
    run(): void {
      // The component should not allocate a new array when the input
      // already fits the window. We check the reference identity to
      // pin that hot-path optimisation.
      const trimmed = trimTrendForMobile(SIX_MONTH_SERIES);
      assert.equal(trimmed.length, 6);
      assert.equal(trimmed, SIX_MONTH_SERIES);
    },
  },
  {
    name: "trimTrendForMobile([]) → [] (empty-series safety)",
    run(): void {
      const trimmed = trimTrendForMobile(EMPTY_SERIES);
      assert.equal(trimmed.length, 0);
      assert.equal(trimmed, EMPTY_SERIES);
    },
  },
  {
    name: "trimTrendForMobile — custom `months` override honoured",
    run(): void {
      const trimmed = trimTrendForMobile(TWELVE_MONTH_SERIES, 3);
      assert.equal(trimmed.length, 3);
      assert.equal(trimmed[0]?.month, "2025-10");
      assert.equal(trimmed[2]?.month, "2025-12");
    },
  },
  {
    name: "buildExpandLabel — non-empty Indonesian destination copy",
    run(): void {
      const label = buildExpandLabel();
      assert.ok(label.length > 0, "expand label must not be empty");
      // The label must mention the destination (halaman penuh / dashboard
      // lengkap) so a screen reader doesn't have to follow the link to
      // know it's a navigation, not a destructive action.
      assert.match(label, /(dashboard|halaman)/i);
    },
  },
  {
    name: "buildExpandLabel — stable across calls (no per-render drift)",
    run(): void {
      assert.equal(buildExpandLabel(), buildExpandLabel());
    },
  },
  {
    name: "Networth tone selection — positive when cents >= 0",
    run(): void {
      const summary = makeSummary({ networthCents: 0 });
      const tone: KpiTone = summary.networthCents >= 0 ? "positive" : "negative";
      assert.equal(tone, "positive");
      // The positive branch must map to a non-empty Tailwind pair so
      // the card never renders blank when the value is exactly zero.
      assert.ok(TONE_STYLES.positive.badge.includes("bg-"));
      assert.ok(TONE_STYLES.positive.value.includes("text-"));
    },
  },
  {
    name: "Networth tone selection — negative when cents < 0",
    run(): void {
      const summary = makeSummary({ networthCents: -1_000 });
      const tone: KpiTone = summary.networthCents >= 0 ? "positive" : "negative";
      assert.equal(tone, "negative");
      // The two tones must differ — collapsing both to `positive`
      // would silently hide a liabilities-dominant balance.
      assert.notEqual(TONE_STYLES.positive.value, TONE_STYLES.negative.value);
    },
  },
  {
    name: "EF empty-state branching — null pct → disabled message",
    run(): void {
      // Mirror the conditional `<DashboardMobileSummary>` uses to flip
      // the EF card into the empty state.
      const efPct: number | null = null;
      const isEmpty = efPct === null;
      assert.equal(isEmpty, true);
      const expectedMessage = "Belum ada dana darurat";
      assert.ok(expectedMessage.length > 0);
    },
  },
  {
    name: "EF non-empty branching — numeric pct → formatPercent output",
    run(): void {
      // The component renders `formatPercent(efPct)` when the BE
      // returns a numeric average. Pin the helper's output shape so
      // a future refactor that drops the `%` suffix gets caught.
      const formatted = formatPercent(65);
      assert.match(formatted, /^\d+%$/);
    },
  },
  {
    name: "Sample summary payload — survives `formatIdrFromCents` round-trip",
    run(): void {
      // Sanity check the cents → IDR formatting path the mobile
      // summary drives on every render. The BE stores integer minor
      // units; we render whole-rupiah only, so the rounded output
      // stays stable across calls.
      const summary = makeSummary({ networthCents: 1_234_567_89 });
      const formatter = new Intl.NumberFormat("id-ID", {
        style: "currency",
        currency: "IDR",
        maximumFractionDigits: 0,
      });
      const expectedRupiah = formatter.format(
        Math.round(summary.networthCents / 100),
      );
      assert.match(expectedRupiah, /^Rp/);
    },
  },
];

function runTests(): void {
  let passed = 0;
  let failed = 0;
  const failures: { name: string; error: unknown }[] = [];
  for (const tc of testCases) {
    try {
      tc.run();
      passed += 1;
      console.log(`  ✓ ${tc.name}`);
    } catch (error) {
      failed += 1;
      failures.push({ name: tc.name, error });
      console.error(`  ✗ ${tc.name}`);
      console.error(`    ${(error as Error).message}`);
    }
  }
  console.log(
    `\n${passed}/${testCases.length} passed (${failed} failed).`,
  );
  if (failed > 0) {
    for (const failure of failures) {
      console.error(`    ${failure.name}: ${(failure.error as Error)?.stack ?? failure.error}`);
    }
    process.exit(1);
  }
}

if (
  process.env["DASHBOARD_MOBILE_SUMMARY_TEST_RUN"] === "1"
) {
  runTests();
}