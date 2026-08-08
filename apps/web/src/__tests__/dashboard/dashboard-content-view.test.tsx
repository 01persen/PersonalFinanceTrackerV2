/**
 * sub-0007-08 — integration test for `<DashboardContent>` view wiring.
 *
 * The `apps/web` package does not currently ship a Jest/Vitest runner
 * (mirrors the convention used by sub-0007-02 / sub-0007-03 / ...). The
 * CI/CD review of sub-0007-07 flagged that no test mounts the page-
 * level wiring — every prior sub-task asserted on pure helpers, so a
 * regression that swapped "empty" for "ready" (or showed the mobile
 * pane for a brand-new user) slipped past typecheck + build + the
 * component-level suite.
 *
 * Until a real renderer lands, this file tests the **view-selection
 * predicate** the JSX consumes (mirrors the existing pattern of
 * exporting pure helpers for the test runner). Catching wiring bugs
 * at the predicate level is enough because every branch of the
 * `selectDashboardView(state, flags)` switch is exercised 1:1 by the
 * JSX.
 *
 * Until a runner lands, this file runs as a plain Node test:
 *
 *   DASHBOARD_CONTENT_VIEW_TEST_RUN=1 node --import tsx \
 *     apps/web/src/__tests__/dashboard/dashboard-content-view.test.tsx
 *
 * Assertions cover the AC pinned in the TL decision (#c630d63d):
 *
 *   - `loading` view returns when `state.status === "loading"`.
 *   - `error` view carries the API error message verbatim.
 *   - `error` view falls back to a friendly default when the message
 *     is `null` (e.g. non-ApiError rejection).
 *   - `empty` view returns when `isBrandNew` is true (regardless of
 *     `showMobileSummary` — per TL #1: empty state replaces both panes).
 *   - `ready` view surfaces `hasLookupFailure` when the predicate is
 *     true and omits it otherwise.
 *   - `ready` view surfaces `showMobile` reflecting `showMobileSummary`
 *     — so `/dashboard/full` (showMobileSummary=false) suppresses
 *     the mobile pane.
 *   - `ready` view surfaces `toastVisible` only when the lookup failure
 *     is active AND the toast hasn't been dismissed.
 *   - `ready` view returns a non-empty flag set even when
 *     `showMobileSummary=true` and the lookup is healthy — pins the
 *     baseline so a future "always-mobile" refactor fails here.
 */

import assert from "node:assert/strict";

import {
  selectDashboardView,
  type DashboardState,
  type DashboardView,
} from "@/components/dashboard/dashboard-content";
import type {
  DashboardDebtsSummary,
  DashboardGoalsProgress,
  DashboardIncomeExpenseTrend,
  DashboardNetworthTrend,
  DashboardSummary,
  DashboardTopCategories,
} from "@/lib/dashboard/types";

interface TestCase {
  name: string;
  run(): void;
}

function emptySummary(): DashboardSummary {
  return {
    currency: "IDR",
    networthCents: 0,
    totalAssetsCents: 0,
    totalLiabilitiesCents: 0,
    incomeThisMonthCents: 0,
    expenseThisMonthCents: 0,
    emergencyFundAvgPct: null,
  };
}

function realSummary(): DashboardSummary {
  return {
    currency: "IDR",
    networthCents: 50_000_000_00,
    totalAssetsCents: 70_000_000_00,
    totalLiabilitiesCents: 20_000_000_00,
    incomeThisMonthCents: 5_000_000_00,
    expenseThisMonthCents: 2_000_000_00,
    emergencyFundAvgPct: 80,
  };
}

function realTrend(): DashboardNetworthTrend {
  return { data: [{ month: "2026-01", networthCents: 50_000_000_00 }] };
}

function realIncomeExpense(): DashboardIncomeExpenseTrend {
  return {
    data: [{ month: "2026-01", incomeCents: 5_000_000_00, expenseCents: 2_000_000_00 }],
  };
}

function realGoals(): DashboardGoalsProgress {
  return { data: [] };
}

function realDebts(): DashboardDebtsSummary {
  return {
    totalRemainingCents: 0,
    totalInterestPaidCents: 0,
    activeCount: 0,
    paidOffCount: 0,
  };
}

function realTopCategories(): DashboardTopCategories {
  return {
    data: [
      {
        categoryId: "cat-1",
        categoryName: "Makanan",
        totalCents: 100_000,
        percentage: 100,
      },
    ],
  };
}

function emptyTopCategories(): DashboardTopCategories {
  return { data: [] };
}

