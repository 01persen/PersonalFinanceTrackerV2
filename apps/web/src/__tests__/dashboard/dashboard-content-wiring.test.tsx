/**
 * sub-0007-08 — unit tests for the `<DashboardContent>` wiring
 * predicates.
 *
 * The `apps/web` package does not currently ship a Jest/Vitest runner
 * (mirrors the convention used by sub-0007-02 / sub-0007-03 / ...). Until
 * a runner lands, this file runs as a plain Node test:
 *
 *   DASHBOARD_CONTENT_WIRING_TEST_RUN=1 node --import tsx \
 *     apps/web/src/__tests__/dashboard/dashboard-content-wiring.test.tsx
 *
 * The CI/CD review of sub-0007-08 (#78) flagged that no test mounts
 * `<DashboardContent>` itself — every prior sub-task asserted on pure
 * helpers, so a regression in the page-level wiring (which components
 * surface when, in what order) slipped past typecheck + build + the
 * component-level suite. These tests pin the *predicates* the wiring
 * uses so a future refactor that flips a sign or drops a clause fails
 * here, even before a real React renderer lands.
 *
 * Assertions:
 *
 *   - `isBrandNewUser` returns `true` only when summary + top-categories
 *     are zero-valued across the board.
 *   - `isBrandNewUser` returns `false` when *any* of the three signals
 *     (no accounts / no transactions / no top categories) is broken.
 *   - `hasCategoryLookupFailure` returns `true` when at least one entry
 *     carries `categoryName=null` or a blank string.
 *   - `hasCategoryLookupFailure` returns `false` when every entry has
 *     a non-blank `categoryName`.
 *   - `hasCategoryLookupFailure` returns `false` when the payload is
 *     still `null` (loading state) — the wiring never fires during
 *     load so the toast doesn't pop prematurely.
 */

import assert from "node:assert/strict";

import {
  hasCategoryLookupFailure,
  isBrandNewUser,
} from "@/components/dashboard/dashboard-content";
import type {
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

function summaryWithAccounts(): DashboardSummary {
  return {
    currency: "IDR",
    networthCents: 5_000_000_00,
    totalAssetsCents: 5_000_000_00,
    totalLiabilitiesCents: 0,
    incomeThisMonthCents: 0,
    expenseThisMonthCents: 0,
    emergencyFundAvgPct: null,
  };
}

function summaryWithTransactions(): DashboardSummary {
  return {
    currency: "IDR",
    networthCents: 0,
    totalAssetsCents: 0,
    totalLiabilitiesCents: 0,
    incomeThisMonthCents: 1_000_000_00,
    expenseThisMonthCents: 0,
    emergencyFundAvgPct: null,
  };
}

function topCategories(
  data: DashboardTopCategories["data"],
): DashboardTopCategories {
  return { data };
}

const testCases: TestCase[] = [
  // ---- isBrandNewUser ---------------------------------------------------
  {
    name: "isBrandNewUser(null summary) → false (loading state)",
    run(): void {
      assert.equal(isBrandNewUser(null, null), false);
      assert.equal(
        isBrandNewUser(null, topCategories([])),
        false,
      );
    },
  },
  {
    name: "isBrandNewUser(all zero, empty top categories) → true",
    run(): void {
      assert.equal(
        isBrandNewUser(emptySummary(), topCategories([])),
        true,
      );
    },
  },
  {
    name: "isBrandNewUser(summary, topCategories=null) → true",
    run(): void {
      // topCategories can stay `null` until the endpoint resolves;
      // treat it the same as "no categories" for the brand-new branch.
      assert.equal(isBrandNewUser(emptySummary(), null), true);
    },
  },
  {
    name: "isBrandNewUser(accounts > 0) → false (real user, even if no tx)",
    run(): void {
      assert.equal(
        isBrandNewUser(summaryWithAccounts(), topCategories([])),
        false,
      );
    },
  },
  {
    name: "isBrandNewUser(transactions > 0) → false (even without accounts)",
    run(): void {
      // Edge case: a user could in theory have orphan transactions.
      // The predicate refuses the empty state so the dashboard still
      // shows the recent-tx signal rather than zero-valued cards.
      assert.equal(
        isBrandNewUser(summaryWithTransactions(), topCategories([])),
        false,
      );
    },
  },
  {
    name: "isBrandNewUser(non-empty top categories) → false",
    run(): void {
      assert.equal(
        isBrandNewUser(
          emptySummary(),
          topCategories([
            {
              categoryId: "cat-x",
              categoryName: "Makanan",
              totalCents: 50_000,
              percentage: 100,
            },
          ]),
        ),
        false,
      );
    },
  },

  // ---- hasCategoryLookupFailure ----------------------------------------
  {
    name: "hasCategoryLookupFailure(null topCategories) → false (no toast during load)",
    run(): void {
      assert.equal(hasCategoryLookupFailure(null), false);
    },
  },
  {
    name: "hasCategoryLookupFailure(empty array) → false",
    run(): void {
      assert.equal(hasCategoryLookupFailure(topCategories([])), false);
    },
  },
  {
    name: "hasCategoryLookupFailure(all named) → false",
    run(): void {
      assert.equal(
        hasCategoryLookupFailure(
          topCategories([
            {
              categoryId: "cat-1",
              categoryName: "Makanan",
              totalCents: 100_000,
              percentage: 50,
            },
            {
              categoryId: "cat-2",
              categoryName: "Transport",
              totalCents: 100_000,
              percentage: 50,
            },
          ]),
        ),
        false,
      );
    },
  },
  {
    name: "hasCategoryLookupFailure(one null name) → true",
    run(): void {
      assert.equal(
        hasCategoryLookupFailure(
          topCategories([
            {
              categoryId: "cat-1",
              categoryName: "Makanan",
              totalCents: 100_000,
              percentage: 50,
            },
            {
              categoryId: null,
              categoryName: null,
              totalCents: 100_000,
              percentage: 50,
            },
          ]),
        ),
        true,
      );
    },
  },
  {
    name: "hasCategoryLookupFailure(blank-string name) → true",
    run(): void {
      // Empty / whitespace-only names count as lookup failures too —
      // the donut would render "Tanpa nama" anyway and the user
      // deserves the warning.
      assert.equal(
        hasCategoryLookupFailure(
          topCategories([
            {
              categoryId: "cat-1",
              categoryName: "   ",
              totalCents: 100_000,
              percentage: 100,
            },
          ]),
        ),
        true,
      );
    },
  },
];

// --------------------------------------------------------------------------
// Test runner (mirrors `kpi-cards.test.tsx`).
// --------------------------------------------------------------------------

export function runDashboardContentWiringTests(): {
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
  process.env["DASHBOARD_CONTENT_WIRING_TEST_RUN"] === "1"
) {
  const result = runDashboardContentWiringTests();
  if (result.failed > 0) {
    console.error(
      `[dashboard-content-wiring.test] ${result.failed} of ${result.failed + result.passed} failed`,
    );
    for (const failure of result.failures) {
      console.error(`  - ${failure.name}`);
      console.error(`      ${(failure.error as Error)?.stack ?? failure.error}`);
    }
    process.exitCode = 1;
  } else {
    console.log(
      `[dashboard-content-wiring.test] ${result.passed} cases passed`,
    );
  }
}