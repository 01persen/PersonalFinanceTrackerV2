"use client";

import type { ChangeEvent, ReactNode } from "react";

import {
  ACCOUNT_TYPE_LABEL,
  type Account,
  type AccountType,
} from "@/lib/api/account-client";
import {
  DEFAULT_EF_MULTIPLIER_FALLBACK,
  formatIdrFromCents,
  GOAL_KIND_LABEL,
  GOAL_KIND_VALUES,
  type GoalFormErrors,
  type GoalKind,
} from "@/lib/api/goal-client";
import { GOAL_NOTE_MAX } from "@/components/goals/goal-form-state";

/* -------------------------------------------------------------------------- *
 * Form value shape                                                           *
 * -------------------------------------------------------------------------- *
 *
 * Mirrors the FE-camelCase convention used by `account-form-fields` and
 * `transaction-form-fields`. Currency is implicit (locked to IDR per
 * PRD §10) and not exposed. Cents-vs-rupiah split matches the BE
 * contract: amount fields stay as free-form rupiah strings while the
 * user is typing, and the submit step converts to cents.
 *
 * ``startDate`` is optional on create (the BE defaults to today UTC)
 * but the FE seeds it with today so the user sees a sensible default.
 * ``targetDate`` is optional on both kinds per PRD §14 (saving only);
 * the EF form doesn't render a target-date field at all.
 */

export interface GoalFormValues {
  kind: GoalKind;
  name: string;
  targetAmount: string;
  targetDate: string;
  startDate: string;
  jangkaWaktuMonths: string;
  linkedAccountId: string;
  monthlyExpense: string;
  jumlahTanggungan: string;
  multiplier: string;
  notes: string;
}

export const INITIAL_GOAL_FORM_VALUES: GoalFormValues = {
  kind: "saving",
  name: "",
  targetAmount: "",
  targetDate: "",
  startDate: "",
  jangkaWaktuMonths: "",
  linkedAccountId: "",
  monthlyExpense: "",
  jumlahTanggungan: "",
  multiplier: "",
  notes: "",
};

/**
 * Build the initial form values from a persisted `Goal` row (used by
 * the edit page). Mirrors `transactionToFormValues` in the transactions
 * edit page — keeps the conversion explicit so wire shapes can shift
 * without the renderer noticing.
 */
export function goalToFormValues(goal: import("@/lib/api/goal-client").Goal): GoalFormValues {
  return {
    kind: goal.kind,
    name: goal.name,
    targetAmount: centsToRupiahInput(goal.targetAmountCents),
    targetDate: goal.targetDate ?? "",
    startDate: goal.startDate,
    jangkaWaktuMonths: goal.jangkaWaktuMonths === null ? "" : String(goal.jangkaWaktuMonths),
    linkedAccountId: goal.linkedAccountId ?? "",
    monthlyExpense:
      goal.monthlyExpenseCents === null ? "" : centsToRupiahInput(goal.monthlyExpenseCents),
    jumlahTanggungan: goal.jumlahTanggungan === null ? "" : String(goal.jumlahTanggungan),
    multiplier: goal.multiplier === null ? "" : String(goal.multiplier),
    notes: goal.notes ?? "",
  };
}

/**
 * Same shape as `isFormDirty` in the accounts / transactions packages —
 * kept inline so the goals form doesn't take a dependency on either
 * form layer.
 */
export function isGoalFormDirty(
  current: GoalFormValues,
  initial: GoalFormValues,
): boolean {
  return (
    current.kind !== initial.kind ||
    current.name !== initial.name ||
    current.targetAmount !== initial.targetAmount ||
    current.targetDate !== initial.targetDate ||
    current.startDate !== initial.startDate ||
    current.jangkaWaktuMonths !== initial.jangkaWaktuMonths ||
    current.linkedAccountId !== initial.linkedAccountId ||
    current.monthlyExpense !== initial.monthlyExpense ||
    current.jumlahTanggungan !== initial.jumlahTanggungan ||
    current.multiplier !== initial.multiplier ||
    current.notes !== initial.notes
  );
}

/**
 * Convert a cents amount back to a free-form rupiah string for the
 * amount input. ``goal.target_amount_cents`` is always a whole number
 * of cents in the MVP (no fractional rupiah), so this is a straight
 * ``cents / 100`` cast. The submit step re-parses the user's typed
 * value through the same IDR rules via `validateTargetAmount`.
 */
function centsToRupiahInput(cents: number): string {
  return String(Math.round(cents / 100));
}

/**
 * Today's date in ISO `YYYY-MM-DD` form. Mirrors the helper in
 * `transaction-form-fields` so both forms seed their date inputs the
 * same way on the create page.
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
 * Indonesian bookkeeping convention (mirrored from the transactions form
 * validator): comma is the decimal separator, dot/space/underscore are
 * thousand separators. Goal amounts are whole rupiah in the MVP — the
 * schema enforces `target_amount_cents > 0` so a sub-cent value would
 * round-trip to 0 cents and the BE would 422 it.
 */

