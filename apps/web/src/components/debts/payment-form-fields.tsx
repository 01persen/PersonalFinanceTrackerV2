"use client";

import type { ChangeEvent } from "react";

import {
  ACCOUNT_TYPE_LABEL,
  type Account,
  type AccountType,
} from "@/lib/api/account-client";
import {
  formatDebtIdrAmountOnly,
  type DebtPaymentFormErrors,
} from "@/lib/api/debt-client";

/* -------------------------------------------------------------------------- *
 * Form value shape                                                           *
 * -------------------------------------------------------------------------- *
 *
 * Mirrors the FE-camelCase convention used by `debt-form-fields` and
 * `goal-form-fields`. Currency is implicit (IDR per PRD §10) and not
 * exposed. Cents-vs-rupiah split matches the BE contract:
 * `amountCents` + `principalPortionCents` + `interestPortionCents`
 * stay as free-form rupiah strings while the user is typing, and
 * the submit step converts to cents via the validators below.
 *
 * `sourceAccountId` is the free-form string for the linked account
 * selector. Empty string means "no linked account" (cash payment).
 * `occurredOn` is optional on create (the BE defaults to today UTC
 * per the payment row's defaults) but the FE seeds it with today so
 * the user sees a sensible default.
 */

export interface PaymentFormValues {
  occurredOn: string;
  amountCents: string;
  principalPortionCents: string;
  interestPortionCents: string;
  sourceAccountId: string;
  note: string;
}

export const INITIAL_PAYMENT_FORM_VALUES: PaymentFormValues = {
  occurredOn: "",
  amountCents: "",
  principalPortionCents: "",
  interestPortionCents: "",
  sourceAccountId: "",
  note: "",
};

export const PAYMENT_NOTE_MAX = 2000;

/**
 * Build the initial form values for a fresh cicilan. The payment
 * form is always pre-seeded with today's date so the user can hit
 * submit without picking a date.
 */
export function initialPaymentFormValuesForCreate(now: Date = new Date()): PaymentFormValues {
  return {
    ...INITIAL_PAYMENT_FORM_VALUES,
    occurredOn: todayIsoDate(now),
  };
}

/**
 * Same shape as `isGoalFormDirty` / `isDebtFormDirty` — deep-ish
 * equality check across all the tracked fields. Kept inline so the
 * payment form doesn't take a dependency on either form layer.
 */
export function isPaymentFormDirty(
  current: PaymentFormValues,
  initial: PaymentFormValues,
): boolean {
  return (
    current.occurredOn !== initial.occurredOn ||
    current.amountCents !== initial.amountCents ||
    current.principalPortionCents !== initial.principalPortionCents ||
    current.interestPortionCents !== initial.interestPortionCents ||
    current.sourceAccountId !== initial.sourceAccountId ||
    current.note !== initial.note
  );
}

/**
 * Today's date in ISO `YYYY-MM-DD` form. Mirrors the helper in
 * `debt-form-fields` so both forms seed their date inputs the same way.
 */
