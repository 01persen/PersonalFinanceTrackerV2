/**
 * sub-0007-02 — unit tests for the dashboard client.
 *
 * The `apps/web` package does not currently ship a Jest/Vitest runner
 * (mirrors the convention used by sub-0005-03 / sub-0006-04). Until a
 * runner lands, this file runs as a plain Node test:
 *
 *   DASHBOARD_CLIENT_TEST_RUN=1 node --import tsx \
 *     apps/web/src/__tests__/dashboard/dashboard-client.test.ts
 *
 * We cover two surfaces that the spec calls out explicitly:
 *
 *   1. **Adapter race defense** — the `adapt*` helpers reject
 *      malformed / partial payloads (returns `null`) so a stale or
 *      partial response can never silently flip the dashboard into a
 *      misleading ready state. The page treats a `null` adapter
 *      return as the error-retry path.
 *
 *   2. **AbortController + fetch** — `fetchDashboardSummary` propagates
 *      the `AbortSignal` to the underlying fetch so navigating away or
 *      a rapid re-render cancels the request before it lands. We
 *      exercise this by stubbing `globalThis.fetch` with a deferred
 *      promise that rejects on abort.
 *
 * Every assertion below corresponds 1:1 to an `it(...)` case so the
 * file is portable to `describe` / `it` once a Jest config lands.
 */

import assert from "node:assert/strict";

import {
  adaptDashboardDebtsSummary,
  adaptDashboardGoalsProgress,
  adaptDashboardIncomeExpenseTrend,
  adaptDashboardNetworthTrend,
  adaptDashboardSummary,
  adaptDashboardTopCategories,
  fetchDashboardSummary,
} from "@/lib/dashboard/dashboard-client";

interface SyncTestCase {
  name: string;
  run(): void;
  async?: false;
}

interface AsyncTestCase {
  name: string;
  run(): Promise<void>;
  async: true;
}

const VALID_SUMMARY = {
  currency: "IDR",
  networth_cents: 2_500_000_000,
  total_assets_cents: 5_000_000_000,
  total_liabilities_cents: 2_500_000_000,
  income_this_month_cents: 1_200_000_000,
  expense_this_month_cents: 800_000_000,
  emergency_fund_avg_pct: 65.0,
};

const syncTestCases: SyncTestCase[] = [
  {
    name: "adaptDashboardSummary — valid payload → typed summary",
    run(): void {
      const adapted = adaptDashboardSummary(VALID_SUMMARY);
      assert.ok(adapted, "valid payload must adapt");
      assert.equal(adapted.networthCents, 2_500_000_000);
      assert.equal(adapted.emergencyFundAvgPct, 65.0);
    },
  },
  {
    name: "adaptDashboardSummary — null emergency_fund_avg_pct is preserved",
    run(): void {
      const adapted = adaptDashboardSummary({
        ...VALID_SUMMARY,
        emergency_fund_avg_pct: null,
      });
      assert.ok(adapted);
      assert.equal(adapted.emergencyFundAvgPct, null);
    },
  },
  {
    name: "adaptDashboardSummary — null payload → null (race-defense)",
    run(): void {
      assert.equal(adaptDashboardSummary(null), null);
      assert.equal(adaptDashboardSummary(undefined), null);
      assert.equal(adaptDashboardSummary("not an object"), null);
    },
  },
  {
    name: "adaptDashboardSummary — missing currency → null (sentinel)",
    run(): void {
      const { currency: _currency, ...rest } = VALID_SUMMARY;
      void _currency;
      // The BE always returns `currency`, so its absence is a
      // malformed payload. Adapters must surface that as `null` so
      // the page flips to the error-retry path.
      assert.equal(adaptDashboardSummary(rest), null);
    },
  },
  {
    name: "adaptDashboardSummary — string-encoded cents (defensive) parse",
    run(): void {
      // Some BE deployments (or reverse proxies) stringify numbers.
      // The adapter must coerce without throwing.
      const adapted = adaptDashboardSummary({
        ...VALID_SUMMARY,
        networth_cents: "1000000",
        total_assets_cents: "2000000",
      });
      assert.ok(adapted);
      assert.equal(adapted.networthCents, 1_000_000);
      assert.equal(adapted.totalAssetsCents, 2_000_000);
    },
  },
  {
    name: "adaptDashboardNetworthTrend — valid data → typed points",
    run(): void {
      const adapted = adaptDashboardNetworthTrend({
        data: [
          { month: "2026-01", networth_cents: 1_000_000 },
          { month: "2026-02", networth_cents: 1_500_000 },
        ],
      });
      assert.ok(adapted);
      assert.equal(adapted.data.length, 2);
      assert.equal(adapted.data[0]?.month, "2026-01");
      assert.equal(adapted.data[1]?.networthCents, 1_500_000);
    },
  },
  {
    name: "adaptDashboardNetworthTrend — malformed point (bad month) skipped",
    run(): void {
      const adapted = adaptDashboardNetworthTrend({
        data: [
          { month: "2026-01", networth_cents: 1_000_000 },
          { month: "2026-bad", networth_cents: 0 },
          { month: "2026-02", networth_cents: 1_500_000 },
        ],
      });
      assert.ok(adapted);
      // The malformed point must NOT silently land in the typed shape;
      // it's dropped, not coerced.
      assert.equal(adapted.data.length, 2);
    },
  },
  {
    name: "adaptDashboardGoalsProgress — unknown goal status → null goal",
    run(): void {
      const adapted = adaptDashboardGoalsProgress({
        data: [
          {
            goal_id: "00000000-0000-0000-0000-000000000001",
            name: "Dana Darurat",
            kind: "emergency_fund",
            current_cents: 1_000_000,
            target_cents: 5_000_000,
            pct: 20,
            status: "active",
            due_date: null,
          },
          {
            goal_id: "00000000-0000-0000-0000-000000000002",
            name: "Bad status",
            kind: "saving",
            current_cents: 0,
            target_cents: 1_000_000,
            pct: 0,
            status: "totally-not-a-status",
            due_date: null,
          },
        ],
      });
      assert.ok(adapted);
      assert.equal(adapted.data.length, 1);
      assert.equal(adapted.data[0]?.name, "Dana Darurat");
    },
  },
  {
    name: "adaptDashboardDebtsSummary — missing sentinel fields → null",
    run(): void {
      // The debts summary has no `currency` style sentinel, so we
      // require all four numeric fields to be present. Missing any
      // of them → null (page flips to error).
      assert.equal(
        adaptDashboardDebtsSummary({
          total_remaining_cents: 0,
          total_interest_paid_cents: 0,
          active_count: 0,
        }),
        null,
      );
    },
  },
  {
    name: "adaptDashboardTopCategories — null category_id allowed",
    run(): void {
      // The BE surfaces `(category_id=null)` for un-categorised
      // expenses. The adapter must keep the row (the FE renders it
      // under "Tanpa nama" per AC sub-0007-08).
      const adapted = adaptDashboardTopCategories({
        data: [
          {
            category_id: null,
            category_name: null,
            total_cents: 500_000,
            percentage: 100,
          },
        ],
      });
      assert.ok(adapted);
      assert.equal(adapted.data.length, 1);
      assert.equal(adapted.data[0]?.categoryId, null);
    },
  },
  {
    name: "adaptDashboardIncomeExpenseTrend — empty data array stays empty",
    run(): void {
      const adapted = adaptDashboardIncomeExpenseTrend({ data: [] });
      assert.ok(adapted);
      assert.equal(adapted.data.length, 0);
    },
  },
];

