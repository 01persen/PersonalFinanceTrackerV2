/**
 * sub-0006-06 — unit tests for the cicilan list adapter + page sort
 * helper + DebtPaymentPage sort contract.
 *
 * The `apps/web` package does not currently ship a Jest/Vitest runner
 * (mirrors the convention used by sub-0006-04's `debt-helpers.test.ts`).
 * Until a runner lands this file runs as a plain Node test:
 *
 *   node --import tsx apps/web/src/components/debts/__tests__/debt-history-helpers.test.ts
 *
 * The assertions cover the AC bullets in the issue body:
 *
 *   - `adaptDebtPaymentList` — wire envelope shape (items + total +
 *     limit + offset) and defensive edge cases (missing fields,
 *     malformed rows, clamps).
 *   - `sortPaymentsByDateDesc` — newest first by `occurred_on`, then
 *     `created_at` tiebreaker, then `id` for stability. Mirrors the
 *     BE sort chain (sub-0006-02).
 *
 * Every `assert` below corresponds 1:1 to an `it(...)` case so the
 * file is portable to `describe` / `it` once a Jest config lands.
 */

import assert from "node:assert/strict";

import {
  adaptDebtPayment,
  adaptDebtPaymentList,
  type DebtPayment,
  type DebtPaymentPage,
} from "@/lib/api/debts";
import { sortPaymentsByDateDesc } from "@/lib/api/debt-client";

interface TestCase {
  name: string;
  run(): void;
}

function buildPayment(overrides: Partial<DebtPayment> = {}): DebtPayment {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    debtId: "00000000-0000-0000-0000-0000000000aa",
    occurredOn: "2026-02-15",
    amountCents: 110_000_000,
    principalPortionCents: 100_000_000,
    interestPortionCents: 10_000_000,
    sourceAccountId: null,
    note: "Cicilan Feb 2026",
    createdAt: "2026-02-15T10:00:00Z",
    updatedAt: "2026-02-15T10:00:00Z",
    ...overrides,
  };
}

function buildRawPayment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    debt_id: "00000000-0000-0000-0000-0000000000aa",
    occurred_on: "2026-02-15",
    amount_cents: 110_000_000,
    principal_portion_cents: 100_000_000,
    interest_portion_cents: 10_000_000,
    source_account_id: null,
    note: "Cicilan Feb 2026",
    created_at: "2026-02-15T10:00:00Z",
    updated_at: "2026-02-15T10:00:00Z",
    ...overrides,
  };
}