export interface AmountValidation {
  ok: true;
  cents: number;
}
export interface AmountValidationFailed {
  ok: false;
  reason: string;
}

export function validateTargetAmount(raw: string): AmountValidation | AmountValidationFailed {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, reason: "Nominal target wajib diisi." };
  }

  let intPart: string;
  let decPart: string;

  if (trimmed.includes(",")) {
    if ((trimmed.match(/,/g) ?? []).length > 1) {
      return { ok: false, reason: "Nominal hanya angka (contoh: 25000000 atau 25,5)." };
    }
    const parts = trimmed.split(",");
    intPart = (parts[0] ?? "").replace(/[\s._]/g, "");
    decPart = parts[1] ?? "";
    if (!/^\d*$/.test(intPart)) {
      return { ok: false, reason: "Nominal hanya angka (contoh: 25000000 atau 25,5)." };
    }
    if (decPart !== "" && !/^\d+$/.test(decPart)) {
      return { ok: false, reason: "Nominal hanya angka (contoh: 25000000 atau 25,5)." };
    }
    if (decPart.length > 2) {
      return {
        ok: false,
        reason:
          "Nominal maksimal 2 angka di belakang koma (sen). Nilai lebih kecil dibulatkan ke 0.",
      };
    }
  } else {
    if (/\./.test(trimmed)) {
      return {
        ok: false,
        reason: "Pakai koma untuk desimal (contoh: 25,5). Titik diproses sebagai pemisah ribuan.",
      };
    }
    intPart = trimmed.replace(/[\s_]/g, "");
    decPart = "";
    if (!/^\d+$/.test(intPart)) {
      return { ok: false, reason: "Nominal hanya angka (contoh: 25000000)." };
    }
  }

  if (intPart === "" && decPart === "") {
    return { ok: false, reason: "Nominal target wajib diisi." };
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
 * Number validators                                                          *
 * -------------------------------------------------------------------------- *
 *
 * Lightweight wrappers that return `null` when the input is empty (the
 * field is optional) and a positive integer when parseable. Mirrors
 * the backend schema: `jangka_waktu_months > 0`, `jumlah_tanggungan
 * >= 0`, `multiplier >= 1`. A non-numeric input is a hard validation
 * error.
 */

export interface IntegerValidation {
  ok: true;
  value: number;
}
export interface IntegerValidationFailed {
  ok: false;
  reason: string;
}

export function validatePositiveInteger(
  raw: string,
  fieldLabel: string,
): IntegerValidation | IntegerValidationFailed {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, reason: `${fieldLabel} wajib diisi.` };
  }
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, reason: `${fieldLabel} hanya angka bulat.` };
  }
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, reason: `${fieldLabel} minimal 1.` };
  }
  return { ok: true, value };
}

export function validateNonNegativeInteger(
  raw: string,
  fieldLabel: string,
): IntegerValidation | IntegerValidationFailed {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, reason: `${fieldLabel} wajib diisi.` };
  }
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, reason: `${fieldLabel} hanya angka bulat.` };
  }
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(value)) {
    return { ok: false, reason: `${fieldLabel} tidak valid.` };
  }
  return { ok: true, value };
}

export function validateMultiplier(
  raw: string,
  fieldLabel: string,
): IntegerValidation | IntegerValidationFailed {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, reason: `${fieldLabel} wajib diisi.` };
  }
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, reason: `${fieldLabel} hanya angka bulat.` };
  }
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(value) || value < 1) {
    return { ok: false, reason: `${fieldLabel} minimal 1.` };
  }
  return { ok: true, value };
}

/* -------------------------------------------------------------------------- *
 * Cross-field validators                                                      *
 * -------------------------------------------------------------------------- *
 *
 * `target_date >= start_date` for saving goals. Mirrors the BE rule in
 * `_validate_kind_specific` (sub-0005-01, `goals.py`). Returns the
 * comparison in plain JS so the FE doesn't have to render a generic
 * "invalid date" error from a malformed ISO string.
 */

export function validateTargetDateAgainstStart(
  targetDate: string,
  startDate: string,
): string | null {
  if (targetDate === "" || startDate === "") return null;
  if (targetDate < startDate) {
    return "Tanggal target harus sama dengan atau setelah tanggal mulai.";
  }
  return null;
}

/* -------------------------------------------------------------------------- *
 * Live preview (real-time)                                                   *
 * -------------------------------------------------------------------------- *
 *
 * Mirrors the SA breakdown in sub-0005-04 AC. Saving: tabunganBulanan
 * = target / horizon. EF: targetSnapshot = monthlyExpense x
 * jumlahTanggungan x multiplier; lamaMengumpulkanBulan = targetSnapshot
 * / monthlyExpense (safe div-by-zero). All inputs are cents so the
 * formatter renders the IDR currency prefix without surprises.
 *
 * Returns `null` for individual outputs that can't be computed yet
 * (missing input) so the UI can show "—" instead of `Rp 0` while the
 * user is still typing.
 */

