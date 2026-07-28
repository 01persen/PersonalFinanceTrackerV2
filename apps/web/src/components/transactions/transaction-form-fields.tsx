"use client";

import type { ChangeEvent, ReactNode } from "react";

import {
  ACCOUNT_TYPE_LABEL,
  type Account,
  type AccountType,
} from "@/lib/api/account-client";
import { CATEGORY_KIND_LABEL, type Category } from "@/lib/api/category-client";
import {
  TRANSACTION_TYPE_LABEL,
  type CreatableTransactionType,
  type TransactionFormErrors,
} from "@/lib/api/transaction-client";

/**
 * Form state shared by the create and edit pages. Currency is implicit
 * (locked to IDR per PRD §10) and not exposed. ``type`` is restricted to
 * ``income`` / ``expense`` — the backend schema rejects ``transfer``
 * here. ``amount`` stays a string (rupiah input) so users can type
 * freely without the integer cents being lost on each keystroke; the
 * submit step converts to cents.
 */
export interface TransactionFormValues {
  type: CreatableTransactionType;
  accountId: string;
  categoryId: string;
  amount: string;
  occurredOn: string;
  note: string;
}

export const TRANSACTION_NOTE_MAX = 2000;

export const INITIAL_TRANSACTION_FORM_VALUES: TransactionFormValues = {
  type: "expense",
  accountId: "",
  categoryId: "",
  amount: "",
  occurredOn: "",
  note: "",
};

/**
 * Today's date in ISO ``YYYY-MM-DD`` form (the native ``<input
 * type="date">`` wire format). Used to seed the date input on the
 * create form so AC (a) holds: user sees a sensible default and just
 * taps "Simpan".
 */
export function todayIsoDate(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export interface AmountValidation {
  ok: true;
  cents: number;
}
export interface AmountValidationFailed {
  ok: false;
  reason: string;
}

/**
 * Validate the free-form amount string the user types. Mirrors the
 * backend ``amount_cents > 0`` rule (Pydantic ``gt=0`` → 422) so the
 * submit button stays disabled (AC (c)) until the value is parseable
 * AND positive. Whitespace, ``.``, ``_``, and ``,`` separators are
 * tolerated so the mobile keyboard layout doesn't trip the form.
 */
export function validateAmount(raw: string): AmountValidation | AmountValidationFailed {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, reason: "Nominal wajib diisi." };
  }

  const normalized = trimmed.replace(/[\s._]/g, "").replace(/,/g, ".");
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    return { ok: false, reason: "Nominal hanya angka (contoh: 25000)." };
  }

  const rupiah = Number.parseFloat(normalized);
  if (!Number.isFinite(rupiah)) {
    return { ok: false, reason: "Nominal tidak valid." };
  }

  if (rupiah <= 0) {
    return { ok: false, reason: "Nominal harus lebih dari 0." };
  }

  return { ok: true, cents: Math.round(rupiah * 100) };
}

/**
 * Same shape as ``isFormDirty`` in the accounts package — kept inline
 * here so the transactions form doesn't take a dependency on the
 * accounts form layer.
 */
export function isTransactionFormDirty(
  current: TransactionFormValues,
  initial: TransactionFormValues,
): boolean {
  return (
    current.type !== initial.type ||
    current.accountId !== initial.accountId ||
    current.categoryId !== initial.categoryId ||
    current.amount !== initial.amount ||
    current.occurredOn !== initial.occurredOn ||
    current.note !== initial.note
  );
}

interface TransactionFormFieldsProps {
  values: TransactionFormValues;
  errors: TransactionFormErrors;
  onChange: (next: TransactionFormValues) => void;
  accounts: Account[];
  categories: Category[];
  disabled?: boolean;
  idPrefix?: string;
}

interface TypeOption {
  value: CreatableTransactionType;
  label: string;
  description: string;
}

const TYPE_OPTIONS: readonly TypeOption[] = [
  {
    value: "expense",
    label: TRANSACTION_TYPE_LABEL.expense,
    description: "Catat uang keluar.",
  },
  {
    value: "income",
    label: TRANSACTION_TYPE_LABEL.income,
    description: "Catat uang masuk.",
  },
] as const;

