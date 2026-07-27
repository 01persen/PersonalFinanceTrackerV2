"use client";

import type { ChangeEvent } from "react";

import {
  ACCOUNT_TYPE_LABEL,
  ACCOUNT_TYPE_VALUES,
  type AccountFormErrors,
  type AccountType,
} from "@/lib/api/account-client";

/**
 * Form state shared by the create and edit pages. Currency is implicit
 * (locked to IDR per PRD §10) and not exposed. `archived` is only meaningful
 * on the edit page — the create form sends `false` implicitly.
 */
export interface AccountFormValues {
  name: string;
  type: AccountType;
  openingBalance: string;
  archived: boolean;
}

export const INITIAL_ACCOUNT_FORM_VALUES: AccountFormValues = {
  name: "",
  type: "cash",
  openingBalance: "0",
  archived: false,
};

export const ACCOUNT_NAME_MAX = 120;
export const ACCOUNT_NAME_MIN = 1;

/**
 * TL decision (sub-0002-04): opening_balance_cents boleh negatif untuk
 * type=credit_card (represent outstanding debt). Tetapkan ≥ 0 hanya untuk
 * tipe asset. Validasi client-side mirror backend — `openingBalance` di
 * form layer adalah string rupiah; aturan ini membatasinya sebelum dikonversi
 * ke cents.
 */
export function validateOpeningBalance(
  raw: string,
  type: AccountType,
): { ok: true; cents: number } | { ok: false; reason: string } {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, reason: "Saldo pembuka wajib diisi." };
  }

  const normalized = trimmed.replace(/[\s._]/g, "").replace(/,/g, ".");
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
    return { ok: false, reason: "Saldo pembuka hanya angka (contoh: 250000)." };
  }

  const rupiah = Number.parseFloat(normalized);
  if (!Number.isFinite(rupiah)) {
    return { ok: false, reason: "Saldo pembuka tidak valid." };
  }

  // Frontend mirrors the backend `ge=0` rule. The TL decision elevates
  // credit_card to also allow negatives; this is the single client-side
  // divergence, called out below.
  if (type !== "credit_card" && rupiah < 0) {
    return {
      ok: false,
      reason: "Saldo pembuka tidak boleh negatif untuk akun selain kartu kredit.",
    };
  }

  // Cents = rupiah * 100. We round to handle sub-rupiah gracefully even
  // though the MVP only ships whole-rupiah inputs.
  const cents = Math.round(rupiah * 100);
  return { ok: true, cents };
}

export function isFormDirty(
  current: AccountFormValues,
  initial: AccountFormValues,
): boolean {
  return (
    current.name !== initial.name ||
    current.type !== initial.type ||
    current.openingBalance !== initial.openingBalance ||
    current.archived !== initial.archived
  );
}

interface AccountFormFieldsProps {
  values: AccountFormValues;
  errors: AccountFormErrors;
  onChange: (next: AccountFormValues) => void;
  showArchived: boolean;
  disabled?: boolean;
  idPrefix?: string;
}

