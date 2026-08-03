/**
 * sub-0006-04 — unit tests for the debt list page's pure helpers.
 *
 * The `apps/web` package does not currently ship a Jest/Vitest runner
 * (mirrors the convention used by sub-0005-03's
 * `progress-banner.test.tsx`). Until a runner lands this file runs as
 * a plain Node test:
 *
 *   node --import tsx apps/web/src/components/debts/__tests__/debt-helpers.test.ts
 *
 * The assertions cover the AC bullets in the issue body:
 *
 *   - currency formatting (whole-rupiah, `Rp` prefix, dot separator)
 *   - zero values (active debt with 0 remaining + interest paid)
 *   - large values (1 milyar + sample case 12jt @10% / 12 bulan → 1.1jt)
 *
 * Every `assert` below corresponds 1:1 to an `it(...)` case so the
 * file is portable to `describe` / `it` once a Jest config lands.
 */

import assert from "node:assert/strict";

import {
  aggregateDebtTotals,
  formatDebtBungaPct,
  formatDebtIdrAmountOnly,
  formatDebtIdrFromCents,
  formatDebtIsoDate,
  parseIsoDate,
} from "@/lib/api/debt-client";
import {
  resolveDebtRowState,
  sortDebtsForDisplay,
} from "@/components/debts/debt-list";
import type { Debt, DebtSummary } from "@/lib/api/debt-client";

interface TestCase {
  name: string;
  run(): void;
}

function buildDebt(overrides: Partial<Debt> = {}): Debt {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    userId: "00000000-0000-0000-0000-0000000000aa",
    name: "KTA BPD",
    kind: "KTA",
    principalCents: 1_200_000_000,
    bungaPct: 10.0,
    tenorMonths: 12,
    startDate: "2026-01-15",
    monthlyPaymentCents: 110_000_000,
    note: null,
    status: "active",
    createdAt: "2026-01-15T10:00:00Z",
    updatedAt: "2026-01-15T10:00:00Z",
    ...overrides,
  };
}

function buildSummary(overrides: Partial<DebtSummary> = {}): DebtSummary {
  return {
    debtId: "00000000-0000-0000-0000-000000000001",
    remainingPrincipalCents: 1_200_000_000,
    totalInterestPaidCents: 0,
    nextPaymentDueDate: "2026-02-15",
    monthsRemaining: 12,
    ...overrides,
  };
}

const IDR_SAMPLE: Debt = buildDebt({
  id: "00000000-0000-0000-0000-000000000010",
  principalCents: 1_200_000_000, // 12.000.000 rupiah = 12jt
  monthlyPaymentCents: 110_000_000, // 1.100.000 rupiah = 1.1jt (sample case)
});

const IDR_SUMMARY: DebtSummary = buildSummary({
  debtId: "00000000-0000-0000-0000-000000000010",
  remainingPrincipalCents: 0,
  totalInterestPaidCents: 120_000_000, // 1.200.000 rupiah = 1.2jt (sample case)
  nextPaymentDueDate: null,
  monthsRemaining: 0,
});

const LARGE_DEBT: Debt = buildDebt({
  id: "00000000-0000-0000-0000-000000000020",
  principalCents: 150_000_000_000, // 1.5 milyar
  monthlyPaymentCents: 1_250_000_000, // 12.5 juta
  kind: "KPR",
});

const LARGE_SUMMARY: DebtSummary = buildSummary({
  debtId: "00000000-0000-0000-0000-000000000020",
  remainingPrincipalCents: 120_000_000_000, // 1.2 milyar
  totalInterestPaidCents: 3_500_000_000, // 35 juta
});

const ZERO_DEBT: Debt = buildDebt({
  id: "00000000-0000-0000-0000-000000000030",
  principalCents: 0,
  monthlyPaymentCents: 0,
  tenorMonths: null,
  kind: "credit_card",
});

const ZERO_SUMMARY: DebtSummary = buildSummary({
  debtId: "00000000-0000-0000-0000-000000000030",
  remainingPrincipalCents: 0,
  totalInterestPaidCents: 0,
});

const TENORLESS_DEBT: Debt = buildDebt({
  id: "00000000-0000-0000-0000-000000000040",
  principalCents: 500_000_000, // 5jt
  tenorMonths: null,
  monthlyPaymentCents: null,
  kind: "credit_card",
});

/**
 * `Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR" })`
 * inserts a NARROW NO-BREAK SPACE (U+202F / U+00A0 depending on the
 * ICU build) between the `Rp` prefix and the digit group — copying the
 * expected literal with a regular space is a false failure. The
 * helper normalises the gap so the assertions can read naturally
 * without depending on the runtime ICU version.
 */
function flattenCurrency(value: string): string {
  return value.replace(/[\u00a0\u202f\u2007]/g, " ");
}