const asyncTestCases: AsyncTestCase[] = [
  {
    name: "fetchDashboardSummary — pre-aborted signal rejects (race defense)",
    async: true,
    async run(): Promise<void> {
      const originalFetch = globalThis.fetch;
      const calls: Array<{ url: string; aborted: boolean }> = [];
      globalThis.fetch = (async (
        input: RequestInfo | URL,
        init: RequestInit = {},
      ): Promise<Response> => {
        const url = typeof input === "string" ? input : input.toString();
        return new Promise<Response>((resolve, reject) => {
          if (init.signal?.aborted) {
            calls.push({ url, aborted: true });
            reject(new DOMException("aborted", "AbortError"));
            return;
          }
          init.signal?.addEventListener("abort", () => {
            calls.push({ url, aborted: true });
            reject(new DOMException("aborted", "AbortError"));
          });
          // Never resolves unless aborted — the assertion is on the
          // abort path only.
          setTimeout(() => resolve(new Response("{}", { status: 200 })), 1000);
        });
      }) as typeof globalThis.fetch;

      try {
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(
          fetchDashboardSummary({ signal: controller.signal }),
          (err: unknown) => err instanceof Error,
        );
        assert.equal(calls.length, 1, "fetch should be called once");
        assert.equal(calls[0]?.aborted, true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  },
];

export async function runDashboardClientTests(): Promise<{
  passed: number;
  failed: number;
  failures: { name: string; error: unknown }[];
}> {
  let passed = 0;
  let failed = 0;
  const failures: { name: string; error: unknown }[] = [];

  for (const tc of syncTestCases) {
    try {
      tc.run();
      passed += 1;
    } catch (error) {
      failed += 1;
      failures.push({ name: tc.name, error });
    }
  }

  for (const tc of asyncTestCases) {
    try {
      await tc.run();
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
  process.env["DASHBOARD_CLIENT_TEST_RUN"] === "1"
) {
  void runDashboardClientTests().then((result) => {
    if (result.failed > 0) {
      console.error(
        `[dashboard-client.test] ${result.failed} of ${result.failed + result.passed} failed`,
      );
      for (const failure of result.failures) {
        console.error(`  - ${failure.name}`);
        console.error(`      ${(failure.error as Error)?.stack ?? failure.error}`);
      }
      process.exitCode = 1;
    } else {
      console.log(`[dashboard-client.test] ${result.passed} cases passed`);
    }
  });
}