export interface GoalPreview {
  /** Saving: tabunganBulanan (cents). EF: same numerator / denominator. */
  tabunganBulananCents: number | null;
  /** EF only: targetAmountSnapshot (cents). */
  targetSnapshotCents: number | null;
  /** EF only: lamaMengumpulkanBulan (months). */
  lamaMengumpulkanBulan: number | null;
}

export function computeGoalPreview(values: GoalFormValues): GoalPreview {
  if (values.kind === "saving") {
    const targetValidation = validateTargetAmount(values.targetAmount);
    const horizonValidation = validatePositiveInteger(
      values.jangkaWaktuMonths,
      "Jangka waktu",
    );
    if (!targetValidation.ok || !horizonValidation.ok) {
      return { tabunganBulananCents: null, targetSnapshotCents: null, lamaMengumpulkanBulan: null };
    }
    if (horizonValidation.value <= 0) {
      return { tabunganBulananCents: null, targetSnapshotCents: null, lamaMengumpulkanBulan: null };
    }
    return {
      tabunganBulananCents: Math.trunc(targetValidation.cents / horizonValidation.value),
      targetSnapshotCents: null,
      lamaMengumpulkanBulan: null,
    };
  }

  // emergency_fund
  const monthlyValidation = validateTargetAmount(values.monthlyExpense);
  const tanggunganValidation = validateNonNegativeInteger(
    values.jumlahTanggungan,
    "Jumlah tanggungan",
  );
  const multiplierValidation = validateMultiplier(values.multiplier, "Multiplier");
  if (
    !monthlyValidation.ok ||
    !tanggunganValidation.ok ||
    !multiplierValidation.ok
  ) {
    return { tabunganBulananCents: null, targetSnapshotCents: null, lamaMengumpulkanBulan: null };
  }
  if (monthlyValidation.cents <= 0 || tanggunganValidation.value < 0 || multiplierValidation.value < 1) {
    return { tabunganBulananCents: null, targetSnapshotCents: null, lamaMengumpulkanBulan: null };
  }

  const targetSnapshot = Math.trunc(
    monthlyValidation.cents * tanggunganValidation.value * multiplierValidation.value,
  );
  // Safe div-by-zero: monthlyExpense is already > 0 here.
  const lama = Math.trunc(targetSnapshot / monthlyValidation.cents);
  return {
    tabunganBulananCents: lama > 0 ? lama : null,
    targetSnapshotCents: targetSnapshot,
    lamaMengumpulkanBulan: lama > 0 ? lama : null,
  };
}

/* -------------------------------------------------------------------------- *
 * Main fields component                                                      *
 * -------------------------------------------------------------------------- */

interface GoalFormFieldsProps {
  values: GoalFormValues;
  errors: GoalFormErrors;
  onChange: (next: GoalFormValues) => void;
  accounts: Account[];
  /** Default EF multiplier from `/users/me/settings` (PRD §14, default 3). */
  defaultEfMultiplier: number;
  /**
   * When true, the kind toggle is locked to whatever `values.kind`
   * already is. The FE never offers a kind change on edit (the BE
   * rejects `kind` on PATCH with 422 and the SA breakdown calls this
   * out explicitly). Setting this to false lets the create page offer
   * the segmented control.
   */
  kindLocked?: boolean;
  disabled?: boolean;
  idPrefix?: string;
}

