"use client";

import type { ChangeEvent } from "react";

import {
  DEBT_KIND_LABEL,
  DEBT_KIND_VALUES,
  formatDebtIdrAmountOnly,
  type DebtFormErrors,
  type DebtKind,
} from "@/lib/api/debt-client";

/* -------------------------------------------------------------------------- *
 * Form value shape                                                           *
 * -------------------------------------------------------------------------- *
 *
 * Mirrors the FE-camelCase convention used by `goal-form-fields` and
 * `account-form-fields`. Currency is implicit (IDR per PRD §10) and
 * not exposed. Cents-vs-rupiah split matches the BE contract:
 * `principalCents` stays as a free-form rupiah string while the user
 * is typing, and the submit step converts to cents via
 * `validatePrincipalAmount` (same routine as the goals form).
 *
 * `tenorMonths` is the free-form string for the months field. The
 * `hasTenor` toggle gates whether the field is sent at all (the BE
 * schema allows `null` for tenorless debts).
 *
 * `startDate` is optional on create (the BE defaults to today UTC
 * per `apps/api/src/app/services/debt_calculator.py` and the
 * `_add_months` helper) but the FE seeds it with today so the user
 * sees a sensible default.
 */

export interface DebtFormValues {
  name: string;
  kind: DebtKind;
  principalCents: string;
  bungaPct: string;
  tenorMonths: string;
  hasTenor: boolean;
  startDate: string;
  note: string;
}

export const INITIAL_DEBT_FORM_VALUES: DebtFormValues = {
  name: "",
  kind: "loan",
  principalCents: "",
  bungaPct: "",
  tenorMonths: "",
  hasTenor: true,
  startDate: "",
  note: "",
};

export const DEBT_NAME_MAX = 120;
export const DEBT_NOTE_MAX = 2000;
export const DEBT_TENOR_MIN = 1;
export const DEBT_TENOR_MAX = 600; // 50 years — practical cap for KPR / KKB
export const DEBT_BUNGA_PCT_MAX = 100; // 100% annual — defensive cap

/**
 * Build the initial form values from a persisted `Debt` row (used by
 * the edit page). Mirrors `goalToFormValues` in the goals form layer
 * so the conversion is explicit and the wire shape can shift without
 * the renderer noticing.
 */
export function debtToFormValues(debt: import("@/lib/api/debt-client").Debt): DebtFormValues {
  return {
    name: debt.name,
    kind: debt.kind,
    principalCents: centsToRupiahInput(debt.principalCents),
    bungaPct: bungaPctToInput(debt.bungaPct),
    tenorMonths: debt.tenorMonths === null ? "" : String(debt.tenorMonths),
    hasTenor: debt.tenorMonths !== null,
    startDate: debt.startDate,
    note: debt.note ?? "",
  };
}

/**
 * Same shape as `isGoalFormDirty` — deep-ish equality check across all
 * the tracked fields. Kept inline so the debt form doesn't take a
 * dependency on the goals form layer.
 */
export function isDebtFormDirty(
  current: DebtFormValues,
  initial: DebtFormValues,
): boolean {
  return (
    current.name !== initial.name ||
    current.kind !== initial.kind ||
    current.principalCents !== initial.principalCents ||
    current.bungaPct !== initial.bungaPct ||
    current.tenorMonths !== initial.tenorMonths ||
    current.hasTenor !== initial.hasTenor ||
    current.startDate !== initial.startDate ||
    current.note !== initial.note
  );
}

/**
 * Convert a cents amount back to a free-form rupiah string for the
 * `principalCents` input. The debt schema enforces `principal_cents >
 * 0` (whole rupiah in the MVP), so a straight `cents / 100` cast is
 * safe. The submit step re-parses the user's typed value via
 * `validatePrincipalAmount`.
 */
function centsToRupiahInput(cents: number): string {
  return String(Math.round(cents / 100));
}

/**
 * Re-parse a free-form rupiah string back to cents without applying
 * the `> 0` floor. Used by the edit page to compare the form's
 * initial principal value against the persisted row (the persisted
 * row is always > 0, so the floor is redundant here).
 */