export function TransactionFormFields({
  values,
  errors,
  onChange,
  accounts,
  categories,
  disabled,
  idPrefix = "transaction-form",
}: TransactionFormFieldsProps) {
  const fieldId = (key: string): string => `${idPrefix}-${key}`;

  const filteredCategories = categories.filter(
    (category) =>
      !category.archived &&
      category.kind === (values.type === "income" ? "income" : "expense"),
  );

  const handleType = (next: CreatableTransactionType): void => {
    onChange({ ...values, type: next, categoryId: "" });
  };
  const handleAccount = (e: ChangeEvent<HTMLSelectElement>): void => {
    onChange({ ...values, accountId: e.target.value });
  };
  const handleCategory = (e: ChangeEvent<HTMLSelectElement>): void => {
    onChange({ ...values, categoryId: e.target.value });
  };
  const handleAmount = (e: ChangeEvent<HTMLInputElement>): void => {
    onChange({ ...values, amount: e.target.value });
  };
  const handleDate = (e: ChangeEvent<HTMLInputElement>): void => {
    onChange({ ...values, occurredOn: e.target.value });
  };
  const handleNote = (e: ChangeEvent<HTMLTextAreaElement>): void => {
    onChange({ ...values, note: e.target.value });
  };

  const accountError = errors.accountId;
  const amountError = errors.amountCents;
  const dateError = errors.occurredOn;
  const noteError = errors.note;
  const categoryError = errors.categoryId;
  const typeError = errors.type;

  return (
    <div className="grid gap-5">
      <TypeToggle
        fieldId={fieldId}
        value={values.type}
        error={typeError}
        disabled={disabled}
        onChange={handleType}
      />

      <AmountField
        fieldId={fieldId}
        value={values.amount}
        error={amountError}
        disabled={disabled}
        onChange={handleAmount}
      />

      <DateField
        fieldId={fieldId}
        value={values.occurredOn}
        error={dateError}
        disabled={disabled}
        onChange={handleDate}
      />

      <AccountField
        fieldId={fieldId}
        value={values.accountId}
        error={accountError}
        accounts={accounts}
        disabled={disabled}
        onChange={handleAccount}
      />

      <CategoryField
        fieldId={fieldId}
        value={values.categoryId}
        error={categoryError}
        categories={filteredCategories}
        kindLabel={CATEGORY_KIND_LABEL[values.type]}
        disabled={disabled}
        onChange={handleCategory}
      />

      <NoteField
        fieldId={fieldId}
        value={values.note}
        error={noteError}
        disabled={disabled}
        onChange={handleNote}
      />
    </div>
  );
}

interface TypeToggleProps {
  fieldId: (key: string) => string;
  value: CreatableTransactionType;
  error: string | undefined;
  disabled?: boolean;
  onChange: (next: CreatableTransactionType) => void;
}

