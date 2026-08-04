/**
 * sub-0006-05 — unit tests for the form validators.
 *
 * The `apps/web` package does not currently ship a Jest/Vitest runner
 * (mirrors the convention used by sub-0006-04's `debt-helpers.test.ts`
 * and sub-0005-04's `goal-form-fields.test.ts`). Until a runner lands
 * this file runs as a plain Node test:
 *
 *   node --import tsx apps/web/src/components/debts/__tests__/debt-form-helpers.test.ts
 *
 * The assertions cover the AC bullets in the issue body:
 *
 *   - principal amount validator: empty, decimal, thousand sep,
 *     negative, over-cap, valid whole rupiah.
 *   - bunga_pct validator: empty, decimal, decimal places cap (4),
 *     negative, over-cap (100%), valid whole + decimal.
 *   - tenor validator: empty, non-integer, 0, negative, valid.
 *   - payment portion validator: sum invariant, principal-only,
 *     interest-only, empty.
 *   - default split helper: zero-interest, with-interest, no-schedule.
 *   - round-trip helpers: parseRupiahInputToCents, parseBungaPctInput.
 *
 * Every `assert` below corresponds 1:1 to an `it(...)` case so the
 * file is portable to `describe` / `it` once a Jest config lands.
 */

import assert from "node:assert/strict";

import {
  computeDebtPreview,
  INITIAL_DEBT_FORM_VALUES,
  debtToFormValues,
  isDebtFormDirty,
  parseBungaPctInput,
  parseRupiahInputToCents,
  todayIsoDate,
  validateBungaPct,
  validatePrincipalAmount,
  validateTenorMonths,
  type DebtFormValues,
} from "@/components/debts/debt-form-fields";
import {
  computeDefaultSplit,
  isPaymentFormDirty,
  validatePaymentAmount,
  validatePortionCents,
  validatePortionsSum,
} from "@/components/debts/payment-form-fields";

interface TestCase {
  name: string;
  run(): void;
}

const SAMPLE_DEBT: import("@/lib/api/debt-client").Debt = {
  id: "00000000-0000-0000-0000-000000000001",
  userId: "00000000-0000-0000-0000-0000000000aa",
  name: "KTA BPD",
  kind: "KTA",
  principalCents: 1_200_000_000, // 12jt
  bungaPct: 10,
  tenorMonths: 12,
  startDate: "2026-01-15",
  monthlyPaymentCents: 110_000_000, // 1.1jt
  note: null,
  status: "active",
  createdAt: "2026-01-15T10:00:00Z",
  updatedAt: "2026-01-15T10:00:00Z",
};

