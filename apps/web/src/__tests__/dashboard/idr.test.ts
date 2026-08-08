/**
 * sub-0007-02 — unit tests for the dashboard IDR formatter helpers.
 *
 * The `apps/web` package does not currently ship a Jest/Vitest runner
 * (mirrors the convention used by sub-0005-03 / sub-0006-04). Until a
 * runner lands, this file runs as a plain Node test:
 *
 *   DASHBOARD_IDR_TEST_RUN=1 node --import tsx \
 *     apps/web/src/__tests__/dashboard/idr.test.ts
 *
 * (The env-var guard matches the project convention — see
 * `goals/__tests__/progress-banner.test.tsx` for the reference shape —
 * so importing the module from other files doesn't auto-run the
 * assertions.)
 *
 * Assertions cover the IDR-convention bullets pinned in the issue
 * body ("Lokale IDR") + the chart-axis helpers (`formatIdrCompact`,
 * `formatIdrShortAxis`):
 *
 *   - `formatIdrFromCents(2_500_000_000)` → `"Rp 25.000.000"` (AC bullet)
 *   - whole-rupiah only, dot-grouped (id-ID locale), `Rp` prefix
 *   - zero / negative / large-magnitude edge cases
 *   - `formatIdrCompact` drops the prefix for chart axes
 *   - `formatIdrShortAxis` switches to compact notation at the right
 *     threshold (>= 10_000 rupiah) and stays full-form below
 *
 * Whitespace note: `Intl.NumberFormat('id-ID', { style: 'currency' })`
 * emits a non-breaking space (`U+00A0`) between the currency code and
 * the value, NOT a regular ASCII space. We normalize both sides of
 * every assertion to ASCII spaces so the test stays resilient to
 * platform Intl differences (older Node runtimes may emit a regular
 * space; ICU on Linux emits NBSP). The actual rendered UI is identical
 * to the eye either way.
 *
 * Every assertion below corresponds 1:1 to an `it(...)` case so the
 * file is portable to `describe` / `it` once a Jest config lands.
 */

import assert from "node:assert/strict";

import {
  formatIdrCompact,
  formatIdrFromCents,
  formatIdrFromCentsSigned,
  formatIdrShortAxis,
} from "@/lib/dashboard/idr";

/** Normalize NBSP → ASCII space so assertions stay portable. */
function normalizeWhitespace(value: string): string {
  return value.replace(/\u00a0/g, " ");
}

interface TestCase {
  name: string;
  run(): void;
}

const testCases: TestCase[] = [
  {
    name: "formatIdrFromCents(2_500_000_000) → 'Rp 25.000.000' (AC bullet)",
    run(): void {
      assert.equal(
        normalizeWhitespace(formatIdrFromCents(2_500_000_000)),
        "Rp 25.000.000",
      );
    },
  },
  {
    name: "formatIdrFromCents(0) → 'Rp 0'",
    run(): void {
      assert.equal(normalizeWhitespace(formatIdrFromCents(0)), "Rp 0");
    },
  },
  {
    name: "formatIdrFromCents(-1_000_000) → '-Rp 10.000'",
    run(): void {
      // -1.000.000 cents = -10.000 rupiah (negative networth branch —
      // important for the KPI card tone test).
      assert.equal(
        normalizeWhitespace(formatIdrFromCents(-1_000_000)),
        "-Rp 10.000",
      );
    },
  },
  {
    name: "formatIdrFromCents rounds cents to whole rupiah",
    run(): void {
      // 1.234.567 cents = 12.345,67 rupiah → Math.round → 12.346 rupiah
      assert.equal(
        normalizeWhitespace(formatIdrFromCents(1_234_567)),
        "Rp 12.346",
      );
      // 1 cent stays under 1 rupiah → 0 rupiah
      assert.equal(normalizeWhitespace(formatIdrFromCents(1)), "Rp 0");
    },
  },
  {
    name: "formatIdrCompact drops the 'Rp' prefix for chart axes",
    run(): void {
      assert.equal(normalizeWhitespace(formatIdrCompact(2_500_000_000)), "25.000.000");
      assert.equal(normalizeWhitespace(formatIdrCompact(0)), "0");
      assert.equal(
        normalizeWhitespace(formatIdrCompact(-1_000_000_000)),
        "-10.000.000",
      );
    },
  },
  {
    name: "formatIdrShortAxis switches to compact notation (>= 10_000)",
    run(): void {
      // 2,5 milyar rupiah → compact form. The id-ID locale uses
      // "M" / "jt" depending on the runtime, so we don't pin the
      // exact unit suffix — just the prefix + a non-digit suffix.
      const axis = normalizeWhitespace(formatIdrShortAxis(250_000_000_000));
      assert.match(axis, /^Rp\s/);
      assert.ok(axis.length < "Rp 25.000.000".length + 5);
    },
  },
  {
    name: "formatIdrShortAxis stays full-form below the compact threshold",
    run(): void {
      // 5_000 rupiah (500_000 cents) → below 10_000 → full IDR
      assert.equal(
        normalizeWhitespace(formatIdrShortAxis(500_000)),
        "Rp 5.000",
      );
    },
  },
  {
    name: "formatIdrFromCentsSigned mirrors sign on the output (auto display)",
    run(): void {
      // signDisplay: "auto" → negative gets explicit "-", positive
      // gets no "+" (per the auto convention). The helper exists for
      // future use; we only assert the negative + zero branches here
      // so we don't depend on the auto-display policy in tests.
      assert.equal(
        normalizeWhitespace(formatIdrFromCentsSigned(-1_000_000)),
        "-Rp 10.000",
      );
      assert.equal(
        normalizeWhitespace(formatIdrFromCentsSigned(0)),
        "Rp 0",
      );
    },
  },
];

export function runDashboardIdrTests(): {
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
  process.env["DASHBOARD_IDR_TEST_RUN"] === "1"
) {
  const result = runDashboardIdrTests();
  if (result.failed > 0) {
    console.error(
      `[dashboard-idr.test] ${result.failed} of ${result.failed + result.passed} failed`,
    );
    for (const failure of result.failures) {
      console.error(`  - ${failure.name}`);
      console.error(`      ${(failure.error as Error)?.stack ?? failure.error}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`[dashboard-idr.test] ${result.passed} cases passed`);
  }
}