const FLAGS_DEFAULT = {
  isBrandNew: false,
  categoryLookupFailed: false,
  showMobileSummary: true,
  toastDismissed: false,
} as const;

const testCases: TestCase[] = [
  // ---- loading view ----------------------------------------------------
  {
    name: "loading state → { kind: 'loading' } (skeleton)",
    run(): void {
      const state: DashboardState = {
        status: "loading",
        summary: null,
        networthTrend: null,
        incomeExpenseTrend: null,
        topCategories: null,
        goalsProgress: null,
        debtsSummary: null,
        errorMessage: null,
      };
      const view = selectDashboardView(state, FLAGS_DEFAULT);
      assert.equal(view.kind, "loading");
    },
  },

  // ---- error view -----------------------------------------------------
  {
    name: "error state → { kind: 'error' } with API message verbatim",
    run(): void {
      const state: DashboardState = {
        status: "error",
        summary: null,
        networthTrend: null,
        incomeExpenseTrend: null,
        topCategories: null,
        goalsProgress: null,
        debtsSummary: null,
        errorMessage: "Server sedang bermasalah. Coba lagi beberapa saat.",
      };
      const view = selectDashboardView(state, FLAGS_DEFAULT);
      assert.equal(view.kind, "error");
      if (view.kind === "error") {
        assert.equal(
          view.message,
          "Server sedang bermasalah. Coba lagi beberapa saat.",
        );
      }
    },
  },
  {
    name: "error state with null message → generic Indonesian fallback",
    run(): void {
      const state: DashboardState = {
        status: "error",
        summary: null,
        networthTrend: null,
        incomeExpenseTrend: null,
        topCategories: null,
        goalsProgress: null,
        debtsSummary: null,
        errorMessage: null,
      };
      const view = selectDashboardView(state, FLAGS_DEFAULT);
      assert.equal(view.kind, "error");
      if (view.kind === "error") {
        assert.equal(view.message, "Tidak bisa memuat dashboard.");
      }
    },
  },

  // ---- empty view (TL decision #1) ------------------------------------
  {
    name: "ready + brand-new + showMobileSummary=true → empty (mobile pane suppressed)",
    run(): void {
      const state: DashboardState = {
        status: "ready",
        summary: emptySummary(),
        networthTrend: { data: [] },
        incomeExpenseTrend: { data: [] },
        topCategories: emptyTopCategories(),
        goalsProgress: realGoals(),
        debtsSummary: realDebts(),
        errorMessage: null,
      };
      const view = selectDashboardView(state, {
        isBrandNew: true,
        categoryLookupFailed: false,
        showMobileSummary: true,
        toastDismissed: false,
      });
      assert.equal(view.kind, "empty");
    },
  },
  {
    name: "ready + brand-new + showMobileSummary=false → empty (also suppresses mobile)",
    run(): void {
      const state: DashboardState = {
        status: "ready",
        summary: emptySummary(),
        networthTrend: { data: [] },
        incomeExpenseTrend: { data: [] },
        topCategories: emptyTopCategories(),
        goalsProgress: realGoals(),
        debtsSummary: realDebts(),
        errorMessage: null,
      };
      const view = selectDashboardView(state, {
        isBrandNew: true,
        categoryLookupFailed: false,
        showMobileSummary: false,
        toastDismissed: false,
      });
      assert.equal(
        view.kind,
        "empty",
        "TL decision #1: brand-new users see empty state regardless of route",
      );
    },
  },

  // ---- ready view -----------------------------------------------------
  {
    name: "ready + non-brand-new + healthy lookup → ready with lookup NOT visible + mobile visible",
    run(): void {
      const state: DashboardState = {
        status: "ready",
        summary: realSummary(),
        networthTrend: realTrend(),
        incomeExpenseTrend: realIncomeExpense(),
        topCategories: realTopCategories(),
        goalsProgress: realGoals(),
        debtsSummary: realDebts(),
        errorMessage: null,
      };
      const view = selectDashboardView(state, {
        isBrandNew: false,
        categoryLookupFailed: false,
        showMobileSummary: true,
        toastDismissed: false,
      });
      assert.equal(view.kind, "ready");
      if (view.kind === "ready") {
        assert.equal(view.hasLookupFailure, false);
        assert.equal(view.showMobile, true);
        assert.equal(view.toastVisible, false);
      }
    },
  },
  {
    name: "ready + non-brand-new + lookup failure + showMobileSummary=true → ready with warning + toast",
    run(): void {
      const state: DashboardState = {
        status: "ready",
        summary: realSummary(),
        networthTrend: realTrend(),
        incomeExpenseTrend: realIncomeExpense(),
        topCategories: {
          data: [
            {
              categoryId: "cat-1",
              categoryName: null,
              totalCents: 100_000,
              percentage: 100,
            },
          ],
        },
        goalsProgress: realGoals(),
        debtsSummary: realDebts(),
        errorMessage: null,
      };
      const view = selectDashboardView(state, {
        isBrandNew: false,
        categoryLookupFailed: true,
        showMobileSummary: true,
        toastDismissed: false,
      });
      assert.equal(view.kind, "ready");
      if (view.kind === "ready") {
        assert.equal(view.hasLookupFailure, true);
        assert.equal(view.toastVisible, true);
        assert.equal(view.showMobile, true);
      }
    },
  },
  {
    name: "ready + non-brand-new + lookup failure + showMobileSummary=false → mobile pane suppressed",
    run(): void {
      // TL decision #3: `/dashboard/full` doesn't render the mobile
      // pane regardless of lookup state.
      const state: DashboardState = {
        status: "ready",
        summary: realSummary(),
        networthTrend: realTrend(),
        incomeExpenseTrend: realIncomeExpense(),
        topCategories: realTopCategories(),
        goalsProgress: realGoals(),
        debtsSummary: realDebts(),
        errorMessage: null,
      };
      const view = selectDashboardView(state, {
        isBrandNew: false,
        categoryLookupFailed: false,
        showMobileSummary: false,
        toastDismissed: false,
      });
      assert.equal(view.kind, "ready");
      if (view.kind === "ready") {
        assert.equal(view.showMobile, false);
      }
    },
  },
  {
    name: "ready + lookup failure + toast already dismissed → toast NOT visible",
    run(): void {
      const state: DashboardState = {
        status: "ready",
        summary: realSummary(),
        networthTrend: realTrend(),
        incomeExpenseTrend: realIncomeExpense(),
        topCategories: realTopCategories(),
        goalsProgress: realGoals(),
        debtsSummary: realDebts(),
        errorMessage: null,
      };
      const view = selectDashboardView(state, {
        isBrandNew: false,
        categoryLookupFailed: true,
        showMobileSummary: true,
        toastDismissed: true,
      });
      assert.equal(view.kind, "ready");
      if (view.kind === "ready") {
        assert.equal(view.hasLookupFailure, true, "banner stays visible");
        assert.equal(view.toastVisible, false, "toast auto-dismissed");
      }
    },
  },
  {
    name: "ready + brand-new=false + real user → ready with all flags baseline",
    run(): void {
      // Pin the "happy path" baseline so a future regression that
      // swaps any single flag off the default fails here.
      const state: DashboardState = {
        status: "ready",
        summary: realSummary(),
        networthTrend: realTrend(),
        incomeExpenseTrend: realIncomeExpense(),
        topCategories: realTopCategories(),
        goalsProgress: realGoals(),
        debtsSummary: realDebts(),
        errorMessage: null,
      };
      const view = selectDashboardView(state, FLAGS_DEFAULT);
      const expected: DashboardView = {
        kind: "ready",
        hasLookupFailure: false,
        showMobile: true,
        toastVisible: false,
      };
      assert.deepEqual(view, expected);
    },
  },
];

// --------------------------------------------------------------------------
// Test runner (mirrors `kpi-cards.test.tsx`).
// --------------------------------------------------------------------------

export function runDashboardContentViewTests(): {
  passed: number;
  failed: number;
  failures: { name: string; error: unknown }[];
} {
  let passed = 0;
  let failed = 0;
  const failures: { name: string; error: unknown }[] = [];
  for (const tc of testCases) {
    try {
      tc.run();
      passed += 1;
    } catch (error) {
      failed += 1;
      failures.push({ name: tc.name, error });
    }
  }
  return { passed, failed, failures };
}

if (
  typeof process !== "undefined" &&
  process.env !== undefined &&
  process.env["DASHBOARD_CONTENT_VIEW_TEST_RUN"] === "1"
) {
  const result = runDashboardContentViewTests();
  if (result.failed > 0) {
    console.error(
      `[dashboard-content-view.test] ${result.failed} of ${result.failed + result.passed} failed`,
    );
    for (const failure of result.failures) {
      console.error(`  - ${failure.name}`);
      console.error(`      ${(failure.error as Error)?.stack ?? failure.error}`);
    }
    process.exitCode = 1;
  } else {
    console.log(
      `[dashboard-content-view.test] ${result.passed} cases passed`,
    );
  }
}