export function parseRupiahInputToCents(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed === "") return 0;

  let intPart: string;
  let decPart: string;

  if (trimmed.includes(",")) {
    if ((trimmed.match(/,/g) ?? []).length > 1) return 0;
    const parts = trimmed.split(",");
    intPart = (parts[0] ?? "").replace(/[\s._]/g, "");
    decPart = parts[1] ?? "";
    if (!/^\d*$/.test(intPart)) return 0;
    if (decPart !== "" && !/^\d+$/.test(decPart)) return 0;
  } else {
    intPart = trimmed.replace(/[\s._]/g, "");
    decPart = "";
    if (!/^\d+$/.test(intPart)) return 0;
  }

  const normalizedNumber = intPart === "" ? `0.${decPart}` : `${intPart}.${decPart}`;
  const rupiah = Number.parseFloat(normalizedNumber);
  if (!Number.isFinite(rupiah)) return 0;
  return Math.round(rupiah * 100);
}

/**
 * Re-parse a free-form decimal string back to a number. Used by the
 * edit page to compare the form's initial bunga value against the
 * persisted row.
 */
export function parseBungaPctInput(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed === "") return 0;

  let intPart: string;
  let decPart: string;

  if (trimmed.includes(",")) {
    if ((trimmed.match(/,/g) ?? []).length > 1) return 0;
    const parts = trimmed.split(",");
    intPart = (parts[0] ?? "").replace(/[\s._]/g, "");
    decPart = (parts[1] ?? "").slice(0, 4);
    if (!/^\d*$/.test(intPart)) return 0;
    if (decPart !== "" && !/^\d+$/.test(decPart)) return 0;
  } else {
    intPart = trimmed.replace(/[\s._]/g, "");
    decPart = "";
    if (!/^\d+$/.test(intPart)) return 0;
  }

  const normalizedNumber = intPart === "" ? `0.${decPart}` : `${intPart}.${decPart}`;
  const value = Number.parseFloat(normalizedNumber);
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10000) / 10000;
}

/**
 * Convert the persisted `bunga_pct` (decimal, e.g. `10.0` for 10%)
 * back to a free-form input string. Strip trailing zeros so the user
 * sees `10` instead of `10.0000` (the form validator accepts both).
 */
function bungaPctToInput(value: number): string {
  if (!Number.isFinite(value)) return "";
  // Round to 4 decimals (the BE schema's `decimal_places=4` cap) and
  // strip any trailing zeros so the input shows a tidy whole number
  // when the rate is round.
  const rounded = Math.round(value * 10000) / 10000;
  return String(rounded);
}

/**
 * Today's date in ISO `YYYY-MM-DD` form. Mirrors the helper in the
 * goals form layer so both forms seed their date inputs the same way
 * on the create page.
 */
export function todayIsoDate(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/* -------------------------------------------------------------------------- *
 * IDR amount validator                                                        *
 * -------------------------------------------------------------------------- *
 *
 * Indonesian bookkeeping convention (mirrored from the goals form
 * validator): comma is the decimal separator, dot/space/underscore are
 * thousand separators. The BE schema enforces `principal_cents > 0`
 * so a sub-cent value would round-trip to 0 cents and the BE would
 * 422 it. The validator mirrors the contract so the user sees the
 * same error before the round-trip.
 */

export interface AmountValidation {
  ok: true;
  cents: number;
}
export interface AmountValidationFailed {
  ok: false;
  reason: string;
}

export function validatePrincipalAmount(
  raw: string,
): AmountValidation | AmountValidationFailed {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, reason: "Nominal pokok wajib diisi." };
  }
  if (trimmed === "-") {
    return { ok: false, reason: "Nominal pokok minimal Rp 0,01." };
  }

  const negative = trimmed.startsWith("-");
  if (negative) {
    return { ok: false, reason: "Nominal pokok wajib lebih dari Rp 0." };
  }

  let intPart: string;
  let decPart: string;

  if (trimmed.includes(",")) {
    if ((trimmed.match(/,/g) ?? []).length > 1) {
      return {
        ok: false,
        reason: "Nominal hanya angka (contoh: 12000000 atau 12,5).",
      };
    }
    const parts = trimmed.split(",");
    intPart = (parts[0] ?? "").replace(/[\s._]/g, "");
    decPart = parts[1] ?? "";
    if (!/^\d*$/.test(intPart)) {
      return {
        ok: false,
        reason: "Nominal hanya angka (contoh: 12000000 atau 12,5).",
      };
    }
    if (decPart !== "" && !/^\d+$/.test(decPart)) {
      return {
        ok: false,
        reason: "Nominal hanya angka (contoh: 12000000 atau 12,5).",
      };
    }
    if (decPart.length > 2) {
      return {
        ok: false,
        reason:
          "Nominal maksimal 2 angka di belakang koma (sen). Nilai lebih kecil dibulatkan ke 0.",
      };
    }
  } else {
    // Indonesian bookkeeping convention (PRD §10): titik, spasi, dan
    // underscore adalah pemisah ribuan — semuanya di-strip dari integer
    // part. Koma adalah satu-satunya pemisah desimal.
    intPart = trimmed.replace(/[\s._]/g, "");
    decPart = "";
    if (!/^\d+$/.test(intPart)) {
      return {
        ok: false,
        reason: "Nominal hanya angka (contoh: 12000000).",
      };
    }
  }

  if (intPart === "" && decPart === "") {
    return { ok: false, reason: "Nominal pokok wajib diisi." };
  }

  const normalizedNumber = intPart === "" ? `0.${decPart}` : `${intPart}.${decPart}`;
  const rupiah = Number.parseFloat(normalizedNumber);
  if (!Number.isFinite(rupiah)) {
    return { ok: false, reason: "Nominal tidak valid." };
  }

  const cents = Math.round(rupiah * 100);
  if (cents <= 0) {
    return {
      ok: false,
      reason: "Nominal minimal Rp 0,01 (1 sen). Nilai lebih kecil dibulatkan ke 0.",
    };
  }

  return { ok: true, cents };
}