function TypeToggle({ fieldId, value, error, disabled, onChange }: TypeToggleProps) {
  return (
    <fieldset>
      <legend className="form-label">Tipe transaksi</legend>
      <div
        role="radiogroup"
        aria-label="Tipe transaksi"
        aria-invalid={error ? "true" : "false"}
        className="mt-2 grid grid-cols-2 gap-2 sm:flex sm:gap-3"
      >
        {TYPE_OPTIONS.map((option) => {
          const isActive = option.value === value;
          const activeClasses =
            option.value === "income"
              ? "border-emerald-500 bg-emerald-500 text-white shadow"
              : "border-rose-500 bg-rose-500 text-white shadow";
          const inactiveClasses =
            "border-slate-200 bg-white text-slate-700 hover:border-slate-300";
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={isActive}
              onClick={() => onChange(option.value)}
              disabled={disabled}
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
        Transfer antar akun punya alur terpisah (sub-0003-03).
      </p>
      {error ? (
        <p id={fieldId("type-error")} className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

interface AmountFieldProps {
  fieldId: (key: string) => string;
  value: string;
  error: string | undefined;
  disabled?: boolean;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
}

function AmountField({ fieldId, value, error, disabled, onChange }: AmountFieldProps) {
  return (
    <div>
      <label htmlFor={fieldId("amount")} className="form-label">
        Nominal (IDR)
      </label>
      <div className="relative mt-1">
        <span
          className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-base font-semibold text-slate-500"
          aria-hidden="true"
        >
          Rp
        </span>
        <input
          id={fieldId("amount")}
          name="amount"
          type="text"
          inputMode="decimal"
          pattern="-?[0-9., _]*"
          placeholder="0"
          autoComplete="off"
          className="form-input min-h-12 py-3 pl-10 text-lg font-semibold tabular-nums"
          value={value}
          onChange={onChange}
          disabled={disabled}
          aria-invalid={error ? "true" : "false"}
          aria-describedby={
            error ? fieldId("amount-error") : fieldId("amount-hint")
          }
        />
      </div>
      {error ? (
        <p id={fieldId("amount-error")} className="form-error" role="alert">
          {error}
        </p>
      ) : (
        <p id={fieldId("amount-hint")} className="mt-1 text-xs text-slate-500">
          Gunakan angka saja. Bilangan bulat akan disimpan sebagai rupiah penuh.
        </p>
      )}
    </div>
  );
}

interface DateFieldProps {
  fieldId: (key: string) => string;
  value: string;
  error: string | undefined;
  disabled?: boolean;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
}

function DateField({ fieldId, value, error, disabled, onChange }: DateFieldProps) {
  return (
    <div>
      <label htmlFor={fieldId("occurredOn")} className="form-label">
        Tanggal
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
        <p
          id={fieldId("occurredOn-error")}
          className="form-error"
          role="alert"
        >
          {error}
        </p>
      ) : (
        <p id={fieldId("occurredOn-hint")} className="mt-1 text-xs text-slate-500">
          Tap untuk membuka date picker bawaan peramban / HP.
        </p>
      )}
    </div>
  );
}

interface AccountFieldProps {
  fieldId: (key: string) => string;
  value: string;
  error: string | undefined;
  accounts: Account[];
  disabled?: boolean;
  onChange: (e: ChangeEvent<HTMLSelectElement>) => void;
}

function AccountField({
  fieldId,
  value,
  error,
  accounts,
  disabled,
  onChange,
}: AccountFieldProps) {
  return (
    <div>
      <label htmlFor={fieldId("accountId")} className="form-label">
        Akun
      </label>
      <select
        id={fieldId("accountId")}
        name="accountId"
        required
        className="form-input mt-1 min-h-12 py-3 text-base"
        value={value}
        onChange={onChange}
        disabled={disabled}
        aria-invalid={error ? "true" : "false"}
        aria-describedby={
          error ? fieldId("accountId-error") : fieldId("accountId-hint")
        }
      >
        <option value="">Pilih akun...</option>
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>
            {account.name} ({ACCOUNT_TYPE_LABEL[account.type as AccountType] ?? account.type})
          </option>
        ))}
      </select>
      {error ? (
        <p
          id={fieldId("accountId-error")}
          className="form-error"
          role="alert"
        >
          {error}
        </p>
      ) : (
        <p id={fieldId("accountId-hint")} className="mt-1 text-xs text-slate-500">
          Akun yang mencatat transaksi ini. Akun arsip tidak ditampilkan.
        </p>
      )}
    </div>
  );
}

interface CategoryFieldProps {
  fieldId: (key: string) => string;
  value: string;
  error: string | undefined;
  categories: Category[];
  kindLabel: string;
  disabled?: boolean;
  onChange: (e: ChangeEvent<HTMLSelectElement>) => void;
}

function CategoryField({
  fieldId,
  value,
  error,
  categories,
  kindLabel,
  disabled,
  onChange,
}: CategoryFieldProps) {
  const emptyMessage = `Belum ada kategori ${kindLabel.toLowerCase()}.`;
  return (
    <div>
      <label htmlFor={fieldId("categoryId")} className="form-label">
        Kategori <span className="font-normal text-slate-400">(opsional)</span>
      </label>
      <select
        id={fieldId("categoryId")}
        name="categoryId"
        className="form-input mt-1 min-h-12 py-3 text-base"
        value={value}
        onChange={onChange}
        disabled={disabled}
        aria-invalid={error ? "true" : "false"}
        aria-describedby={
          error ? fieldId("categoryId-error") : fieldId("categoryId-hint")
        }
      >
        <option value="">Tanpa kategori</option>
        {categories.length === 0 ? (
          <option value="" disabled>
            {emptyMessage}
          </option>
        ) : (
          categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.parentId ? `↳ ${category.name}` : category.name}
            </option>
          ))
        )}
      </select>
      {error ? (
        <p
          id={fieldId("categoryId-error")}
          className="form-error"
          role="alert"
        >
          {error}
        </p>
      ) : (
        <p id={fieldId("categoryId-hint")} className="mt-1 text-xs text-slate-500">
          Pilih kategori sesuai tipe. Tidak wajib, tapi membantu laporan bulanan.
        </p>
      )}
    </div>
  );
}

interface NoteFieldProps {
  fieldId: (key: string) => string;
  value: string;
  error: string | undefined;
  disabled?: boolean;
  onChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
}

function NoteField({ fieldId, value, error, disabled, onChange }: NoteFieldProps) {
  const remaining = TRANSACTION_NOTE_MAX - value.length;
  return (
    <div>
      <label htmlFor={fieldId("note")} className="form-label">
        Catatan <span className="font-normal text-slate-400">(opsional)</span>
      </label>
      <textarea
        id={fieldId("note")}
        name="note"
        rows={3}
        maxLength={TRANSACTION_NOTE_MAX}
        placeholder="Misal: makan siang sama tim"
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
          Maks {TRANSACTION_NOTE_MAX} karakter · tersisa {remaining}
        </p>
      )}
    </div>
  );
}

/**
 * Loading skeleton shown while the accounts/categories prefetch is in
 * flight (AC (d): loading skeleton visible during submit + while the
 * form dependencies resolve on the edit page). Mirrors the field layout
 * 1:1 so the form doesn't jump when data lands.
 */
export function TransactionFormFieldsSkeleton(): ReactNode {
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
      <div className="h-14 animate-pulse rounded-md bg-slate-100" />
      <div className="h-14 animate-pulse rounded-md bg-slate-100" />
      <div className="h-24 animate-pulse rounded-md bg-slate-100" />
      <span className="sr-only">Memuat formulir transaksi...</span>
    </div>
  );
}