/**
 * sub-0007-06 — unit tests for the `<DebtSummarySection>` helper
 * functions.
 *
 * The `apps/web` package does not currently ship a Jest/Vitest runner
 * (mirrors the convention used by sub-0007-02 / sub-0007-03). Until
 * a runner lands, this file runs as a plain Node test:
 *
 *   DASHBOARD_DEBTS_SUMMARY_TEST_RUN=1 node --import tsx \
 *     apps/web/src/__tests__/dashboard/debt-summary-section.test.tsx
 *
 * We assert against the *pure* helpers exported from
 * `components/dashboard/widgets/debt-summary-section.tsx`:
 *
 *   - `isDebtsSummaryEmpty(summary)` — true iff both `activeCount`
 *     and `paidOffCount` are 0 (drives the empty-state branch)
 *   - `resolveRemainingTone(summary)` — "rose" when there's
 *     outstanding debt, "slate" once everything is paid off
 *   - `buildDebtsAriaSummary(summary)` — screen-reader summary that
 *     combines the four tile values into one clause
 *
 * The visual rendering (DOM) is covered by the smoke test sub-tasks
 * add later; here we pin the pure logic that drives the dashboard
 * widget. Every `assert` below corresponds 1:1 to an `it(...)` case
 * so the file is portable to `describe` / `it` once a Jest config
 * lands.
 */

import assert from "node:assert/strict";

import {
  buildDebtsAriaSummary,
  isDebtsSummaryEmpty,
  resolveRemainingTone,
} from "@/components/dashboard/widgets/debt-summary-section";
import type { DashboardDebtsSummary } from "@/lib/dashboard/types";

interface TestCase {
  name: string;
  run(): void;
}

function makeSummary(
  overrides: Partial<DashboardDebtsSummary> = {},
): DashboardDebtsSummary {
  return {
    totalRemainingCents: 1_500_000_00,
    totalInterestPaidCents: 250_000_00,
    activeCount: 2,
    paidOffCount: 1,
    ...overrides,
  };
}

const EMPTY_SUMMARY: DashboardDebtsSummary = makeSummary({
  totalRemainingCents: 0,
  totalInterestPaidCents: 0,
  activeCount: 0,
  paidOffCount: 0,
});

const testCases: TestCase[] = [
  {
    name: "isDebtsSummaryEmpty — both counts zero → true (empty state branch)",
    run(): void {
      assert.equal(isDebtsSummaryEmpty(EMPTY_SUMMARY), true);
    },
  },
  {
    name: "isDebtsSummaryEmpty — active_count > 0 → false (real report)",
    run(): void {
      assert.equal(
        isDebtsSummaryEmpty(
          makeSummary({ activeCount: 1, paidOffCount: 0 }),
        ),
        false,
      );
    },
  },
  {
    name: "isDebtsSummaryEmpty — paid_off only is NOT empty (lunas history matters)",
    run(): void {
      // The spec says the section is empty ONLY when BOTH counts are
      // 0. A user with only paid-off history should still see the
      // "Lunas" tile (count + total bunga paid) — that's a real
      // report, not an empty dashboard.
      assert.equal(
        isDebtsSummaryEmpty(
          makeSummary({ activeCount: 0, paidOffCount: 1, totalRemainingCents: 0 }),
        ),
        false,
      );
    },
  },
  {
    name: "resolveRemainingTone — outstanding debt → 'rose' (warning colour)",
    run(): void {
      assert.equal(
        resolveRemainingTone(makeSummary({ totalRemainingCents: 1_000_000 })),
        "rose",
      );
    },
  },
  {
    name: "resolveRemainingTone — fully paid off → 'slate' (no warning colour)",
    run(): void {
      assert.equal(
        resolveRemainingTone(makeSummary({ totalRemainingCents: 0 })),
        "slate",
      );
    },
  },
  {
    name: "resolveRemainingTone — defensive: negative remaining mirrors spec (> 0 only)",
    run(): void {
      // The spec is strictly "rose when remaining > 0". A negative
      // value shouldn't surface from the BE (it's clamped to >= 0 by
      // the aggregator) — but the helper still resolves it to slate
      // because the predicate is `> 0`, not `!= 0`. We pin the
      // current behaviour here so a future change is intentional.
      assert.equal(
        resolveRemainingTone(makeSummary({ totalRemainingCents: -1 })),
        "slate",
      );
    },
  },
  {
    name: "buildDebtsAriaSummary — combines the four tile values in one clause",
    run(): void {
      const summary = makeSummary({
        totalRemainingCents: 2_500_000_00,
        totalInterestPaidCents: 250_000_00,
        activeCount: 2,
        paidOffCount: 1,
      });
      const aria = buildDebtsAriaSummary(summary);
      // The summary must mention every value the tile surfaces, in a
      // stable order, so screen-reader users get the same content
      // sequence as the visual order: active, lunas, sisa, bunga.
      // NBSP normalisation: `Intl.NumberFormat("id-ID")` uses a
      // non-breaking space (U+00A0) between `Rp` and the digits — we
      // collapse any whitespace class before substring matching so
      // the assertions stay readable (no \u00a0 sprinkled around).
      const flat = aria.replace(/\s+/g, " ");
      assert.ok(flat.includes("2 utang aktif"), `missing active count: ${aria}`);
      assert.ok(flat.includes("1 lunas"), `missing paid-off count: ${aria}`);
      assert.ok(flat.includes("Rp 2.500.000"), `missing sisa saldo: ${aria}`);
      assert.ok(flat.includes("Rp 250.000"), `missing bunga: ${aria}`);
    },
  },
  {
    name: "buildDebtsAriaSummary — empty summary still produces a sentence (no NaN)",
    run(): void {
      const aria = buildDebtsAriaSummary(EMPTY_SUMMARY);
      const flat = aria.replace(/\s+/g, " ");
      assert.ok(flat.includes("0 utang aktif"), `missing active count: ${aria}`);
      assert.ok(flat.includes("0 lunas"), `missing paid-off count: ${aria}`);
      assert.ok(flat.includes("Rp 0"), `missing Rp 0 placeholder: ${aria}`);
      // Defensive: no NaN or "undefined" can leak through.
      assert.ok(!aria.includes("NaN"), `unexpected NaN: ${aria}`);
      assert.ok(!aria.includes("undefined"), `unexpected undefined: ${aria}`);
    },
  },
];

export function runDebtSummarySectionTests(): {
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
  process.env["DASHBOARD_DEBTS_SUMMARY_TEST_RUN"] === "1"
) {
  const result = runDebtSummarySectionTests();
  if (result.failed > 0) {
    console.error(
      `[debt-summary-section.test] ${result.failed} of ${result.failed + result.passed} failed`,
    );
    for (const failure of result.failures) {
      console.error(`  - ${failure.name}`);
      console.error(`      ${(failure.error as Error)?.stack ?? failure.error}`);
    }
    process.exitCode = 1;
  } else {
    console.log(
      `[debt-summary-section.test] ${result.passed} cases passed`,
    );
  }
}