/* -------------------------------------------------------------------------- *
 * Bunga decimal validator                                                     *
 * -------------------------------------------------------------------------- *
 *
 * `bunga_pct` is an annual decimal in the BE schema (`Decimal` with
 * `ge=0, max_digits=7, decimal_places=4` — so a 7-digit number with at
 * most 4 fractional digits, e.g. `999.9999`). The FE validates the
 * same bounds so the user gets the same error before the round-trip.
 *
 * Convention: comma is the decimal separator, dot/space/underscore
 * are thousand separators. Negative values are rejected at the
 * boundary (the BE rejects `bunga_pct < 0` with 422).
 */

export interface BungaPctValidation {
  ok: true;
  value: number;
}
export interface BungaPctValidationFailed {
  ok: false;
  reason: string;
}

export function validateBungaPct(raw: string): BungaPctValidation | BungaPctValidationFailed {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return {
      ok: false,
      reason: "Bunga (annual) wajib diisi. Pakai 0 untuk utang tanpa bunga.",
    };
  }

  let intPart: string;
  let decPart: string;

  if (trimmed.includes(",")) {
    if ((trimmed.match(/,/g) ?? []).length > 1) {
      return {
        ok: false,
        reason: "Bunga hanya angka (contoh: 10 atau 9,5).",
      };
    }
    const parts = trimmed.split(",");
    intPart = (parts[0] ?? "").replace(/[\s._]/g, "");
    decPart = parts[1] ?? "";
    if (!/^\d*$/.test(intPart)) {
      return {
        ok: false,
        reason: "Bunga hanya angka (contoh: 10 atau 9,5).",
      };
    }
    if (decPart !== "" && !/^\d+$/.test(decPart)) {
      return {
        ok: false,
        reason: "Bunga hanya angka (contoh: 10 atau 9,5).",
      };
    }
    if (decPart.length > 4) {
      return {
        ok: false,
        reason: "Bunga maksimal 4 angka di belakang koma (BE decimal_places=4).",
      };
    }
  } else {
    intPart = trimmed.replace(/[\s._]/g, "");
    decPart = "";
    if (!/^\d+$/.test(intPart)) {
      return {
        ok: false,
        reason: "Bunga hanya angka (contoh: 10).",
      };
    }
  }

  if (intPart === "" && decPart === "") {
    return {
      ok: false,
      reason: "Bunga (annual) wajib diisi. Pakai 0 untuk utang tanpa bunga.",
    };
  }

  const normalizedNumber = intPart === "" ? `0.${decPart}` : `${intPart}.${decPart}`;
  const value = Number.parseFloat(normalizedNumber);
  if (!Number.isFinite(value)) {
    return { ok: false, reason: "Bunga tidak valid." };
  }

  if (value < 0) {
    // Defensive — the input parser above rejects the minus sign
    // before reaching this branch, but if the validator is ever
    // refactored to accept signed input this guard preserves the
    // BE contract (`bunga_pct >= 0`).
    return { ok: false, reason: "Bunga tidak boleh negatif." };
  }
  if (value > DEBT_BUNGA_PCT_MAX) {
    return {
      ok: false,
      reason: `Bunga maksimal ${DEBT_BUNGA_PCT_MAX}% per tahun.`,
    };
  }

  return { ok: true, value };
}