const testCases: TestCase[] = [
  // ------------------------------------------------------------------
  // Currency formatting (IDR, whole rupiah, dot separator).
  // ------------------------------------------------------------------
  {
    name: "formatDebtIdrFromCents — sample case 12jt @10% / 12 bulan",
    run(): void {
      // Cicilan 1.1jt = 110_000_000 cents → "Rp 1.100.000".
      assert.equal(flattenCurrency(formatDebtIdrFromCents(110_000_000)), "Rp 1.100.000");
      // Total bunga 1.2jt = 120_000_000 cents → "Rp 1.200.000".
      assert.equal(flattenCurrency(formatDebtIdrFromCents(120_000_000)), "Rp 1.200.000");
      // Pokok 12jt = 1_200_000_000 cents → "Rp 12.000.000".
      assert.equal(flattenCurrency(formatDebtIdrFromCents(1_200_000_000)), "Rp 12.000.000");
    },
  },
  {
    name: "formatDebtIdrFromCents — large value (1 milyar)",
    run(): void {
      assert.equal(
        flattenCurrency(formatDebtIdrFromCents(10_000_000_000)),
        "Rp 100.000.000",
      );
      assert.equal(
        flattenCurrency(formatDebtIdrFromCents(150_000_000_000)),
        "Rp 1.500.000.000",
      );
    },
  },
  {
    name: "formatDebtIdrFromCents — zero renders Rp 0",
    run(): void {
      assert.equal(flattenCurrency(formatDebtIdrFromCents(0)), "Rp 0");
    },
  },
  {
    name: "formatDebtIdrFromCents — rounds sub-rupiah cents",
    run(): void {
      // 1.234 cents = Rp 12.34 → rounds to Rp 12.
      assert.equal(flattenCurrency(formatDebtIdrFromCents(1_234)), "Rp 12");
      // 1.235 cents = Rp 12.35 → rounds to Rp 12 (banker's half-even
      // via Math.round; midpoint is acceptable either way — the test
      // is only that the formatter never renders `Rp 12,35`).
      assert.match(flattenCurrency(formatDebtIdrFromCents(1_235)), /^Rp 12$/);
    },
  },
  {
    name: "formatDebtIdrAmountOnly — drops the Rp prefix",
    run(): void {
      assert.equal(formatDebtIdrAmountOnly(110_000_000), "1.100.000");
      assert.equal(formatDebtIdrAmountOnly(0), "0");
    },
  },
  {
    name: "formatDebtBungaPct — uses Indonesian comma + two decimals max",
    run(): void {
      assert.equal(formatDebtBungaPct(10), "10%");
      assert.equal(formatDebtBungaPct(7.5), "7,5%");
      // Capped at two decimals so 7.4999 doesn't render as `7,4999%`.
      assert.equal(formatDebtBungaPct(7.4999), "7,5%");
      // Defensive: NaN / Infinity → "0%" so the dashboard never
      // shows `NaN%`.
      assert.equal(formatDebtBungaPct(NaN), "0%");
      assert.equal(formatDebtBungaPct(Infinity), "0%");
    },
  },

  // ------------------------------------------------------------------
  // Date formatting (UTC, Indonesian long form).
  // ------------------------------------------------------------------
  {
    name: "parseIsoDate — returns null on malformed input",
    run(): void {
      assert.equal(parseIsoDate("not-a-date"), null);
      assert.equal(parseIsoDate(""), null);
    },
  },
  {
    name: "parseIsoDate — strips beyond the YYYY-MM-DD prefix",
    run(): void {
      const date = parseIsoDate("2026-01-15T10:00:00Z");
      assert.ok(date instanceof Date);
      assert.equal((date as Date).getUTCFullYear(), 2026);
      assert.equal((date as Date).getUTCMonth(), 0);
      assert.equal((date as Date).getUTCDate(), 15);
    },
  },
  {
    name: "formatDebtIsoDate — renders Indonesian long date",
    run(): void {
      assert.equal(formatDebtIsoDate("2026-01-15"), "15 Januari 2026");
    },
  },
  {
    name: "formatDebtIsoDate — null / empty → em dash",
    run(): void {
      assert.equal(formatDebtIsoDate(null), "—");
      assert.equal(formatDebtIsoDate(undefined), "—");
      assert.equal(formatDebtIsoDate(""), "—");
    },
  },

  // ------------------------------------------------------------------
  // Sorting — status first, then start_date desc, then created_at,
  // then id as a tiebreaker. Mirrors the production sort helper so
  // the test pins behaviour in isolation from React.
  // ------------------------------------------------------------------
  {
    name: "sortDebtsForDisplay — paid-off sorts below active",
    run(): void {
      const paid = buildDebt({
        id: "paid",
        status: "paid_off",
        startDate: "2026-01-01",
      });
      const active = buildDebt({
        id: "active",
        status: "active",
        startDate: "2026-01-02",
      });
      const ordered = sortDebtsForDisplay([paid, active]);
      assert.equal(ordered[0]?.id, "active");
      assert.equal(ordered[1]?.id, "paid");
    },
  },
  {
    name: "sortDebtsForDisplay — newest start_date first inside status",
    run(): void {
      const older = buildDebt({
        id: "older",
        status: "active",
        startDate: "2026-01-01",
        createdAt: "2026-01-01T00:00:00Z",
      });
      const newer = buildDebt({
        id: "newer",
        status: "active",
        startDate: "2026-02-01",
        createdAt: "2026-02-01T00:00:00Z",
      });
      const ordered = sortDebtsForDisplay([older, newer]);
      assert.equal(ordered[0]?.id, "newer");
      assert.equal(ordered[1]?.id, "older");
    },
  },
  {
    name: "sortDebtsForDisplay — id tiebreaker is stable",
    run(): void {
      const a = buildDebt({
        id: "a-uuid",
        status: "active",
        startDate: "2026-01-01",
        createdAt: "2026-01-01T00:00:00Z",
      });
      const b = buildDebt({
        id: "b-uuid",
        status: "active",
        startDate: "2026-01-01",
        createdAt: "2026-01-01T00:00:00Z",
      });
      const ordered = sortDebtsForDisplay([b, a]);
      assert.equal(ordered[0]?.id, "a-uuid");
      assert.equal(ordered[1]?.id, "b-uuid");
    },
  },

  // ------------------------------------------------------------------
  // Aggregator — the four ringkasan tiles + the active / paid-off /
  // tenorless counters. Mirrors the production helper so the test
  // pins the rounding + zero-handling in isolation.
  // ------------------------------------------------------------------
  {
    name: "aggregateDebtTotals — sample case total bunga included",
    run(): void {
      const totals = aggregateDebtTotals({
        debts: [IDR_SAMPLE],
        summaries: new Map([[IDR_SAMPLE.id, IDR_SUMMARY]]),
      });
      assert.equal(totals.totalPrincipalCents, 1_200_000_000);
      assert.equal(totals.totalRemainingCents, 0);
      assert.equal(totals.totalInterestPaidCents, 120_000_000);
      assert.equal(totals.totalMonthlyPaymentCents, 110_000_000);
      assert.equal(totals.activeCount, 1);
      assert.equal(totals.paidOffCount, 0);
      assert.equal(totals.tenorlessCount, 0);
    },
  },
  {
    name: "aggregateDebtTotals — large values (milyar) don't overflow",
    run(): void {
      const totals = aggregateDebtTotals({
        debts: [LARGE_DEBT],
        summaries: new Map([[LARGE_DEBT.id, LARGE_SUMMARY]]),
      });
      assert.equal(totals.totalPrincipalCents, 150_000_000_000);
      assert.equal(totals.totalRemainingCents, 120_000_000_000);
      assert.equal(totals.totalInterestPaidCents, 3_500_000_000);
      assert.equal(totals.totalMonthlyPaymentCents, 1_250_000_000);
    },
  },
  {
    name: "aggregateDebtTotals — zero values stay zero",
    run(): void {
      const totals = aggregateDebtTotals({
        debts: [ZERO_DEBT],
        summaries: new Map([[ZERO_DEBT.id, ZERO_SUMMARY]]),
      });
      assert.equal(totals.totalPrincipalCents, 0);
      assert.equal(totals.totalRemainingCents, 0);
      assert.equal(totals.totalInterestPaidCents, 0);
      assert.equal(totals.totalMonthlyPaymentCents, 0);
      assert.equal(totals.activeCount, 1);
      // ZERO_DEBT carries `tenor_months = null` (credit-card shape),
      // so it counts toward the tenorless bucket by design.
      assert.equal(totals.tenorlessCount, 1);
    },
  },
  {
    name: "aggregateDebtTotals — tenorless debt excluded from monthly total",
    run(): void {
      const totals = aggregateDebtTotals({
        debts: [IDR_SAMPLE, TENORLESS_DEBT],
        summaries: new Map([
          [IDR_SAMPLE.id, IDR_SUMMARY],
          [TENORLESS_DEBT.id, ZERO_SUMMARY],
        ]),
      });
      // Cicilan tile sums only scheduled debts → 110.000.000 + 0.
      assert.equal(totals.totalMonthlyPaymentCents, 110_000_000);
      assert.equal(totals.tenorlessCount, 1);
    },
  },
  {
    name: "aggregateDebtTotals — paid-off excluded from remaining / monthly",
    run(): void {
      const paidOff = buildDebt({
        id: "paid",
        status: "paid_off",
        principalCents: 500_000_000,
        monthlyPaymentCents: 50_000_000,
      });
      const paidOffSummary = buildSummary({
        debtId: "paid",
        remainingPrincipalCents: 0,
        totalInterestPaidCents: 100_000_000,
        monthsRemaining: 0,
        nextPaymentDueDate: null,
      });
      const totals = aggregateDebtTotals({
        debts: [IDR_SAMPLE, paidOff],
        summaries: new Map([
          [IDR_SAMPLE.id, IDR_SUMMARY],
          [paidOff.id, paidOffSummary],
        ]),
      });
      // Remaining + monthly count only the active debt.
      assert.equal(totals.totalRemainingCents, 0);
      assert.equal(totals.totalMonthlyPaymentCents, 110_000_000);
      // The principal counter still includes the closed loan so the
      // user sees their full debt history.
      assert.equal(totals.totalPrincipalCents, 1_700_000_000);
      // Interest-paid counter tracks both the active debt's running
      // interest and the paid-off debt's lifetime interest — the
      // dashboard surfaces the user's total interest cost over time.
      assert.equal(totals.totalInterestPaidCents, 220_000_000);
      assert.equal(totals.paidOffCount, 1);
      assert.equal(totals.activeCount, 1);
    },
  },
  {
    name: "aggregateDebtTotals — missing summary handled gracefully",
    run(): void {
      // No summary available for IDR_SAMPLE yet (still in-flight):
      // remaining + interest-paid stay 0, monthly still comes from
      // the persisted `monthly_payment_cents`.
      const totals = aggregateDebtTotals({
        debts: [IDR_SAMPLE],
        summaries: new Map(),
      });
      assert.equal(totals.totalRemainingCents, 0);
      assert.equal(totals.totalInterestPaidCents, 0);
      assert.equal(totals.totalMonthlyPaymentCents, 110_000_000);
    },
  },
  // ------------------------------------------------------------------
  // Per-row state resolution (DEF-1 fix). The list page passes three
  // tracking slots down to the row component; the helper centralises
  // the classification so the row never has to interpret three
  // overlapping booleans.
  // ------------------------------------------------------------------
  {
    name: "resolveDebtRowState — summary present wins over pending + failed",
    run(): void {
      const state = resolveDebtRowState(
        "row-1",
        new Map([["row-1", IDR_SUMMARY]]),
        new Set(["row-1"]),
        new Set(["row-1"]),
      );
      assert.equal(state, "ready");
    },
  },
  {
    name: "resolveDebtRowState — pending fetch returns loading",
    run(): void {
      const state = resolveDebtRowState(
        "row-1",
        new Map(),
        new Set(["row-1"]),
        new Set(),
      );
      assert.equal(state, "loading");
    },
  },
  {
    name: "resolveDebtRowState — failed fetch returns failed",
    run(): void {
      const state = resolveDebtRowState(
        "row-1",
        new Map(),
        new Set(),
        new Set(["row-1"]),
      );
      assert.equal(state, "failed");
    },
  },
  {
    name: "resolveDebtRowState — failed wins over pending (defensive)",
    run(): void {
      // If both slots happen to contain the id (shouldn't occur in
      // production but the helper is total-ordered regardless), the
      // failure takes precedence so the row renders the skeleton
      // rather than a "Memuat ringkasan…" placeholder that's about to
      // be re-rendered as a failure anyway.
      const state = resolveDebtRowState(
        "row-1",
        new Map(),
        new Set(["row-1"]),
        new Set(["row-1"]),
      );
      assert.equal(state, "failed");
    },
  },
  {
    name: "resolveDebtRowState — fallback when row is in none of the slots",
    run(): void {
      // Defensive: shouldn't happen in production (the row was either
      // just removed by a filter change or the slots haven't been
      // seeded yet). Returning "ready" prevents the skeleton from
      // rendering forever.
      const state = resolveDebtRowState(
        "row-1",
        new Map(),
        new Set(),
        new Set(),
      );
      assert.equal(state, "ready");
    },
  },
];

export function runDebtHelperTests(): {
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
  process.env["DEBT_HELPERS_TEST_RUN"] === "1"
) {
  const result = runDebtHelperTests();
  if (result.failed > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `[debt-helpers.test] ${result.failed} of ${result.failed + result.passed} failed`,
    );
    for (const failure of result.failures) {
      // eslint-disable-next-line no-console
      console.error(`  - ${failure.name}`);
      // eslint-disable-next-line no-console
      console.error(`      ${(failure.error as Error)?.stack ?? failure.error}`);
    }
    process.exitCode = 1;
  } else {
    // eslint-disable-next-line no-console
    console.log(
      `[debt-helpers.test] ${result.passed} cases passed`,
    );
  }
}