export function GoalFormFields({
  values,
  errors,
  onChange,
  accounts,
  defaultEfMultiplier,
  kindLocked = false,
  disabled,
  idPrefix = "goal-form",
}: GoalFormFieldsProps) {
  const fieldId = (key: string): string => `${idPrefix}-${key}`;

  const handleKind = (next: GoalKind): void => {
    if (kindLocked) return;
    // Mirror `transactions/form` kind switch: when the user toggles
    // the kind we reset the kind-specific fields so the user doesn't
    // accidentally save EF values into a saving row (and vice versa).
    // Common fields (name, linkedAccountId, notes, target amount)
    // are intentionally preserved so the user can re-purpose the
    // same form without re-typing the goal title.
    onChange({
      ...INITIAL_GOAL_FORM_VALUES,
      kind: next,
      name: values.name,
      linkedAccountId: values.linkedAccountId,
      notes: values.notes,
      startDate: values.startDate,
    });
  };
  const handleName = (e: ChangeEvent<HTMLInputElement>): void => {
    onChange({ ...values, name: e.target.value });
  };
  const handleTargetAmount = (e: ChangeEvent<HTMLInputElement>): void => {
    onChange({ ...values, targetAmount: e.target.value });
  };
  const handleTargetDate = (e: ChangeEvent<HTMLInputElement>): void => {
    onChange({ ...values, targetDate: e.target.value });
  };
  const handleStartDate = (e: ChangeEvent<HTMLInputElement>): void => {
    onChange({ ...values, startDate: e.target.value });
  };
  const handleJangkaWaktu = (e: ChangeEvent<HTMLInputElement>): void => {
    onChange({ ...values, jangkaWaktuMonths: e.target.value });
  };
  const handleLinkedAccount = (e: ChangeEvent<HTMLSelectElement>): void => {
    onChange({ ...values, linkedAccountId: e.target.value });
  };
  const handleMonthlyExpense = (e: ChangeEvent<HTMLInputElement>): void => {
    onChange({ ...values, monthlyExpense: e.target.value });
  };
  const handleJumlahTanggungan = (e: ChangeEvent<HTMLInputElement>): void => {
    onChange({ ...values, jumlahTanggungan: e.target.value });
  };
  const handleMultiplier = (e: ChangeEvent<HTMLInputElement>): void => {
    onChange({ ...values, multiplier: e.target.value });
  };
  const handleNotes = (e: ChangeEvent<HTMLTextAreaElement>): void => {
    onChange({ ...values, notes: e.target.value });
  };

  return (
    <div className="grid gap-5">
      <KindToggle
        fieldId={fieldId}
        value={values.kind}
        disabled={disabled}
        locked={kindLocked}
        onChange={handleKind}
      />

      <NameField
        fieldId={fieldId}
        value={values.name}
        error={errors.name}
        disabled={disabled}
        onChange={handleName}
      />

      {values.kind === "saving" ? (
        <SavingFields
          fieldId={fieldId}
          values={values}
          errors={errors}
          accounts={accounts}
          disabled={disabled}
          onTargetAmount={handleTargetAmount}
          onTargetDate={handleTargetDate}
          onStartDate={handleStartDate}
          onJangkaWaktu={handleJangkaWaktu}
          onLinkedAccount={handleLinkedAccount}
        />
      ) : (
        <EFFields
          fieldId={fieldId}
          values={values}
          errors={errors}
          defaultEfMultiplier={defaultEfMultiplier}
          disabled={disabled}
          onMonthlyExpense={handleMonthlyExpense}
          onJumlahTanggungan={handleJumlahTanggungan}
          onMultiplier={handleMultiplier}
        />
      )}

      <GoalPreviewCard values={values} />

      <NotesField
        fieldId={fieldId}
        value={values.notes}
        error={errors.notes}
        disabled={disabled}
        onChange={handleNotes}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Kind toggle                                                                 *
 * -------------------------------------------------------------------------- *
 *
 * Segmented control with two options: "Saving" and "Emergency Fund".
 * The submit step rejects cross-field leaks (`GoalCreate._validate_
 * kind_specific`), so the FE mirrors that by resetting the
 * kind-specific fields on toggle. When `locked` is set, the toggle
 * becomes a read-only badge — used by the edit page because the BE
 * rejects `kind` on PATCH.
 */

interface KindToggleProps {
  fieldId: (key: string) => string;
  value: GoalKind;
  disabled?: boolean;
  locked?: boolean;
  onChange: (next: GoalKind) => void;
}

function KindToggle({ fieldId, value, disabled, locked = false, onChange }: KindToggleProps) {
  const isFullyDisabled = disabled || locked;
  const options: { value: GoalKind; label: string; description: string }[] = [
    {
      value: "saving",
      label: GOAL_KIND_LABEL.saving,
      description: "Target nominal dengan jangka waktu.",
    },
    {
      value: "emergency_fund",
      label: GOAL_KIND_LABEL.emergency_fund,
      description: "Dihitung dari pengeluaran bulanan × tanggungan × multiplier.",
    },
  ];

  return (
    <fieldset>
      <legend className="form-label">Tipe goal</legend>
      <div
        role="radiogroup"
        aria-label="Tipe goal"
        className="mt-2 grid grid-cols-2 gap-2 sm:flex sm:gap-3"
      >
        {options.map((option) => {
          const isActive = option.value === value;
          const activeClasses =
            option.value === "saving"
              ? "border-brand-500 bg-brand-500 text-white shadow"
              : "border-emerald-500 bg-emerald-500 text-white shadow";
          const inactiveClasses =
            "border-slate-200 bg-white text-slate-700 hover:border-slate-300";
          const clickable = !isFullyDisabled && !isActive;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={isActive}
              onClick={() => {
                if (!clickable) return;
                if (!(GOAL_KIND_VALUES as readonly string[]).includes(option.value)) return;
                onChange(option.value);
              }}
              disabled={isFullyDisabled}
              data-testid={`${fieldId("kind")}-${option.value}`}
              className={`flex min-h-12 flex-col items-start justify-center rounded-xl border-2 px-4 py-3 text-left transition focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 ${
                isActive ? activeClasses : inactiveClasses
              }`}
            >
              <span className="text-base font-semibold">{option.label}</span>
              <span
                className={`mt-0.5 text-xs ${
                  isActive ? "text-white/90" : "text-slate-500"
                }`}
              >
                {option.description}
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-slate-500">
        {locked
          ? "Tipe goal ditetapkan saat pembuatan dan tidak dapat diubah dari form ini."
          : "Mengubah tipe akan mengosongkan isian khusus tipe (jangka waktu atau multiplier)."}
      </p>
    </fieldset>
  );
}

/* -------------------------------------------------------------------------- *
 * Name field                                                                  *
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
        Nama goal
      </label>
      <input
        id={fieldId("name")}
        name="name"
        type="text"
        required
        maxLength={120}
        autoComplete="off"
        placeholder="Contoh: Liburan ke Bali, Dana Darurat 6 Bulan"
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
          Wajib, 1–120 karakter.
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Saving fields                                                               *
 * -------------------------------------------------------------------------- */

interface SavingFieldsProps {
  fieldId: (key: string) => string;
  values: GoalFormValues;
  errors: GoalFormErrors;
  accounts: Account[];
  disabled?: boolean;
  onTargetAmount: (e: ChangeEvent<HTMLInputElement>) => void;
  onTargetDate: (e: ChangeEvent<HTMLInputElement>) => void;
  onStartDate: (e: ChangeEvent<HTMLInputElement>) => void;
  onJangkaWaktu: (e: ChangeEvent<HTMLInputElement>) => void;
  onLinkedAccount: (e: ChangeEvent<HTMLSelectElement>) => void;
}

function SavingFields({
  fieldId,
  values,
  errors,
  accounts,
  disabled,
  onTargetAmount,
  onTargetDate,
  onStartDate,
  onJangkaWaktu,
  onLinkedAccount,
}: SavingFieldsProps) {
  return (
    <>
      <TargetAmountField
        fieldId={fieldId}
        value={values.targetAmount}
        error={errors.targetAmountCents}
        disabled={disabled}
        onChange={onTargetAmount}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <StartDateField
          fieldId={fieldId}
          value={values.startDate}
          error={errors.startDate}
          disabled={disabled}
          onChange={onStartDate}
        />
        <TargetDateField
          fieldId={fieldId}
          value={values.targetDate}
          error={errors.targetDate}
          disabled={disabled}
          onChange={onTargetDate}
        />
      </div>

      <JangkaWaktuField
        fieldId={fieldId}
        value={values.jangkaWaktuMonths}
        error={errors.jangkaWaktuMonths}
        disabled={disabled}
        onChange={onJangkaWaktu}
      />

      <LinkedAccountField
        fieldId={fieldId}
        value={values.linkedAccountId}
        error={errors.linkedAccountId}
        accounts={accounts}
        disabled={disabled}
        onChange={onLinkedAccount}
      />
    </>
  );
}

interface TargetAmountFieldProps {
  fieldId: (key: string) => string;
  value: string;
  error: string | undefined;
  disabled?: boolean;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
}

function TargetAmountField({ fieldId, value, error, disabled, onChange }: TargetAmountFieldProps) {
  return (
    <div>
      <label htmlFor={fieldId("targetAmount")} className="form-label">
        Nominal target (IDR)
      </label>
      <div className="relative mt-1">
        <span
          className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-base font-semibold text-slate-500"
          aria-hidden="true"
        >
          Rp
        </span>
        <input
          id={fieldId("targetAmount")}
          name="targetAmount"
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
          aria-describedby={error ? fieldId("targetAmount-error") : fieldId("targetAmount-hint")}
        />
      </div>
      {error ? (
        <p id={fieldId("targetAmount-error")} className="form-error" role="alert">
          {error}
        </p>
      ) : (
        <p id={fieldId("targetAmount-hint")} className="mt-1 text-xs text-slate-500">
          Wajib lebih dari Rp 0. Pakai koma untuk desimal, titik untuk ribuan.
        </p>
      )}
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

function StartDateField({ fieldId, value, error, disabled, onChange }: StartDateFieldProps) {
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
        aria-describedby={error ? fieldId("startDate-error") : fieldId("startDate-hint")}
      />
      {error ? (
        <p id={fieldId("startDate-error")} className="form-error" role="alert">
          {error}
        </p>
      ) : (
        <p id={fieldId("startDate-hint")} className="mt-1 text-xs text-slate-500">
          Default hari ini (UTC) bila dikosongkan.
        </p>
      )}
    </div>
  );
}

interface TargetDateFieldProps {
  fieldId: (key: string) => string;
  value: string;
  error: string | undefined;
  disabled?: boolean;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
}

function TargetDateField({ fieldId, value, error, disabled, onChange }: TargetDateFieldProps) {
  return (
    <div>
      <label htmlFor={fieldId("targetDate")} className="form-label">
        Tanggal target <span className="font-normal text-slate-400">(opsional)</span>
      </label>
      <input
        id={fieldId("targetDate")}
        name="targetDate"
        type="date"
        className="form-input mt-1 min-h-12 py-3 text-base"
        value={value}
        onChange={onChange}
        disabled={disabled}
        aria-invalid={error ? "true" : "false"}
        aria-describedby={error ? fieldId("targetDate-error") : fieldId("targetDate-hint")}
      />
      {error ? (
        <p id={fieldId("targetDate-error")} className="form-error" role="alert">
          {error}
        </p>
      ) : (
        <p id={fieldId("targetDate-hint")} className="mt-1 text-xs text-slate-500">
          Harus sama dengan atau setelah tanggal mulai.
        </p>
      )}
    </div>
  );
}

interface JangkaWaktuFieldProps {
  fieldId: (key: string) => string;
  value: string;
  error: string | undefined;
  disabled?: boolean;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
}

function JangkaWaktuField({ fieldId, value, error, disabled, onChange }: JangkaWaktuFieldProps) {
  return (
    <div>
      <label htmlFor={fieldId("jangkaWaktuMonths")} className="form-label">
        Jangka waktu (bulan)
      </label>
      <input
        id={fieldId("jangkaWaktuMonths")}
        name="jangkaWaktuMonths"
        type="number"
        inputMode="numeric"
        min={1}
        step={1}
        required
        autoComplete="off"
        placeholder="12"
        className="form-input mt-1 min-h-12 py-3 text-base"
        value={value}
        onChange={onChange}
        disabled={disabled}
        aria-invalid={error ? "true" : "false"}
        aria-describedby={
          error ? fieldId("jangkaWaktuMonths-error") : fieldId("jangkaWaktuMonths-hint")
        }
      />
      {error ? (
        <p id={fieldId("jangkaWaktuMonths-error")} className="form-error" role="alert">
          {error}
        </p>
      ) : (
        <p id={fieldId("jangkaWaktuMonths-hint")} className="mt-1 text-xs text-slate-500">
          Wajib lebih dari 0. Dipakai untuk hitung tabungan bulanan otomatis.
        </p>
      )}
    </div>
  );
}

interface LinkedAccountFieldProps {
  fieldId: (key: string) => string;
  value: string;
  error: string | undefined;
  accounts: Account[];
  disabled?: boolean;
  onChange: (e: ChangeEvent<HTMLSelectElement>) => void;
}

function LinkedAccountField({
  fieldId,
  value,
  error,
  accounts,
  disabled,
  onChange,
}: LinkedAccountFieldProps) {
  return (
    <div>
      <label htmlFor={fieldId("linkedAccountId")} className="form-label">
        Akun terkait <span className="font-normal text-slate-400">(opsional)</span>
      </label>
      <select
        id={fieldId("linkedAccountId")}
        name="linkedAccountId"
        className="form-input mt-1 min-h-12 py-3 text-base"
        value={value}
        onChange={onChange}
        disabled={disabled}
        aria-invalid={error ? "true" : "false"}
        aria-describedby={
          error ? fieldId("linkedAccountId-error") : fieldId("linkedAccountId-hint")
        }
      >
        <option value="">Tidak linked (input manual)</option>
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>
            {account.name} ({ACCOUNT_TYPE_LABEL[account.type as AccountType] ?? account.type})
          </option>
        ))}
      </select>
      {error ? (
        <p id={fieldId("linkedAccountId-error")} className="form-error" role="alert">
          {error}
        </p>
      ) : (
        <p id={fieldId("linkedAccountId-hint")} className="mt-1 text-xs text-slate-500">
          Pilih akun untuk auto-update current amount dari saldo. Kosongkan untuk input manual.
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * EF fields                                                                   *
 * -------------------------------------------------------------------------- */

interface EFFieldsProps {
  fieldId: (key: string) => string;
  values: GoalFormValues;
  errors: GoalFormErrors;
  defaultEfMultiplier: number;
  disabled?: boolean;
  onMonthlyExpense: (e: ChangeEvent<HTMLInputElement>) => void;
  onJumlahTanggungan: (e: ChangeEvent<HTMLInputElement>) => void;
  onMultiplier: (e: ChangeEvent<HTMLInputElement>) => void;
}

function EFFields({
  fieldId,
  values,
  errors,
  defaultEfMultiplier,
  disabled,
  onMonthlyExpense,
  onJumlahTanggungan,
  onMultiplier,
}: EFFieldsProps) {
  const effectiveDefault = values.multiplier === "" ? defaultEfMultiplier : null;
  return (
    <>
      <MonthlyExpenseField
        fieldId={fieldId}
        value={values.monthlyExpense}
        error={errors.monthlyExpenseCents}
        disabled={disabled}
        onChange={onMonthlyExpense}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <JumlahTanggunganField
          fieldId={fieldId}
          value={values.jumlahTanggungan}
          error={errors.jumlahTanggungan}
          disabled={disabled}
          onChange={onJumlahTanggungan}
        />
        <MultiplierField
          fieldId={fieldId}
          value={values.multiplier}
          error={errors.multiplier}
          disabled={disabled}
          onChange={onMultiplier}
          defaultEfMultiplier={effectiveDefault}
        />
      </div>
    </>
  );
}

interface MonthlyExpenseFieldProps {
  fieldId: (key: string) => string;
  value: string;
  error: string | undefined;
  disabled?: boolean;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
}

function MonthlyExpenseField({
  fieldId,
  value,
  error,
  disabled,
  onChange,
}: MonthlyExpenseFieldProps) {
  return (
    <div>
      <label htmlFor={fieldId("monthlyExpense")} className="form-label">
        Pengeluaran bulanan (IDR)
      </label>
      <div className="relative mt-1">
        <span
          className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-base font-semibold text-slate-500"
          aria-hidden="true"
        >
          Rp
        </span>
        <input
          id={fieldId("monthlyExpense")}
          name="monthlyExpense"
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
          aria-describedby={error ? fieldId("monthlyExpense-error") : fieldId("monthlyExpense-hint")}
        />
      </div>
      {error ? (
        <p id={fieldId("monthlyExpense-error")} className="form-error" role="alert">
          {error}
        </p>
      ) : (
        <p id={fieldId("monthlyExpense-hint")} className="mt-1 text-xs text-slate-500">
          Snapshot total pengeluaran rumah tangga per bulan. Wajib lebih dari Rp 0.
        </p>
      )}
    </div>
  );
}

interface JumlahTanggunganFieldProps {
  fieldId: (key: string) => string;
  value: string;
  error: string | undefined;
  disabled?: boolean;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
}

function JumlahTanggunganField({
  fieldId,
  value,
  error,
  disabled,
  onChange,
}: JumlahTanggunganFieldProps) {
  return (
    <div>
      <label htmlFor={fieldId("jumlahTanggungan")} className="form-label">
        Jumlah tanggungan
      </label>
      <input
        id={fieldId("jumlahTanggungan")}
        name="jumlahTanggungan"
        type="number"
        inputMode="numeric"
        min={0}
        step={1}
        required
        autoComplete="off"
        placeholder="0"
        className="form-input mt-1 min-h-12 py-3 text-base"
        value={value}
        onChange={onChange}
        disabled={disabled}
        aria-invalid={error ? "true" : "false"}
        aria-describedby={
          error ? fieldId("jumlahTanggungan-error") : fieldId("jumlahTanggungan-hint")
        }
      />
      {error ? (
        <p id={fieldId("jumlahTanggungan-error")} className="form-error" role="alert">
          {error}
        </p>
      ) : (
        <p id={fieldId("jumlahTanggungan-hint")} className="mt-1 text-xs text-slate-500">
          0 untuk single, 1 untuk satu tanggungan, dst. Boleh 0.
        </p>
      )}
    </div>
  );
}

interface MultiplierFieldProps {
  fieldId: (key: string) => string;
  value: string;
  error: string | undefined;
  disabled?: boolean;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  /**
   * Default from `/users/me/settings`. Surfaces only when the user
   * hasn't typed anything yet so the hint can say "Default: 3× dari
   * setting Anda". When `null` (user already typed a value), the hint
   * falls back to the static copy.
   */
  defaultEfMultiplier: number | null;
}

function MultiplierField({
  fieldId,
  value,
  error,
  disabled,
  onChange,
  defaultEfMultiplier,
}: MultiplierFieldProps) {
  const hintId = fieldId("multiplier-hint");
  const fallbackDefault = DEFAULT_EF_MULTIPLIER_FALLBACK;
  const hintText =
    defaultEfMultiplier !== null
      ? `Default: ${defaultEfMultiplier}× dari setting Anda. Ubah jika perlu.`
      : `Default ${fallbackDefault}× berlaku bila dikosongkan.`;
  return (
    <div>
      <label htmlFor={fieldId("multiplier")} className="form-label">
        Multiplier
      </label>
      <input
        id={fieldId("multiplier")}
        name="multiplier"
        type="number"
        inputMode="numeric"
        min={1}
        step={1}
        required
        autoComplete="off"
        placeholder={defaultEfMultiplier !== null ? String(defaultEfMultiplier) : "3"}
        className="form-input mt-1 min-h-12 py-3 text-base"
        value={value}
        onChange={onChange}
        disabled={disabled}
        aria-invalid={error ? "true" : "false"}
        aria-describedby={error ? fieldId("multiplier-error") : hintId}
      />
      {error ? (
        <p id={fieldId("multiplier-error")} className="form-error" role="alert">
          {error}
        </p>
      ) : (
        <p id={hintId} className="mt-1 text-xs text-slate-500">
          {hintText}
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Live preview card                                                           *
 * -------------------------------------------------------------------------- *
 *
 * Pure render of `computeGoalPreview(values)`. Re-renders on every
 * keystroke because `values` is controlled. Skips a panel entirely
 * when the corresponding output is `null` so the user doesn't see a
 * "—" placeholder for fields that don't apply to the current kind.
 */

interface GoalPreviewCardProps {
  values: GoalFormValues;
}

function GoalPreviewCard({ values }: GoalPreviewCardProps) {
  const preview = computeGoalPreview(values);
  if (values.kind === "saving") {
    return (
      <aside
        className="rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-900"
        role="status"
        aria-live="polite"
        data-testid="goal-preview"
      >
        <p className="font-semibold">Pratinjau real-time</p>
        <dl className="mt-2 grid gap-1">
          <div className="flex items-baseline justify-between gap-2">
            <dt>Tabungan bulanan</dt>
            <dd className="tabular-nums">
              {preview.tabunganBulananCents !== null
                ? formatIdrFromCents(preview.tabunganBulananCents)
                : "—"}
            </dd>
          </div>
        </dl>
        <p className="mt-2 text-xs text-brand-700">
          Rumus: nominal target ÷ jangka waktu (auto-calc BE, dihitung server saat simpan).
        </p>
      </aside>
    );
  }

  return (
    <aside
      className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
      role="status"
      aria-live="polite"
      data-testid="goal-preview"
    >
      <p className="font-semibold">Pratinjau real-time</p>
      <dl className="mt-2 grid gap-1">
        <div className="flex items-baseline justify-between gap-2">
          <dt>Target dana darurat</dt>
          <dd className="tabular-nums">
            {preview.targetSnapshotCents !== null
              ? formatIdrFromCents(preview.targetSnapshotCents)
              : "—"}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <dt>Lama mengumpulkan</dt>
          <dd className="tabular-nums">
            {preview.lamaMengumpulkanBulan !== null
              ? `${preview.lamaMengumpulkanBulan} bulan`
              : "—"}
          </dd>
        </div>
      </dl>
      <p className="mt-2 text-xs text-emerald-700">
        Snapshot di-freeze saat create (PRD §14). Patch tidak mengubah ulang.
      </p>
    </aside>
  );
}

/* -------------------------------------------------------------------------- *
 * Notes field                                                                 *
 * -------------------------------------------------------------------------- */

interface NotesFieldProps {
  fieldId: (key: string) => string;
  value: string;
  error: string | undefined;
  disabled?: boolean;
  onChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
}

function NotesField({ fieldId, value, error, disabled, onChange }: NotesFieldProps) {
  return (
    <div>
      <label htmlFor={fieldId("notes")} className="form-label">
        Catatan <span className="font-normal text-slate-400">(opsional)</span>
      </label>
      <textarea
        id={fieldId("notes")}
        name="notes"
        rows={3}
        maxLength={GOAL_NOTE_MAX}
        placeholder="Misal: trigger top-up tiap terima gaji"
        className="form-input mt-1 min-h-24 py-3 text-base"
        value={value}
        onChange={onChange}
        disabled={disabled}
        aria-invalid={error ? "true" : "false"}
        aria-describedby={error ? fieldId("notes-error") : fieldId("notes-hint")}
      />
      {error ? (
        <p id={fieldId("notes-error")} className="form-error" role="alert">
          {error}
        </p>
      ) : (
        <p id={fieldId("notes-hint")} className="mt-1 text-xs text-slate-500">
          Maks {GOAL_NOTE_MAX} karakter · tersisa {GOAL_NOTE_MAX - value.length}
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Loading + submit skeletons                                                 *
 * -------------------------------------------------------------------------- *
 *
 * Mirrors the `TransactionFormFieldsSkeleton` + `TransactionSubmitSkeleton`
 * pair so the FE has the same loading affordances for goals. The edit
 * page renders `GoalFormFieldsSkeleton` while the prefetch is in flight
 * (so the layout doesn't jump when the data lands), and
 * `GoalSubmitSkeleton` while POST/PATCH is in flight (so the disabled
 * form isn't the only visual cue).
 */

export function GoalFormFieldsSkeleton(): ReactNode {
  return (
    <div
      className="grid gap-5"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="grid grid-cols-2 gap-2 sm:flex sm:gap-3">
        <div className="h-16 animate-pulse rounded-xl bg-slate-100" />
        <div className="h-16 animate-pulse rounded-xl bg-slate-100" />
      </div>
      <div className="h-14 animate-pulse rounded-md bg-slate-100" />
      <div className="h-14 animate-pulse rounded-md bg-slate-100" />
      <div className="grid grid-cols-2 gap-4">
        <div className="h-14 animate-pulse rounded-md bg-slate-100" />
        <div className="h-14 animate-pulse rounded-md bg-slate-100" />
      </div>
      <div className="h-14 animate-pulse rounded-md bg-slate-100" />
      <div className="h-14 animate-pulse rounded-md bg-slate-100" />
      <div className="h-24 animate-pulse rounded-md bg-slate-100" />
      <span className="sr-only">Memuat formulir goal...</span>
    </div>
  );
}

export function GoalSubmitSkeleton(): ReactNode {
  return (
    <div
      className="grid gap-5"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div
        className="flex items-center gap-3 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm text-brand-900"
      >
        <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" />
        <span>Menyimpan goal...</span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:flex sm:gap-3">
        <div className="h-16 animate-pulse rounded-xl bg-slate-100" />
        <div className="h-16 animate-pulse rounded-xl bg-slate-100" />
      </div>
      <div className="h-14 animate-pulse rounded-md bg-slate-100" />
      <div className="h-14 animate-pulse rounded-md bg-slate-100" />
      <div className="grid grid-cols-2 gap-4">
        <div className="h-14 animate-pulse rounded-md bg-slate-100" />
        <div className="h-14 animate-pulse rounded-md bg-slate-100" />
      </div>
      <div className="h-14 animate-pulse rounded-md bg-slate-100" />
      <div className="h-14 animate-pulse rounded-md bg-slate-100" />
      <div className="h-24 animate-pulse rounded-md bg-slate-100" />
      <span className="sr-only">Mengirim goal ke server...</span>
    </div>
  );
}