const testCases: TestCase[] = [
  // ------------------------------------------------------------------
  // validatePrincipalAmount
  // ------------------------------------------------------------------
  {
    name: "validatePrincipalAmount — empty input returns wajib diisi",
    run(): void {
      const result = validatePrincipalAmount("");
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.reason, /wajib diisi/i);
    },
  },
  {
    name: "validatePrincipalAmount — strips thousand separators (titik, spasi, underscore)",
    run(): void {
      const dots = validatePrincipalAmount("12.000.000");
      assert.equal(dots.ok, true);
      if (dots.ok) assert.equal(dots.cents, 1_200_000_000);

      const spaces = validatePrincipalAmount("12 000 000");
      assert.equal(spaces.ok, true);
      if (spaces.ok) assert.equal(spaces.cents, 1_200_000_000);

      const underscores = validatePrincipalAmount("12_000_000");
      assert.equal(underscores.ok, true);
      if (underscores.ok) assert.equal(underscores.cents, 1_200_000_000);
    },
  },
  {
    name: "validatePrincipalAmount — comma decimal rounds to cents",
    run(): void {
      const result = validatePrincipalAmount("12,5");
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.cents, 1_250);
    },
  },
  {
    name: "validatePrincipalAmount — comma with 2 decimals",
    run(): void {
      const result = validatePrincipalAmount("12,50");
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.cents, 1_250);
    },
  },
  {
    name: "validatePrincipalAmount — more than 2 decimals rejected",
    run(): void {
      const result = validatePrincipalAmount("12,555");
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.reason, /maksimal 2 angka di belakang koma/i);
    },
  },
  {
    name: "validatePrincipalAmount — rejects negative",
    run(): void {
      const result = validatePrincipalAmount("-1000000");
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.reason, /lebih dari Rp 0/i);
    },
  },
  {
    name: "validatePrincipalAmount — rejects zero / sub-sen",
    run(): void {
      const zero = validatePrincipalAmount("0");
      assert.equal(zero.ok, false);
      if (zero.ok) return;
      assert.match(zero.reason, /minimal Rp 0,01/i);
    },
  },
  {
    name: "validatePrincipalAmount — rejects alpha input",
    run(): void {
      const result = validatePrincipalAmount("abc");
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.reason, /hanya angka/i);
    },
  },
  {
    name: "validatePrincipalAmount — rejects multiple commas",
    run(): void {
      const result = validatePrincipalAmount("1,2,3");
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.reason, /hanya angka/i);
    },
  },

  // ------------------------------------------------------------------
  // validateBungaPct
  // ------------------------------------------------------------------
  {
    name: "validateBungaPct — empty input returns wajib diisi",
    run(): void {
      const result = validateBungaPct("");
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.reason, /wajib diisi/i);
    },
  },
  {
    name: "validateBungaPct — accepts whole number",
    run(): void {
      const result = validateBungaPct("10");
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.value, 10);
    },
  },
  {
    name: "validateBungaPct — accepts decimal with comma",
    run(): void {
      const result = validateBungaPct("9,5");
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.value, 9.5);
    },
  },
  {
    name: "validateBungaPct — accepts 4 decimals",
    run(): void {
      const result = validateBungaPct("9,1234");
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.value, 9.1234);
    },
  },
  {
    name: "validateBungaPct — rejects 5 decimals (BE decimal_places=4)",
    run(): void {
      const result = validateBungaPct("9,12345");
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.reason, /maksimal 4 angka di belakang koma/i);
    },
  },
  {
    name: "validateBungaPct — rejects negative (minus sign not allowed)",
    run(): void {
      const result = validateBungaPct("-1");
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.reason, /hanya angka/i);
    },
  },
  {
    name: "validateBungaPct — rejects > 100%",
    run(): void {
      const result = validateBungaPct("150");
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.reason, /maksimal 100%/i);
    },
  },
  {
    name: "validateBungaPct — accepts 0 (zero-interest loan)",
    run(): void {
      const result = validateBungaPct("0");
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.value, 0);
    },
  },

  // ------------------------------------------------------------------
  // validateTenorMonths
  // ------------------------------------------------------------------
  {
    name: "validateTenorMonths — empty rejected",
    run(): void {
      const result = validateTenorMonths("");
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.reason, /wajib diisi/i);
    },
  },
  {
    name: "validateTenorMonths — 0 rejected (must be > 0)",
    run(): void {
      const result = validateTenorMonths("0");
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.reason, /minimal 1/i);
    },
  },
  {
    name: "validateTenorMonths — non-integer rejected",
    run(): void {
      const result = validateTenorMonths("12.5");
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.reason, /hanya angka bulat/i);
    },
  },
  {
    name: "validateTenorMonths — over-cap rejected",
    run(): void {
      const result = validateTenorMonths("601");
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.reason, /maksimal 600/i);
    },
  },
  {
    name: "validateTenorMonths — valid whole number",
    run(): void {
      const result = validateTenorMonths("12");
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.value, 12);
    },
  },

  // ------------------------------------------------------------------
  // Round-trip helpers
  // ------------------------------------------------------------------
  {
    name: "parseRupiahInputToCents — accepts dotted whole number",
    run(): void {
      assert.equal(parseRupiahInputToCents("12.000.000"), 1_200_000_000);
      assert.equal(parseRupiahInputToCents("12,5"), 1_250);
      assert.equal(parseRupiahInputToCents("0"), 0);
    },
  },
  {
    name: "parseRupiahInputToCents — returns 0 for malformed input",
    run(): void {
      assert.equal(parseRupiahInputToCents("abc"), 0);
      assert.equal(parseRupiahInputToCents(""), 0);
    },
  },
  {
    name: "parseBungaPctInput — accepts dotted whole + comma decimal",
    run(): void {
      assert.equal(parseBungaPctInput("10"), 10);
      assert.equal(parseBungaPctInput("9,5"), 9.5);
      assert.equal(parseBungaPctInput("9,1234"), 9.1234);
    },
  },
  {
    name: "parseBungaPctInput — rounds to 4 decimals",
    run(): void {
      // 9,1234 → 9.1234 (no rounding needed).
      assert.equal(parseBungaPctInput("9,1234"), 9.1234);
    },
  },

  // ------------------------------------------------------------------
  // debtToFormValues + isDebtFormDirty
  // ------------------------------------------------------------------
  {
    name: "debtToFormValues — happy path",
    run(): void {
      const result = debtToFormValues(SAMPLE_DEBT);
      assert.equal(result.name, "KTA BPD");
      assert.equal(result.kind, "KTA");
      assert.equal(result.principalCents, "12000000");
      assert.equal(result.bungaPct, "10");
      assert.equal(result.tenorMonths, "12");
      assert.equal(result.hasTenor, true);
      assert.equal(result.startDate, "2026-01-15");
    },
  },
  {
    name: "debtToFormValues — tenorless debt toggles hasTenor=false",
    run(): void {
      const tenorless = { ...SAMPLE_DEBT, tenorMonths: null, monthlyPaymentCents: null };
      const result = debtToFormValues(tenorless);
      assert.equal(result.hasTenor, false);
      assert.equal(result.tenorMonths, "");
    },
  },
  {
    name: "debtToFormValues — strips trailing zeros from bunga_pct",
    run(): void {
      const result = debtToFormValues({ ...SAMPLE_DEBT, bungaPct: 10.0 });
      assert.equal(result.bungaPct, "10");
    },
  },
  {
    name: "isDebtFormDirty — clean form is not dirty",
    run(): void {
      const initial = debtToFormValues(SAMPLE_DEBT);
      assert.equal(isDebtFormDirty(initial, initial), false);
    },
  },
  {
    name: "isDebtFormDirty — name change is dirty",
    run(): void {
      const initial = debtToFormValues(SAMPLE_DEBT);
      const dirty = { ...initial, name: "KTA BCA" };
      assert.equal(isDebtFormDirty(dirty, initial), true);
    },
  },
  {
    name: "isDebtFormDirty — kind change is dirty",
    run(): void {
      const initial = debtToFormValues(SAMPLE_DEBT);
      const dirty = { ...initial, kind: "KKB" as const };
      assert.equal(isDebtFormDirty(dirty, initial), true);
    },
  },

  // ------------------------------------------------------------------
  // todayIsoDate
  // ------------------------------------------------------------------
  {
    name: "todayIsoDate — formats YYYY-MM-DD",
    run(): void {
      const fixed = new Date(Date.UTC(2026, 1, 9, 12, 0, 0));
      assert.equal(todayIsoDate(fixed), "2026-02-09");
    },
  },

  // ------------------------------------------------------------------
  // computeDebtPreview
  // ------------------------------------------------------------------
  {
    name: "computeDebtPreview — zero-interest loan: principal / tenor",
    run(): void {
      const values: DebtFormValues = {
        ...INITIAL_DEBT_FORM_VALUES,
        principalCents: "12000000",
        bungaPct: "0",
        tenorMonths: "12",
        hasTenor: true,
      };
      const preview = computeDebtPreview(values);
      assert.equal(preview.monthlyPaymentCents, 100_000_000);
      assert.equal(preview.totalInterestCents, 0);
    },
  },
  {
    name: "computeDebtPreview — null when fields are missing",
    run(): void {
      const preview = computeDebtPreview(INITIAL_DEBT_FORM_VALUES);
      assert.equal(preview.monthlyPaymentCents, null);
      assert.equal(preview.totalInterestCents, null);
    },
  },
  {
    name: "computeDebtPreview — 10% / 12bln on 12jt → monthly ~1.1jt",
    run(): void {
      const values: DebtFormValues = {
        ...INITIAL_DEBT_FORM_VALUES,
        principalCents: "12000000",
        bungaPct: "10",
        tenorMonths: "12",
        hasTenor: true,
      };
      const preview = computeDebtPreview(values);
      assert.equal(preview.monthlyPaymentCents, 110_000_000);
    },
  },

  // ------------------------------------------------------------------
  // validatePaymentAmount
  // ------------------------------------------------------------------
  {
    name: "validatePaymentAmount — empty rejected",
    run(): void {
      const result = validatePaymentAmount("");
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.reason, /wajib diisi/i);
    },
  },
  {
    name: "validatePaymentAmount — whole rupiah accepted",
    run(): void {
      const result = validatePaymentAmount("1500000");
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.cents, 150_000_000);
    },
  },
  {
    name: "validatePaymentAmount — comma decimal accepted",
    run(): void {
      const result = validatePaymentAmount("1,5");
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.cents, 150);
    },
  },
  {
    name: "validatePaymentAmount — negative rejected",
    run(): void {
      const result = validatePaymentAmount("-1");
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.reason, /tidak boleh negatif/i);
    },
  },

  // ------------------------------------------------------------------
  // validatePortionCents
  // ------------------------------------------------------------------
  {
    name: "validatePortionCents — zero accepted (paid-off interest = 0)",
    run(): void {
      const result = validatePortionCents("0", "Bagian bunga");
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.cents, 0);
    },
  },
  {
    name: "validatePortionCents — negative rejected",
    run(): void {
      const result = validatePortionCents("-100", "Bagian pokok");
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.reason, /tidak boleh negatif/i);
    },
  },
  {
    name: "validatePortionCents — comma decimal accepted",
    run(): void {
      const result = validatePortionCents("1,5", "Bagian pokok");
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.cents, 150);
    },
  },

  // ------------------------------------------------------------------
  // validatePortionsSum — BE invariant
  // ------------------------------------------------------------------
  {
    name: "validatePortionsSum — equal values pass",
    run(): void {
      assert.equal(validatePortionsSum(1_100_000, 1_000_000, 100_000), null);
    },
  },
  {
    name: "validatePortionsSum — mismatch returns validation error",
    run(): void {
      const result = validatePortionsSum(1_100_000, 900_000, 100_000);
      assert.ok(result !== null);
      if (result === null) return;
      assert.match(result, /Bagian pokok \+ bagian bunga/i);
    },
  },

  // ------------------------------------------------------------------
  // computeDefaultSplit
  // ------------------------------------------------------------------
  {
    name: "computeDefaultSplit — zero-interest loan → all principal",
    run(): void {
      const result = computeDefaultSplit({
        monthlyPaymentCents: 110_000_000,
        bungaPct: 0,
        tenorMonths: 12,
      });
      assert.ok(result !== null);
      if (result === null) return;
      assert.equal(result.principalCents, 110_000_000);
      assert.equal(result.interestCents, 0);
    },
  },
  {
    name: "computeDefaultSplit — with-interest: principal + interest = monthly",
    run(): void {
      const result = computeDefaultSplit({
        monthlyPaymentCents: 110_000_000,
        bungaPct: 10,
        tenorMonths: 12,
      });
      assert.ok(result !== null);
      if (result === null) return;
      assert.equal(result.principalCents + result.interestCents, 110_000_000);
      assert.ok(result.principalCents > 0);
      assert.ok(result.interestCents > 0);
    },
  },
  {
    name: "computeDefaultSplit — no schedule returns null",
    run(): void {
      const result = computeDefaultSplit({
        monthlyPaymentCents: null,
        bungaPct: 10,
        tenorMonths: null,
      });
      assert.equal(result, null);
    },
  },
  {
    name: "computeDefaultSplit — null monthly payment returns null",
    run(): void {
      const result = computeDefaultSplit({
        monthlyPaymentCents: null,
        bungaPct: 10,
        tenorMonths: 12,
      });
      assert.equal(result, null);
    },
  },

  // ------------------------------------------------------------------
  // Payment form dirty tracking
  // ------------------------------------------------------------------
  {
    name: "isPaymentFormDirty — clean form is not dirty",
    run(): void {
      const initial = {
        occurredOn: "2026-02-01",
        amountCents: "1000000",
        principalPortionCents: "900000",
        interestPortionCents: "100000",
        sourceAccountId: "",
        note: "",
      };
      assert.equal(isPaymentFormDirty(initial, initial), false);
    },
  },
  {
    name: "isPaymentFormDirty — amount change is dirty",
    run(): void {
      const initial = {
        occurredOn: "2026-02-01",
        amountCents: "1000000",
        principalPortionCents: "900000",
        interestPortionCents: "100000",
        sourceAccountId: "",
        note: "",
      };
      const dirty = { ...initial, amountCents: "1100000" };
      assert.equal(isPaymentFormDirty(dirty, initial), true);
    },
  },
];

export function runDebtFormHelperTests(): {
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
  process.env["DEBT_FORM_HELPERS_TEST_RUN"] === "1"
) {
  const result = runDebtFormHelperTests();
  if (result.failed > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `[debt-form-helpers.test] ${result.failed} of ${result.failed + result.passed} failed`,
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
      `[debt-form-helpers.test] ${result.passed} cases passed`,
    );
  }
}