export function AccountFormFields({
  values,
  errors,
  onChange,
  showArchived,
  disabled,
  idPrefix = "account",
}: AccountFormFieldsProps) {
  const fieldId = (key: string): string => `${idPrefix}-${key}`;

  const handleName = (e: ChangeEvent<HTMLInputElement>): void => {
    onChange({ ...values, name: e.target.value });
  };
  const handleType = (e: ChangeEvent<HTMLSelectElement>): void => {
    const nextType = e.target.value as AccountType;
    if ((ACCOUNT_TYPE_VALUES as readonly string[]).includes(nextType)) {
      onChange({ ...values, type: nextType });
    }
  };
  const handleBalance = (e: ChangeEvent<HTMLInputElement>): void => {
    onChange({ ...values, openingBalance: e.target.value });
  };
  const handleArchived = (e: ChangeEvent<HTMLInputElement>): void => {
    onChange({ ...values, archived: e.target.checked });
  };

  const isCreditCard = values.type === "credit_card";
  const balanceHint = isCreditCard
    ? "Boleh negatif untuk kartu kredit (utang belum lunas)."
    : "Minimal Rp 0 untuk kas, bank, dompet digital, investasi, dan lainnya.";

  return (
    <div className="grid gap-4">
      <div>
        <label htmlFor={fieldId("name")} className="form-label">
          Nama akun
        </label>
        <input
          id={fieldId("name")}
          name="name"
          type="text"
          required
          maxLength={ACCOUNT_NAME_MAX}
          autoComplete="off"
          placeholder="Contoh: BCA, Dompet Utama, OVO"
          className="form-input mt-1"
          value={values.name}
          onChange={handleName}
          disabled={disabled}
          aria-invalid={errors.name ? "true" : "false"}
          aria-describedby={errors.name ? fieldId("name-error") : fieldId("name-hint")}
        />
        {errors.name ? (
          <p id={fieldId("name-error")} className="form-error" role="alert">
            {errors.name}
          </p>
        ) : (
          <p id={fieldId("name-hint")} className="mt-1 text-xs text-slate-500">
            Wajib, 1–{ACCOUNT_NAME_MAX} karakter.
          </p>
        )}
      </div>

      <div>
        <label htmlFor={fieldId("type")} className="form-label">
          Tipe akun
        </label>
        <select
          id={fieldId("type")}
          name="type"
          className="form-input mt-1"
          value={values.type}
          onChange={handleType}
          disabled={disabled}
          aria-invalid={errors.type ? "true" : "false"}
          aria-describedby={errors.type ? fieldId("type-error") : fieldId("type-hint")}
        >
          {ACCOUNT_TYPE_VALUES.map((type) => (
            <option key={type} value={type}>
              {ACCOUNT_TYPE_LABEL[type]}
            </option>
          ))}
        </select>
        {errors.type ? (
          <p id={fieldId("type-error")} className="form-error" role="alert">
            {errors.type}
          </p>
        ) : (
          <p id={fieldId("type-hint")} className="mt-1 text-xs text-slate-500">
            Tentukan apakah akun ini aset (kas, bank, dll.) atau liabilitas (kartu kredit).
          </p>
        )}
      </div>

      <div>
        <label htmlFor={fieldId("openingBalance")} className="form-label">
          Saldo pembuka (IDR)
        </label>
        <div className="relative mt-1">
          <span
            className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-sm font-semibold text-slate-500"
            aria-hidden="true"
          >
            Rp
          </span>
          <input
            id={fieldId("openingBalance")}
            name="openingBalance"
            type="text"
            inputMode="numeric"
            pattern="-?[0-9., _]*"
            placeholder="0"
            className="form-input pl-10"
            value={values.openingBalance}
            onChange={handleBalance}
            disabled={disabled}
            aria-invalid={errors.openingBalanceCents ? "true" : "false"}
            aria-describedby={
              errors.openingBalanceCents
                ? fieldId("openingBalance-error")
                : fieldId("openingBalance-hint")
            }
          />
        </div>
        {errors.openingBalanceCents ? (
          <p
            id={fieldId("openingBalance-error")}
            className="form-error"
            role="alert"
          >
            {errors.openingBalanceCents}
          </p>
        ) : (
          <p id={fieldId("openingBalance-hint")} className="mt-1 text-xs text-slate-500">
            {balanceHint}
          </p>
        )}
      </div>

      {showArchived ? (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <label
            htmlFor={fieldId("archived")}
            className="flex items-start gap-3 text-sm font-medium text-slate-800"
          >
            <input
              id={fieldId("archived")}
              name="archived"
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              checked={values.archived}
              onChange={handleArchived}
              disabled={disabled}
            />
            <span>
              Arsipkan akun
              <span className="mt-1 block text-xs font-normal text-slate-500">
                Tidak muncul di daftar aktif, tapi sejarah transaksi tetap tersimpan.
              </span>
            </span>
          </label>
        </div>
      ) : null}
    </div>
  );
}