/* -------------------------------------------------------------------------- *
 * Tenor validator                                                            *
 * -------------------------------------------------------------------------- *
 *
 * Mirrors the BE schema: `tenor_months > 0` when set, `null` otherwise.
 * The form layer toggles `hasTenor` separately so the user can opt
 * out of the field; the validator only runs when `hasTenor === true`.
 */

export interface TenorValidation {
  ok: true;
  value: number;
}
export interface TenorValidationFailed {
  ok: false;
  reason: string;
}

export function validateTenorMonths(raw: string): TenorValidation | TenorValidationFailed {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, reason: "Tenor wajib diisi." };
  }
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, reason: "Tenor hanya angka bulat." };
  }
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(value) || value < DEBT_TENOR_MIN) {
    return {
      ok: false,
      reason: `Tenor minimal ${DEBT_TENOR_MIN} bulan.`,
    };
  }
  if (value > DEBT_TENOR_MAX) {
    return {
      ok: false,
      reason: `Tenor maksimal ${DEBT_TENOR_MAX} bulan.`,
    };
  }
  return { ok: true, value };
}

/* -------------------------------------------------------------------------- *
 * Live preview (real-time)                                                   *
 * -------------------------------------------------------------------------- *
 *
 * Mirrors the BE flat-interest calculator
 * (`app.services.debt_calculator.calculate_flat_monthly_payment_cents`)
 * so the FE preview matches what the server will store on submit.
 * Formula:
 *
 *   total_interest = principal * bunga_pct * tenor_months / 1200
 *   monthly_payment = (principal + total_interest) / tenor_months
 *
 * Rounding convention: we use `Math.round` here (half-to-even) for the
 * preview only. The BE uses half-up/down per the financial
 * convention; the preview is for guidance and may differ by a single
 * cent on edge cases (the canonical value is what the server writes
 * into `monthly_payment_cents` on create / patch).
 *
 * `null` outputs render as "—" in the preview card so the user never
 * sees "Rp 0" while the fields are still empty.
 */

export interface DebtPreview {
  /** Monthly payment in cents (server-side computed). */
  monthlyPaymentCents: number | null;
  /** Total interest over the tenure (cents). */
  totalInterestCents: number | null;
}

export function computeDebtPreview(values: DebtFormValues): DebtPreview {
  const principalValidation = validatePrincipalAmount(values.principalCents);
  if (!principalValidation.ok) {
    return { monthlyPaymentCents: null, totalInterestCents: null };
  }

  const bungaValidation = validateBungaPct(values.bungaPct);
  if (!bungaValidation.ok) {
    return { monthlyPaymentCents: null, totalInterestCents: null };
  }

  if (!values.hasTenor) {
    return { monthlyPaymentCents: null, totalInterestCents: null };
  }

  const tenorValidation = validateTenorMonths(values.tenorMonths);
  if (!tenorValidation.ok) {
    return { monthlyPaymentCents: null, totalInterestCents: null };
  }

  const principalCents = principalValidation.cents;
  const bungaPct = bungaValidation.value;
  const tenorMonths = tenorValidation.value;

  // Flat-interest formula: total_interest = principal * pct * tenor / 1200.
  // The `/1200` collapses `/100` (percent → decimal) and `/12` (annual
  // → monthly) into one constant.
  const totalInterestCents = Math.round(
    (principalCents * bungaPct * tenorMonths) / 1200,
  );
  const monthlyPaymentCents = Math.round(
    (principalCents + totalInterestCents) / tenorMonths,
  );

  return { monthlyPaymentCents, totalInterestCents };
}

/* -------------------------------------------------------------------------- *
 * Main fields component                                                      *
 * -------------------------------------------------------------------------- */