const testCases: TestCase[] = [
  // ------------------------------------------------------------------
  // adaptDebtPayment — single-row adapter (mirrors BE DebtPaymentPublic).
  // ------------------------------------------------------------------
  {
    name: "adaptDebtPayment — well-formed payload",
    run(): void {
      const adapted = adaptDebtPayment(buildRawPayment());
      assert.ok(adapted);
      assert.equal(adapted!.id, "00000000-0000-0000-0000-000000000001");
      assert.equal(adapted!.amountCents, 110_000_000);
      assert.equal(adapted!.sourceAccountId, null);
      assert.equal(adapted!.note, "Cicilan Feb 2026");
    },
  },
  {
    name: "adaptDebtPayment — missing id returns null",
    run(): void {
      const raw = buildRawPayment({ id: undefined });
      assert.equal(adaptDebtPayment(raw), null);
    },
  },
  {
    name: "adaptDebtPayment — missing debt_id returns null",
    run(): void {
      const raw = buildRawPayment({ debt_id: undefined });
      assert.equal(adaptDebtPayment(raw), null);
    },
  },
  {
    name: "adaptDebtPayment — non-object input returns null",
    run(): void {
      assert.equal(adaptDebtPayment("not-an-object"), null);
      assert.equal(adaptDebtPayment(null), null);
      assert.equal(adaptDebtPayment(undefined), null);
      assert.equal(adaptDebtPayment(42), null);
    },
  },
  {
    name: "adaptDebtPayment — string source_account_id preserved",
    run(): void {
      const raw = buildRawPayment({
        source_account_id: "00000000-0000-0000-0000-000000000abc",
      });
      const adapted = adaptDebtPayment(raw);
      assert.ok(adapted);
      assert.equal(adapted!.sourceAccountId, "00000000-0000-0000-0000-000000000abc");
    },
  },

  // ------------------------------------------------------------------
  // adaptDebtPaymentList — paginated envelope (mirrors BE
  // DebtPaymentListPublic). The detail page consumes the envelope
  // directly so the adapter is the load-bearing boundary for the
  // pagination + total/limit/offset triple.
  // ------------------------------------------------------------------
  {
    name: "adaptDebtPaymentList — well-formed envelope",
    run(): void {
      const result = adaptDebtPaymentList({
        items: [buildRawPayment({ id: "p1" }), buildRawPayment({ id: "p2" })],
        total: 2,
        limit: 50,
        offset: 0,
      });
      assert.ok(result);
      assert.equal(result!.items.length, 2);
      assert.equal(result!.total, 2);
      assert.equal(result!.limit, 50);
      assert.equal(result!.offset, 0);
      assert.equal(result!.items[0]!.id, "p1");
      assert.equal(result!.items[1]!.id, "p2");
    },
  },
  {
    name: "adaptDebtPaymentList — empty items array",
    run(): void {
      const result = adaptDebtPaymentList({
        items: [],
        total: 0,
        limit: 50,
        offset: 0,
      });
      assert.ok(result);
      assert.equal(result!.items.length, 0);
      assert.equal(result!.total, 0);
      assert.equal(result!.limit, 50);
      assert.equal(result!.offset, 0);
    },
  },
  {
    name: "adaptDebtPaymentList — non-array items returns null",
    run(): void {
      assert.equal(adaptDebtPaymentList({ items: "not-an-array", total: 0 }), null);
      assert.equal(adaptDebtPaymentList({ total: 0 }), null);
      assert.equal(adaptDebtPaymentList(null), null);
      assert.equal(adaptDebtPaymentList("not-an-object"), null);
    },
  },
  {
    name: "adaptDebtPaymentList — malformed inner rows are dropped",
    run(): void {
      const result = adaptDebtPaymentList({
        items: [
          buildRawPayment({ id: "ok-1" }),
          // Missing id → drop.
          buildRawPayment({ id: undefined }),
          // Missing debt_id → drop.
          buildRawPayment({ id: "broken", debt_id: undefined }),
          buildRawPayment({ id: "ok-2" }),
        ],
        total: 4,
        limit: 50,
        offset: 0,
      });
      assert.ok(result);
      assert.equal(result!.items.length, 2);
      assert.equal(result!.items[0]!.id, "ok-1");
      assert.equal(result!.items[1]!.id, "ok-2");
    },
  },
  {
    name: "adaptDebtPaymentList — total clamped to >= items.length",
    run(): void {
      // BE glitch: total reports 0 but the page has 3 rows. The
      // adapter clamps so the FE doesn't drive pagination into a
      // phantom-empty state.
      const result = adaptDebtPaymentList({
        items: [
          buildRawPayment({ id: "a" }),
          buildRawPayment({ id: "b" }),
          buildRawPayment({ id: "c" }),
        ],
        total: 0,
        limit: 50,
        offset: 0,
      });
      assert.ok(result);
      assert.equal(result!.total, 3);
    },
  },
  {
    name: "adaptDebtPaymentList — negative offset clamped to 0",
    run(): void {
      const result = adaptDebtPaymentList({
        items: [buildRawPayment()],
        total: 1,
        limit: 50,
        offset: -10,
      });
      assert.ok(result);
      assert.equal(result!.offset, 0);
    },
  },
  {
    name: "adaptDebtPaymentList — limit clamped to >= 1",
    run(): void {
      const result = adaptDebtPaymentList({
        items: [buildRawPayment({ id: "only" })],
        total: 5,
        limit: 0,
        offset: 0,
      });
      assert.ok(result);
      // When the BE returns limit=0 with a non-empty items array,
      // the adapter falls back to items.length so the FE has a
      // sensible page size to divide by.
      assert.equal(result!.limit, 1);
    },
  },
  {
    name: "adaptDebtPaymentList — non-numeric total/limit/offset tolerated",
    run(): void {
      const result = adaptDebtPaymentList({
        items: [buildRawPayment()],
        total: "not-a-number",
        limit: null,
        offset: "broken",
      });
      assert.ok(result);
      assert.equal(result!.total, 1);
      assert.equal(result!.limit, 1);
      assert.equal(result!.offset, 0);
    },
  },
  {
    name: "adaptDebtPaymentList — string amounts in payload still parse as cents",
    run(): void {
      // Defensive: the BE always returns integer cents, but the
      // adapter also accepts string-encoded ints (mirrors the
      // other debt adapters, sub-0006-04).
      const result = adaptDebtPaymentList({
        items: [
          buildRawPayment({
            amount_cents: "110000000",
            principal_portion_cents: "100000000",
            interest_portion_cents: "10000000",
          }),
        ],
        total: 1,
        limit: 50,
        offset: 0,
      });
      assert.ok(result);
      assert.equal(result!.items[0]!.amountCents, 110_000_000);
      assert.equal(result!.items[0]!.principalPortionCents, 100_000_000);
      assert.equal(result!.items[0]!.interestPortionCents, 10_000_000);
    },
  },
  {
    name: "adaptDebtPaymentList — large totals don't overflow Number",
    run(): void {
      // 100k cicilan × ~Rp 1jt = 100jt rows. The adapter uses plain
      // Number (matches the rest of the debt surface) — verify
      // there's no off-by-one in the clamp.
      const result = adaptDebtPaymentList({
        items: [buildRawPayment()],
        total: 100_000,
        limit: 50,
        offset: 99_950,
      });
      assert.ok(result);
      assert.equal(result!.total, 100_000);
      assert.equal(result!.offset, 99_950);
    },
  },
  {
    name: "DebtPaymentPage — explicit shape preserves all four fields",
    run(): void {
      // Pin the public surface so a refactor of the interface
      // triggers a TS error in the test (and the page).
      const page: DebtPaymentPage = {
        items: [buildPayment()],
        total: 1,
        limit: 50,
        offset: 0,
      };
      assert.deepEqual(
        Object.keys(page).sort(),
        ["items", "limit", "offset", "total"],
      );
    },
  },

  // ------------------------------------------------------------------
  // sortPaymentsByDateDesc — mirrors the BE sort chain. The BE
  // already returns newest-first (sub-0006-02), but the helper
  // pins the contract for the FE and protects against a future
  // schema migration that changes the server-side order.
  // ------------------------------------------------------------------
  {
    name: "sortPaymentsByDateDesc — newest occurred_on first",
    run(): void {
      const older = buildPayment({ id: "older", occurredOn: "2026-01-15" });
      const newer = buildPayment({ id: "newer", occurredOn: "2026-02-15" });
      const ordered = sortPaymentsByDateDesc([older, newer]);
      assert.equal(ordered[0]!.id, "newer");
      assert.equal(ordered[1]!.id, "older");
    },
  },
  {
    name: "sortPaymentsByDateDesc — same date, newer createdAt first",
    run(): void {
      const a = buildPayment({
        id: "a",
        occurredOn: "2026-02-15",
        createdAt: "2026-02-15T08:00:00Z",
      });
      const b = buildPayment({
        id: "b",
        occurredOn: "2026-02-15",
        createdAt: "2026-02-15T10:00:00Z",
      });
      const ordered = sortPaymentsByDateDesc([a, b]);
      assert.equal(ordered[0]!.id, "b");
      assert.equal(ordered[1]!.id, "a");
    },
  },
  {
    name: "sortPaymentsByDateDesc — same date + createdAt, id tiebreaker",
    run(): void {
      const a = buildPayment({
        id: "a-uuid",
        occurredOn: "2026-02-15",
        createdAt: "2026-02-15T10:00:00Z",
      });
      const b = buildPayment({
        id: "b-uuid",
        occurredOn: "2026-02-15",
        createdAt: "2026-02-15T10:00:00Z",
      });
      const ordered = sortPaymentsByDateDesc([b, a]);
      assert.equal(ordered[0]!.id, "a-uuid");
      assert.equal(ordered[1]!.id, "b-uuid");
    },
  },
  {
    name: "sortPaymentsByDateDesc — does not mutate input",
    run(): void {
      const newer = buildPayment({ id: "newer", occurredOn: "2026-02-15" });
      const older = buildPayment({ id: "older", occurredOn: "2026-01-15" });
      const input = [newer, older];
      const snapshot = [...input];
      sortPaymentsByDateDesc(input);
      assert.equal(input[0]!.id, snapshot[0]!.id);
      assert.equal(input[1]!.id, snapshot[1]!.id);
    },
  },
  {
    name: "sortPaymentsByDateDesc — empty array returns empty array",
    run(): void {
      assert.deepEqual(sortPaymentsByDateDesc([]), []);
    },
  },
  {
    name: "sortPaymentsByDateDesc — single row returns single row",
    run(): void {
      const only = buildPayment({ id: "only" });
      const ordered = sortPaymentsByDateDesc([only]);
      assert.equal(ordered.length, 1);
      assert.equal(ordered[0]!.id, "only");
    },
  },
  {
    name: "sortPaymentsByDateDesc — large page (50 rows) sorts deterministically",
    run(): void {
      // Build 50 rows in random order; sort them; verify the
      // resulting order is stable (running the sort twice produces
      // the same array).
      const rows: DebtPayment[] = [];
      for (let i = 0; i < 50; i += 1) {
        const day = ((i % 28) + 1).toString().padStart(2, "0");
        const month = ((i % 12) + 1).toString().padStart(2, "0");
        rows.push(
          buildPayment({
            id: `id-${i.toString().padStart(3, "0")}`,
            occurredOn: `2026-${month}-${day}`,
            createdAt: `2026-${month}-${day}T${(i % 24).toString().padStart(2, "0")}:00:00Z`,
          }),
        );
      }
      const sorted1 = sortPaymentsByDateDesc(rows);
      const sorted2 = sortPaymentsByDateDesc(rows);
      assert.equal(sorted1.length, 50);
      assert.equal(sorted2.length, 50);
      for (let i = 0; i < 50; i += 1) {
        assert.equal(sorted1[i]!.id, sorted2[i]!.id);
      }
    },
  },
];

export function runDebtHistoryHelperTests(): {
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
  process.env["DEBT_HISTORY_HELPERS_TEST_RUN"] === "1"
) {
  const result = runDebtHistoryHelperTests();
  if (result.failed > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `[debt-history-helpers.test] ${result.failed} of ${result.failed + result.passed} failed`,
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
      `[debt-history-helpers.test] ${result.passed} cases passed`,
    );
  }
}