export function todayIsoDate(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/* -------------------------------------------------------------------------- *
 * IDR amount validator (shared with debt form)                               *
 * -------------------------------------------------------------------------- *
 *
 * The cicilan form uses the same validator as the debt form:
 * `principalCents > 0`, comma for decimal, dot/space/underscore for
 * thousand separators. Re-exported here so the payment page can
 * import without reaching into `debt-form-fields`.
 */

export interface AmountValidation {
  ok: true;
  cents: number;
}
export interface AmountValidationFailed {
  ok: false;
  reason: string;
}

export function validatePaymentAmount(
  raw: string,
): AmountValidation | AmountValidationFailed {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, reason: "Nominal cicilan wajib diisi." };
  }
  if (trimmed.startsWith("-")) {
    return { ok: false, reason: "Nominal cicilan tidak boleh negatif." };
  }

  let intPart: string;
  let decPart: string;

  if (trimmed.includes(",")) {
    if ((trimmed.match(/,/g) ?? []).length > 1) {
      return {
        ok: false,
        reason: "Nominal hanya angka (contoh: 1500000 atau 1,5).",
      };
    }
    const parts = trimmed.split(",");
    intPart = (parts[0] ?? "").replace(/[\s._]/g, "");
    decPart = parts[1] ?? "";
    if (!/^\d*$/.test(intPart)) {
      return {
        ok: false,
        reason: "Nominal hanya angka (contoh: 1500000 atau 1,5).",
      };
    }
    if (decPart !== "" && !/^\d+$/.test(decPart)) {
      return {
        ok: false,
        reason: "Nominal hanya angka (contoh: 1500000 atau 1,5).",
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
    intPart = trimmed.replace(/[\s._]/g, "");
    decPart = "";
    if (!/^\d+$/.test(intPart)) {
      return {
        ok: false,
        reason: "Nominal hanya angka (contoh: 1500000).",
      };
    }
  }

  if (intPart === "" && decPart === "") {
    return { ok: false, reason: "Nominal cicilan wajib diisi." };
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

/**
 * Validator for the principal / interest portion fields. The BE
 * enforces `principal_portion_cents + interest_portion_cents ==
 * amount_cents` and both are non-negative. The validator runs the
 * same checks so the user sees the same error before the round-trip.
 */
export function validatePortionCents(
  raw: string,
  fieldLabel: string,
): AmountValidation | AmountValidationFailed {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, reason: `${fieldLabel} wajib diisi (>= Rp 0).` };
  }
  if (trimmed.startsWith("-")) {
    return { ok: false, reason: `${fieldLabel} tidak boleh negatif.` };
  }

  let intPart: string;
  let decPart: string;

  if (trimmed.includes(",")) {
    if ((trimmed.match(/,/g) ?? []).length > 1) {
      return {
        ok: false,
        reason: `${fieldLabel} hanya angka (contoh: 1000000 atau 1,5).`,
      };
    }
    const parts = trimmed.split(",");
    intPart = (parts[0] ?? "").replace(/[\s._]/g, "");
    decPart = parts[1] ?? "";
    if (!/^\d*$/.test(intPart)) {
      return {
        ok: false,
        reason: `${fieldLabel} hanya angka (contoh: 1000000 atau 1,5).`,
      };
    }
    if (decPart !== "" && !/^\d+$/.test(decPart)) {
      return {
        ok: false,
        reason: `${fieldLabel} hanya angka (contoh: 1000000 atau 1,5).`,
      };
    }
    if (decPart.length > 2) {
      return {
        ok: false,
        reason: `${fieldLabel} maksimal 2 angka di belakang koma.`,
      };
    }
  } else {
    intPart = trimmed.replace(/[\s._]/g, "");
    decPart = "";
    if (!/^\d+$/.test(intPart)) {
      return {
        ok: false,
        reason: `${fieldLabel} hanya angka (contoh: 1000000).`,
      };
    }
  }

  const normalizedNumber = intPart === "" ? `0.${decPart}` : `${intPart}.${decPart}`;
  const rupiah = Number.parseFloat(normalizedNumber);
  if (!Number.isFinite(rupiah)) {
    return { ok: false, reason: `${fieldLabel} tidak valid.` };
  }

  const cents = Math.round(rupiah * 100);
  if (cents < 0) {
    return { ok: false, reason: `${fieldLabel} tidak boleh negatif.` };
  }
  return { ok: true, cents };
}

/* -------------------------------------------------------------------------- *
 * Cross-field validator (BE invariant)                                       *
 * -------------------------------------------------------------------------- *
 *
 * Returns the first violation of the BE contract:
 *
 *   principal_portion_cents + interest_portion_cents == amount_cents
 *
 * All three fields must be non-negative (Pydantic `ge=0`). The route
 * layer also rejects overpayment (principal > remaining) but that
 * check is best run with the live `remaining_principal_cents` from
 * the debt summary — the payment page composes this check separately
 * via `validatePaymentAgainstRemaining`.
 */

export function validatePortionsSum(
  amountCents: number,
  principalCents: number,
  interestCents: number,
): string | null {
  if (principalCents + interestCents !== amountCents) {
    return (
      "Bagian pokok + bagian bunga harus sama dengan total cicilan " +
      `(Rp ${formatDebtIdrAmountOnly(amountCents)}).`
    );
  }
  return null;
}

/* -------------------------------------------------------------------------- *
 * Default split helper                                                       *
 * -------------------------------------------------------------------------- *
 *
 * Helper to compute the principal + interest split from the debt
 * row's `monthly_payment_cents` + `bunga_pct` + `tenor_months` (flat
 * interest, monthly flat amount). Returns `null` when the inputs are
 * missing or the debt has no schedule (`tenor_months === null`).
 *
 * Mirrors the BE flat-interest model in
 * `app.services.debt_calculator.calculate_flat_monthly_payment_cents`:
 *
 *   monthly = principal / tenor + principal * pct / 1200
 *   monthly = principal * (1200 + pct * tenor) / (1200 * tenor)
 *
 * Solving for the principal:
 *
 *   principal = monthly * 1200 * tenor / (1200 + pct * tenor)
 *
 * Then the per-month interest portion is `principal * pct / 1200`,
 * and the per-month principal portion is `monthly - interest`.
 *
 * For zero-interest loans the interest portion is `0` and the entire
 * monthly payment reduces the principal.
 *
 * The UI exposes this as a "Bagi otomatis" button on the form so the
 * user can pick the default split without typing the components
 * manually.
 */

export interface DefaultSplit {
  principalCents: number;
  interestCents: number;
}

export function computeDefaultSplit(args: {
  monthlyPaymentCents: number | null;
  bungaPct: number;
  tenorMonths: number | null;
}): DefaultSplit | null {
  const { monthlyPaymentCents, bungaPct, tenorMonths } = args;
  if (monthlyPaymentCents === null || tenorMonths === null) return null;
  if (monthlyPaymentCents <= 0) return null;

  if (bungaPct === 0) {
    // Zero-interest loan — all of the payment is principal.
    return {
      principalCents: monthlyPaymentCents,
      interestCents: 0,
    };
  }

  // Solve for the per-month principal portion via the flat-interest
  // formula. Algebra:
  //
  //   monthly = principal/tenor + principal * pct / 1200
  //   principal_per_month = monthly * 1200 / (1200 + pct * tenor)
  //
  // The interest portion is the remainder.
  const principalCents = Math.round(
    (monthlyPaymentCents * 1200) / (1200 + bungaPct * tenorMonths),
  );
  const interestCents = monthlyPaymentCents - principalCents;
  if (principalCents < 0 || interestCents < 0) return null;
  return { principalCents, interestCents };
}

/* -------------------------------------------------------------------------- *
 * Main fields component                                                      *
 * -------------------------------------------------------------------------- */

interface PaymentFormFieldsProps {
  values: PaymentFormValues;
  errors: DebtPaymentFormErrors;
  onChange: (next: PaymentFormValues) => void;
  accounts: Account[];
  /** Optional: render a "Bagi otomatis" button next to the split fields. */
  onAutoSplit?: () => void;
  /**
   * `true` when the underlying debt has reached `paid_off`. The
   * form layer renders a banner + disables all inputs so the user
   * can't POST a payment on a closed debt (the BE rejects this with
   * 422 too — this is a nicer UX).
   */
  paidOff: boolean;
  disabled?: boolean;
  idPrefix?: string;
}

export function PaymentFormFields({
  values,
  errors,
  onChange,
  accounts,
  onAutoSplit,
  paidOff,
  disabled,
  idPrefix = "payment-form",
}: PaymentFormFieldsProps) {
  const fieldId = (key: string): string => `${idPrefix}-${key}`;

  const handleOccurredOn = (e: ChangeEvent<HTMLInputElement>): void => {
    onChange({ ...values, occurredOn: e.target.value });
  };
  const handleAmount = (e: ChangeEvent<HTMLInputElement>): void => {
    onChange({ ...values, amountCents: e.target.value });
  };
  const handlePrincipal = (e: ChangeEvent<HTMLInputElement>): void => {
    onChange({ ...values, principalPortionCents: e.target.value });
  };
  const handleInterest = (e: ChangeEvent<HTMLInputElement>): void => {
    onChange({ ...values, interestPortionCents: e.target.value });
  };
  const handleSourceAccount = (e: ChangeEvent<HTMLSelectElement>): void => {
    onChange({ ...values, sourceAccountId: e.target.value });
  };
  const handleNotes = (e: ChangeEvent<HTMLTextAreaElement>): void => {
    onChange({ ...values, note: e.target.value });
  };

  const isFullyDisabled = disabled || paidOff;

  return (
    <div className="grid gap-5">
      {paidOff ? (
        <div
          role="status"
          className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
          data-testid={`${fieldId("paid-off-notice")}`}
        >
          Utang ini sudah <span className="font-semibold">lunas</span>.
          Cicilan baru tidak dapat dicatat. Buka halaman detail untuk
          melihat histori cicilan.
        </div>
      ) : null}

      <OccurredOnField
        fieldId={fieldId}
        value={values.occurredOn}
        error={errors.occurredOn}
        disabled={isFullyDisabled}
        onChange={handleOccurredOn}
      />

      <AmountField
        fieldId={fieldId}
        value={values.amountCents}
        error={errors.amountCents}
        disabled={isFullyDisabled}
        onChange={handleAmount}
      />

      <PortionFields
        fieldId={fieldId}
        principalValue={values.principalPortionCents}
        interestValue={values.interestPortionCents}
        principalError={errors.principalPortionCents}
        interestError={errors.interestPortionCents}
        onAutoSplit={onAutoSplit}
        disabled={isFullyDisabled}
        onPrincipal={handlePrincipal}
        onInterest={handleInterest}
      />

      <SourceAccountField
        fieldId={fieldId}
        value={values.sourceAccountId}
        error={errors.sourceAccountId}
        accounts={accounts}
        disabled={isFullyDisabled}
        onChange={handleSourceAccount}
      />

      <NotesField
        fieldId={fieldId}
        value={values.note}
        error={errors.note}
        disabled={isFullyDisabled}
        onChange={handleNotes}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Field components                                                           *
 * -------------------------------------------------------------------------- */

interface OccurredOnFieldProps {
  fieldId: (key: string) => string;
  value: string;
  error: string | undefined;
  disabled?: boolean;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
}

function OccurredOnField({
  fieldId,
  value,
  error,
  disabled,
  onChange,
}: OccurredOnFieldProps) {
  return (
    <div>
      <label htmlFor={fieldId("occurredOn")} className="form-label">
        Tanggal cicilan
      </label>
      <input
        id={fieldId("occurredOn")}
        name="occurredOn"
        type="date"
        required
        className="form-input mt-1 min-h-12 py-3 text-base"
        value={value}
        onChange={onChange}
        disabled={disabled}
        aria-invalid={error ? "true" : "false"}
        aria-describedby={
          error ? fieldId("occurredOn-error") : fieldId("occurredOn-hint")
        }
      />
      {error ? (
        <p id={fieldId("occurredOn-error")} className="form-error" role="alert">
          {error}
        </p>
      ) : (
        <p id={fieldId("occurredOn-hint")} className="mt-1 text-xs text-slate-500">
          Default hari ini (UTC) bila dikosongkan. Dipakai untuk hitung
          tanggal jatuh tempo berikutnya.
        </p>
      )}
    </div>
  );
}

interface AmountFieldProps {
  fieldId: (key: string) => string;
  value: string;
  error: string | undefined;
  disabled?: boolean;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
}

function AmountField({
  fieldId,
  value,
  error,
  disabled,
  onChange,
}: AmountFieldProps) {
  return (
    <div>
      <label htmlFor={fieldId("amountCents")} className="form-label">
        Nominal cicilan (IDR)
      </label>
      <div className="relative mt-1">
        <span
          className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-base font-semibold text-slate-500"
          aria-hidden="true"
        >
          Rp
        </span>
        <input
          id={fieldId("amountCents")}
          name="amountCents"
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
            error ? fieldId("amountCents-error") : fieldId("amountCents-hint")
          }
        />
      </div>
      {error ? (
        <p id={fieldId("amountCents-error")} className="form-error" role="alert">
          {error}
        </p>
      ) : (
        <p id={fieldId("amountCents-hint")} className="mt-1 text-xs text-slate-500">
          Total cicilan (pokok + bunga). Wajib lebih dari Rp 0. Total
          harus sama dengan jumlah bagian pokok + bagian bunga.
        </p>
      )}
    </div>
  );
}

interface PortionFieldsProps {
  fieldId: (key: string) => string;
  principalValue: string;
  interestValue: string;
  principalError: string | undefined;
  interestError: string | undefined;
  onAutoSplit?: () => void;
  disabled?: boolean;
  onPrincipal: (e: ChangeEvent<HTMLInputElement>) => void;
  onInterest: (e: ChangeEvent<HTMLInputElement>) => void;
}

function PortionFields({
  fieldId,
  principalValue,
  interestValue,
  principalError,
  interestError,
  onAutoSplit,
  disabled,
  onPrincipal,
  onInterest,
}: PortionFieldsProps) {
  return (
    <div>
      <div className="flex items-end justify-between gap-2">
        <p className="form-label">Bagian pokok + bunga</p>
        {onAutoSplit ? (
          <button
            type="button"
            className="text-xs font-semibold text-brand-700 underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-60"
            onClick={onAutoSplit}
            disabled={disabled}
            data-testid={`${fieldId("auto-split")}`}
          >
            Bagi otomatis
          </button>
        ) : null}
      </div>
      <div className="mt-1 grid gap-4 sm:grid-cols-2">
        <PortionInput
          fieldId={fieldId}
          label="Bagian pokok"
          value={principalValue}
          error={principalError}
          disabled={disabled}
          onChange={onPrincipal}
          suffixId="principalPortionCents"
        />
        <PortionInput
          fieldId={fieldId}
          label="Bagian bunga"
          value={interestValue}
          error={interestError}
          disabled={disabled}
          onChange={onInterest}
          suffixId="interestPortionCents"
        />
      </div>
      <p className="mt-1 text-xs text-slate-500">
        Total bagian pokok + bagian bunga harus sama dengan nominal
        cicilan di atas. Untuk cicilan 0% bunga, isi bagian bunga
        dengan 0.
      </p>
    </div>
  );
}

interface PortionInputProps {
  fieldId: (key: string) => string;
  label: string;
  value: string;
  error: string | undefined;
  disabled?: boolean;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  suffixId: string;
}

function PortionInput({
  fieldId,
  label,
  value,
  error,
  disabled,
  onChange,
  suffixId,
}: PortionInputProps) {
  return (
    <div>
      <label htmlFor={fieldId(suffixId)} className="form-label">
        {label}
      </label>
      <div className="relative mt-1">
        <span
          className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-base font-semibold text-slate-500"
          aria-hidden="true"
        >
          Rp
        </span>
        <input
          id={fieldId(suffixId)}
          name={suffixId}
          type="text"
          inputMode="decimal"
          pattern="[0-9., _]*"
          placeholder="0"
          autoComplete="off"
          required
          className="form-input min-h-12 py-3 pl-10 text-base tabular-nums"
          value={value}
          onChange={onChange}
          disabled={disabled}
          aria-invalid={error ? "true" : "false"}
          aria-describedby={error ? fieldId(`${suffixId}-error`) : fieldId(`${suffixId}-hint`)}
        />
      </div>
      {error ? (
        <p id={fieldId(`${suffixId}-error`)} className="form-error" role="alert">
          {error}
        </p>
      ) : (
        <p id={fieldId(`${suffixId}-hint`)} className="mt-1 text-xs text-slate-500">
          Boleh 0 (cicilan 100% bunga) atau lebih.
        </p>
      )}
    </div>
  );
}

interface SourceAccountFieldProps {
  fieldId: (key: string) => string;
  value: string;
  error: string | undefined;
  accounts: Account[];
  disabled?: boolean;
  onChange: (e: ChangeEvent<HTMLSelectElement>) => void;
}

function SourceAccountField({
  fieldId,
  value,
  error,
  accounts,
  disabled,
  onChange,
}: SourceAccountFieldProps) {
  return (
    <div>
      <label htmlFor={fieldId("sourceAccountId")} className="form-label">
        Akun sumber <span className="font-normal text-slate-400">(opsional)</span>
      </label>
      <select
        id={fieldId("sourceAccountId")}
        name="sourceAccountId"
        className="form-input mt-1 min-h-12 py-3 text-base"
        value={value}
        onChange={onChange}
        disabled={disabled}
        aria-invalid={error ? "true" : "false"}
        aria-describedby={
          error ? fieldId("sourceAccountId-error") : fieldId("sourceAccountId-hint")
        }
      >
        <option value="">Tunai (tidak linked)</option>
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>
            {account.name} ({ACCOUNT_TYPE_LABEL[account.type as AccountType] ?? account.type})
          </option>
        ))}
      </select>
      {error ? (
        <p id={fieldId("sourceAccountId-error")} className="form-error" role="alert">
          {error}
        </p>
      ) : (
        <p id={fieldId("sourceAccountId-hint")} className="mt-1 text-xs text-slate-500">
          Pilih akun untuk audit trail (cicilan tunai tetap boleh —
          kosongkan untuk &ldquo;Tunai&rdquo;).
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
        maxLength={PAYMENT_NOTE_MAX}
        placeholder="Misal: bayar via m-banking, transfer dari rekening utama"
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
          Maks {PAYMENT_NOTE_MAX} karakter · tersisa {PAYMENT_NOTE_MAX - value.length}
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Loading + submit skeletons                                                 *
 * -------------------------------------------------------------------------- */

export function PaymentFormFieldsSkeleton(): React.ReactNode {
  return (
    <div
      className="grid gap-5"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="h-14 animate-pulse rounded-md bg-slate-100" />
      <div className="h-14 animate-pulse rounded-md bg-slate-100" />
      <div className="grid grid-cols-2 gap-4">
        <div className="h-14 animate-pulse rounded-md bg-slate-100" />
        <div className="h-14 animate-pulse rounded-md bg-slate-100" />
      </div>
      <div className="h-14 animate-pulse rounded-md bg-slate-100" />
      <div className="h-24 animate-pulse rounded-md bg-slate-100" />
      <span className="sr-only">Memuat formulir cicilan...</span>
    </div>
  );
}

export function PaymentSubmitSkeleton(): React.ReactNode {
  return (
    <div
      className="grid gap-5"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="flex items-center gap-3 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-brand-900">
        <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" />
        <span>Menyimpan cicilan...</span>
      </div>
      <div className="h-14 animate-pulse rounded-md bg-slate-100" />
      <div className="h-14 animate-pulse rounded-md bg-slate-100" />
      <div className="grid grid-cols-2 gap-4">
        <div className="h-14 animate-pulse rounded-md bg-slate-100" />
        <div className="h-14 animate-pulse rounded-md bg-slate-100" />
      </div>
      <div className="h-14 animate-pulse rounded-md bg-slate-100" />
      <div className="h-24 animate-pulse rounded-md bg-slate-100" />
      <span className="sr-only">Mengirim cicilan ke server...</span>
    </div>
  );
}