interface DebtFormFieldsProps {
  values: DebtFormValues;
  errors: DebtFormErrors;
  onChange: (next: DebtFormValues) => void;
  disabled?: boolean;
  idPrefix?: string;
}

export function DebtFormFields({
  values,
  errors,
  onChange,
  disabled,
  idPrefix = "debt-form",
}: DebtFormFieldsProps) {
  const fieldId = (key: string): string => `${idPrefix}-${key}`;

  const handleName = (e: ChangeEvent<HTMLInputElement>): void => {
    onChange({ ...values, name: e.target.value });
  };
  const handleKind = (e: ChangeEvent<HTMLSelectElement>): void => {
    const next = e.target.value;
    if (!(DEBT_KIND_VALUES as readonly string[]).includes(next)) return;
    onChange({ ...values, kind: next as DebtKind });
  };
  const handlePrincipal = (e: ChangeEvent<HTMLInputElement>): void => {
    onChange({ ...values, principalCents: e.target.value });
  };
  const handleBungaPct = (e: ChangeEvent<HTMLInputElement>): void => {
    onChange({ ...values, bungaPct: e.target.value });
  };
  const handleTenor = (e: ChangeEvent<HTMLInputElement>): void => {
    onChange({ ...values, tenorMonths: e.target.value });
  };
  const handleHasTenor = (e: ChangeEvent<HTMLInputElement>): void => {
    const hasTenor = e.target.checked;
    onChange({
      ...values,
      hasTenor,
      // Clear the field when the user un-toggles so the submit step
      // doesn't send a stale value.
      tenorMonths: hasTenor ? values.tenorMonths : "",
    });
  };
  const handleStartDate = (e: ChangeEvent<HTMLInputElement>): void => {
    onChange({ ...values, startDate: e.target.value });
  };
  const handleNotes = (e: ChangeEvent<HTMLTextAreaElement>): void => {
    onChange({ ...values, note: e.target.value });
  };

  return (
    <div className="grid gap-5">
      <NameField
        fieldId={fieldId}
        value={values.name}
        error={errors.name}
        disabled={disabled}
        onChange={handleName}
      />

      <KindField
        fieldId={fieldId}
        value={values.kind}
        error={errors.kind}
        disabled={disabled}
        onChange={handleKind}
      />

      <PrincipalField
        fieldId={fieldId}
        value={values.principalCents}
        error={errors.principalCents}
        disabled={disabled}
        onChange={handlePrincipal}
      />

      <BungaPctField
        fieldId={fieldId}
        value={values.bungaPct}
        error={errors.bungaPct}
        disabled={disabled}
        onChange={handleBungaPct}
      />

      <TenorFields
        fieldId={fieldId}
        value={values.tenorMonths}
        hasTenor={values.hasTenor}
        error={errors.tenorMonths}
        disabled={disabled}
        onTenor={handleTenor}
        onHasTenor={handleHasTenor}
      />

      <StartDateField
        fieldId={fieldId}
        value={values.startDate}
        error={errors.startDate}
        disabled={disabled}
        onChange={handleStartDate}
      />

      <DebtPreviewCard values={values} />

      <NotesField
        fieldId={fieldId}
        value={values.note}
        error={errors.note}
        disabled={disabled}
        onChange={handleNotes}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Field components                                                           *
 * -------------------------------------------------------------------------- */

interface NameFieldProps {
  fieldId: (key: string) => string;
  value: string;
  error: string | undefined;
  disabled?: boolean;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
}

function NameField({ fieldId, value, error, disabled, onChange }: NameFieldProps) {
  return (
    <div>
      <label htmlFor={fieldId("name")} className="form-label">
        Nama utang
      </label>
      <input
        id={fieldId("name")}
        name="name"
        type="text"
        required
        maxLength={DEBT_NAME_MAX}
        autoComplete="off"
        placeholder="Contoh: KTA BPD, Kartu kredit BCA, KPR BTN"
        className="form-input mt-1 min-h-12 py-3 text-base"
        value={value}
        onChange={onChange}
        disabled={disabled}
        aria-invalid={error ? "true" : "false"}
        aria-describedby={error ? fieldId("name-error") : fieldId("name-hint")}
      />
      {error ? (
        <p id={fieldId("name-error")} className="form-error" role="alert">
          {error}
        </p>
      ) : (
        <p id={fieldId("name-hint")} className="mt-1 text-xs text-slate-500">
          Wajib, 1–{DEBT_NAME_MAX} karakter.
        </p>
      )}
    </div>
  );
}

interface KindFieldProps {
  fieldId: (key: string) => string;
  value: DebtKind;
  error: string | undefined;
  disabled?: boolean;
  onChange: (e: ChangeEvent<HTMLSelectElement>) => void;
}

function KindField({ fieldId, value, error, disabled, onChange }: KindFieldProps) {
  return (
    <div>
      <label htmlFor={fieldId("kind")} className="form-label">
        Jenis utang
      </label>
      <select
        id={fieldId("kind")}
        name="kind"
        className="form-input mt-1 min-h-12 py-3 text-base"
        value={value}
        onChange={onChange}
        disabled={disabled}
        aria-invalid={error ? "true" : "false"}
        aria-describedby={error ? fieldId("kind-error") : fieldId("kind-hint")}
      >
        {DEBT_KIND_VALUES.map((kind) => (
          <option key={kind} value={kind}>
            {DEBT_KIND_LABEL[kind]}
          </option>
        ))}
      </select>
      {error ? (
        <p id={fieldId("kind-error")} className="form-error" role="alert">
          {error}
        </p>
      ) : (
        <p id={fieldId("kind-hint")} className="mt-1 text-xs text-slate-500">
          Pilih jenis yang paling mendekati. Bisa diubah lagi dari halaman edit.
        </p>
      )}
    </div>
  );
}

interface PrincipalFieldProps {
  fieldId: (key: string) => string;
  value: string;
  error: string | undefined;
  disabled?: boolean;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
}

function PrincipalField({
  fieldId,
  value,
  error,
  disabled,
  onChange,
}: PrincipalFieldProps) {
  return (
    <div>
      <label htmlFor={fieldId("principalCents")} className="form-label">
        Pokok awal (IDR)
      </label>
      <div className="relative mt-1">
        <span
          className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-base font-semibold text-slate-500"
          aria-hidden="true"
        >
          Rp
        </span>
        <input
          id={fieldId("principalCents")}
          name="principalCents"
          type="text"
          inputMode="decimal"
          pattern="[0-9., _]*"
          placeholder="0"
          autoComplete="off"
          required
          className="form-input min-h-12 py-3 pl-10 text-lg font-semibold tabular-nums"
          value={value}
          onChange={onChange}
          disabled={disabled}
          aria-invalid={error ? "true" : "false"}
          aria-describedby={
            error ? fieldId("principalCents-error") : fieldId("principalCents-hint")
          }
        />
      </div>
      {error ? (
        <p id={fieldId("principalCents-error")} className="form-error" role="alert">
          {error}
        </p>
      ) : (
        <p id={fieldId("principalCents-hint")} className="mt-1 text-xs text-slate-500">
          Wajib lebih dari Rp 0. Pokok awal dipakai untuk hitung cicilan otomatis.
          Pakai koma untuk desimal, titik untuk ribuan.
        </p>
      )}
    </div>
  );
}

interface BungaPctFieldProps {
  fieldId: (key: string) => string;
  value: string;
  error: string | undefined;
  disabled?: boolean;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
}

function BungaPctField({
  fieldId,
  value,
  error,
  disabled,
  onChange,
}: BungaPctFieldProps) {
  return (
    <div>
      <label htmlFor={fieldId("bungaPct")} className="form-label">
        Bunga (annual %)
      </label>
      <div className="relative mt-1">
        <input
          id={fieldId("bungaPct")}
          name="bungaPct"
          type="text"
          inputMode="decimal"
          pattern="[0-9., _]*"
          placeholder="0"
          autoComplete="off"
          required
          className="form-input min-h-12 py-3 pr-10 text-lg font-semibold tabular-nums"
          value={value}
          onChange={onChange}
          disabled={disabled}
          aria-invalid={error ? "true" : "false"}
          aria-describedby={
            error ? fieldId("bungaPct-error") : fieldId("bungaPct-hint")
          }
        />
        <span
          className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-base font-semibold text-slate-500"
          aria-hidden="true"
        >
          %
        </span>
      </div>
      {error ? (
        <p id={fieldId("bungaPct-error")} className="form-error" role="alert">
          {error}
        </p>
      ) : (
        <p id={fieldId("bungaPct-hint")} className="mt-1 text-xs text-slate-500">
          Desimal per tahun, contoh 10 untuk 10% / tahun. Pakai 0 untuk
          pinjaman tanpa bunga. Maksimal 4 angka di belakang koma.
        </p>
      )}
    </div>
  );
}

interface TenorFieldsProps {
  fieldId: (key: string) => string;
  value: string;
  hasTenor: boolean;
  error: string | undefined;
  disabled?: boolean;
  onTenor: (e: ChangeEvent<HTMLInputElement>) => void;
  onHasTenor: (e: ChangeEvent<HTMLInputElement>) => void;
}

function TenorFields({
  fieldId,
  value,
  hasTenor,
  error,
  disabled,
  onTenor,
  onHasTenor,
}: TenorFieldsProps) {
  return (
    <div>
      <label
        htmlFor={fieldId("tenorMonths")}
        className="form-label"
      >
        Tenor (bulan)
      </label>
      <input
        id={fieldId("tenorMonths")}
        name="tenorMonths"
        type="number"
        inputMode="numeric"
        min={DEBT_TENOR_MIN}
        max={DEBT_TENOR_MAX}
        step={1}
        required={hasTenor}
        autoComplete="off"
        placeholder="12"
        className="form-input mt-1 min-h-12 py-3 text-base"
        value={value}
        onChange={onTenor}
        disabled={disabled || !hasTenor}
        aria-invalid={error ? "true" : "false"}
        aria-describedby={
          error ? fieldId("tenorMonths-error") : fieldId("tenorMonths-hint")
        }
      />
      {error ? (
        <p id={fieldId("tenorMonths-error")} className="form-error" role="alert">
          {error}
        </p>
      ) : (
        <p id={fieldId("tenorMonths-hint")} className="mt-1 text-xs text-slate-500">
          Wajib lebih dari 0 untuk pinjaman dengan jadwal tetap.
          Maksimal {DEBT_TENOR_MAX} bulan.
        </p>
      )}
      <label className="mt-2 flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
          checked={hasTenor}
          onChange={onHasTenor}
          disabled={disabled}
          data-testid={`${fieldId("hasTenor")}`}
        />
        <span>Utang dengan jadwal tetap (aktifkan untuk tenor di atas)</span>
      </label>
    </div>
  );
}

interface StartDateFieldProps {
  fieldId: (key: string) => string;
  value: string;
  error: string | undefined;
  disabled?: boolean;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
}

function StartDateField({
  fieldId,
  value,
  error,
  disabled,
  onChange,
}: StartDateFieldProps) {
  return (
    <div>
      <label htmlFor={fieldId("startDate")} className="form-label">
        Tanggal mulai
      </label>
      <input
        id={fieldId("startDate")}
        name="startDate"
        type="date"
        required
        className="form-input mt-1 min-h-12 py-3 text-base"
        value={value}
        onChange={onChange}
        disabled={disabled}
        aria-invalid={error ? "true" : "false"}
        aria-describedby={
          error ? fieldId("startDate-error") : fieldId("startDate-hint")
        }
      />
      {error ? (
        <p id={fieldId("startDate-error")} className="form-error" role="alert">
          {error}
        </p>
      ) : (
        <p id={fieldId("startDate-hint")} className="mt-1 text-xs text-slate-500">
          Default hari ini (UTC) bila dikosongkan. Dipakai untuk hitung
          tanggal jatuh tempo berikutnya.
        </p>
      )}
    </div>
  );
}

interface NotesFieldProps {
  fieldId: (key: string) => string;
  value: string;
  error: string | undefined;
  disabled?: boolean;
  onChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
}

function NotesField({
  fieldId,
  value,
  error,
  disabled,
  onChange,
}: NotesFieldProps) {
  return (
    <div>
      <label htmlFor={fieldId("note")} className="form-label">
        Catatan <span className="font-normal text-slate-400">(opsional)</span>
      </label>
      <textarea
        id={fieldId("note")}
        name="note"
        rows={3}
        maxLength={DEBT_NOTE_MAX}
        placeholder="Misal: refinance dari KTA lama, tenor mengikuti sisa periode"
        className="form-input mt-1 min-h-24 py-3 text-base"
        value={value}
        onChange={onChange}
        disabled={disabled}
        aria-invalid={error ? "true" : "false"}
        aria-describedby={error ? fieldId("note-error") : fieldId("note-hint")}
      />
      {error ? (
        <p id={fieldId("note-error")} className="form-error" role="alert">
          {error}
        </p>
      ) : (
        <p id={fieldId("note-hint")} className="mt-1 text-xs text-slate-500">
          Maks {DEBT_NOTE_MAX} karakter · tersisa {DEBT_NOTE_MAX - value.length}
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Live preview card                                                          *
 * -------------------------------------------------------------------------- *
 *
 * Pure render of `computeDebtPreview(values)`. Skips an output entirely
 * when the corresponding value is `null` so the user sees "—" instead
 * of "Rp 0" while the fields are still empty.
 */

interface DebtPreviewCardProps {
  values: DebtFormValues;
}

function DebtPreviewCard({ values }: DebtPreviewCardProps) {
  const preview = computeDebtPreview(values);
  return (
    <aside
      className="rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-900"
      role="status"
      aria-live="polite"
      data-testid="debt-preview"
    >
      <p className="font-semibold">Pratinjau real-time</p>
      <dl className="mt-2 grid gap-1">
        <div className="flex items-baseline justify-between gap-2">
          <dt>Cicilan / bulan</dt>
          <dd className="tabular-nums">
            {preview.monthlyPaymentCents !== null
              ? `Rp ${formatDebtIdrAmountOnly(preview.monthlyPaymentCents)}`
              : "—"}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <dt>Total bunga sampai lunas</dt>
          <dd className="tabular-nums">
            {preview.totalInterestCents !== null
              ? `Rp ${formatDebtIdrAmountOnly(preview.totalInterestCents)}`
              : "—"}
          </dd>
        </div>
      </dl>
      <p className="mt-2 text-xs text-brand-700">
        Rumus: amortisasi flat-interest (auto-calc BE, dihitung server
        saat simpan). Atur toggle &ldquo;Tanpa tenor&rdquo; untuk cicilan fleksibel.
      </p>
    </aside>
  );
}

/* -------------------------------------------------------------------------- *
 * Loading + submit skeletons                                                 *
 * -------------------------------------------------------------------------- *
 *
 * Mirrors the pattern used by `goal-form-fields` so the FE has the
 * same loading affordances for debts. The edit page renders
 * `DebtFormFieldsSkeleton` while the prefetch is in flight (so the
 * layout doesn't jump when the data lands), and `DebtSubmitSkeleton`
 * while POST/PATCH is in flight (so the disabled form isn't the only
 * visual cue).
 */

export function DebtFormFieldsSkeleton(): React.ReactNode {
  return (
    <div
      className="grid gap-5"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="h-14 animate-pulse rounded-md bg-slate-100" />
      <div className="h-14 animate-pulse rounded-md bg-slate-100" />
      <div className="h-14 animate-pulse rounded-md bg-slate-100" />
      <div className="h-14 animate-pulse rounded-md bg-slate-100" />
      <div className="h-14 animate-pulse rounded-md bg-slate-100" />
      <div className="h-14 animate-pulse rounded-md bg-slate-100" />
      <div className="h-24 animate-pulse rounded-md bg-slate-100" />
      <span className="sr-only">Memuat formulir utang...</span>
    </div>
  );
}

export function DebtSubmitSkeleton(): React.ReactNode {
  return (
    <div
      className="grid gap-5"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="flex items-center gap-3 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-brand-900">
        <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" />
        <span>Menyimpan utang...</span>
      </div>
      <div className="h-14 animate-pulse rounded-md bg-slate-100" />
      <div className="h-14 animate-pulse rounded-md bg-slate-100" />
      <div className="h-14 animate-pulse rounded-md bg-slate-100" />
      <div className="h-14 animate-pulse rounded-md bg-slate-100" />
      <div className="h-14 animate-pulse rounded-md bg-slate-100" />
      <div className="h-14 animate-pulse rounded-md bg-slate-100" />
      <div className="h-24 animate-pulse rounded-md bg-slate-100" />
      <span className="sr-only">Mengirim utang ke server...</span>
    </div>
  );
}
