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
 * (locked to IDR per PRD §10) and not exposed. ``type`` is restricted
 * to the creatable subset (``income`` / ``expense``) — the backend
 * schema rejects ``transfer`` here, and the edit page maps an existing
 * ``transfer`` row to ``expense`` so the toggle stays consistent with
 * what PATCH will accept (type is server-controlled). ``amount`` stays
 * a string (rupiah input) so users can type freely without the integer
 * cents being lost on each keystroke; the submit step converts to cents.
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
 * AND positive.
 *
 * Locale rules (Indonesian bookkeeping convention):
 * - Comma (``,``) is the decimal separator. ``"25,5"`` → 25.5 rupiah.
 * - Dot, space, underscore are thousand separators. ``"25.000"`` →
 *   25000 rupiah; ``"25_000"`` → 25000 rupiah.
 * - At most ONE decimal separator is allowed, and the decimal portion
 *   is capped at 2 digits (1 cent precision; anything beyond rounds to
 *   0 cents which the backend refuses).
 *
 * Per QA defect (sub-0003-05 cek 1): we now reject values that *round*
 * to 0 cents. Concretely, ``"0,001"`` parses to ``0.001`` rupiah → 1
 * sen → rounds to 0 cents after multiplication. The original validator
 * let it through (``rupiah > 0`` was true), causing the form to submit
 * a payload the backend rejected with 422. The fix mirrors the
 * backend's atomic unit (1 cent = Rp 0.01) so the client cannot ship
 * a payload the backend is guaranteed to refuse.
 */
export function validateAmount(raw: string): AmountValidation | AmountValidationFailed {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, reason: "Nominal wajib diisi." };
  }

  let intPart: string;
  let decPart: string;

  if (trimmed.includes(",")) {
    // Comma mode: dot/space/underscore are thousand separators; the
    // comma marks the decimal boundary. Multiple commas (only the last
    // could be a decimal — the rest would be stray) are rejected so we
    // don't have to disambiguate.
    if ((trimmed.match(/,/g) ?? []).length > 1) {
      return { ok: false, reason: "Nominal hanya angka (contoh: 25000 atau 25,5)." };
    }
    const parts = trimmed.split(",");
    intPart = (parts[0] ?? "").replace(/[\s._]/g, "");
    decPart = parts[1] ?? "";
    if (!/^\d*$/.test(intPart)) {
      return { ok: false, reason: "Nominal hanya angka (contoh: 25000 atau 25,5)." };
    }
    if (decPart !== "" && !/^\d+$/.test(decPart)) {
      return { ok: false, reason: "Nominal hanya angka (contoh: 25000 atau 25,5)." };
    }
    // Cap decimals at 2 digits — anything more is sub-cent.
    if (decPart.length > 2) {
      return {
        ok: false,
        reason:
          "Nominal maksimal 2 angka di belakang koma (sen). Nilai lebih kecil dibulatkan ke 0.",
      };
    }
  } else {
    // No comma: treat dots / spaces / underscores as thousand
    // separators and parse as integer rupiah. Reject decimal dots so
    // ``"0.005"`` (a silent round-up trap that would parse as 5
    // rupiah if we strip the dot) doesn't slip past the integer
    // check. The user must use a comma for decimals.
    if (/\./.test(trimmed)) {
      return {
        ok: false,
        reason: "Pakai koma untuk desimal (contoh: 25,5). Titik diproses sebagai pemisah ribuan.",
      };
    }
    intPart = trimmed.replace(/[\s_]/g, "");
    decPart = "";
    if (!/^\d+$/.test(intPart)) {
      return { ok: false, reason: "Nominal hanya angka (contoh: 25000)." };
    }
  }

  if (intPart === "" && decPart === "") {
    return { ok: false, reason: "Nominal wajib diisi." };
  }

  const normalizedNumber = intPart === "" ? `0.${decPart}` : `${intPart}.${decPart}`;
  const rupiah = Number.parseFloat(normalizedNumber);
  if (!Number.isFinite(rupiah)) {
    return { ok: false, reason: "Nominal tidak valid." };
  }

  // Convert to cents FIRST, then compare against ``> 0``. This is the
  // atomic unit the backend actually validates; checking the rupiah
  // value first lets sub-cent inputs slip through (defect 1).
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
  /**
   * When true the type toggle is rendered in read-only mode and gains
   * a third "Transfer" option. Used by the edit page when the persisted
   * transaction has ``type = "transfer"`` (server-controlled and not
   * editable through PATCH — see regression note from QA). The toggle
   * still surfaces the original type for clarity but no click handler
   * is wired up.
   */
  typeLocked?: boolean;
}

interface TypeOption {
  value: CreatableTransactionType | "transfer";
  label: string;
  description: string;
  accent: "expense" | "income" | "transfer";
}

const TYPE_OPTIONS_DEFAULT: readonly TypeOption[] = [
  {
    value: "expense",
    label: TRANSACTION_TYPE_LABEL.expense,
    description: "Catat uang keluar.",
    accent: "expense",
  },
  {
    value: "income",
    label: TRANSACTION_TYPE_LABEL.income,
    description: "Catat uang masuk.",
    accent: "income",
  },
] as const;

const TYPE_OPTIONS_WITH_TRANSFER: readonly TypeOption[] = [
  {
    value: "expense",
    label: TRANSACTION_TYPE_LABEL.expense,
    description: "Catat uang keluar.",
    accent: "expense",
  },
  {
    value: "income",
    label: TRANSACTION_TYPE_LABEL.income,
    description: "Catat uang masuk.",
    accent: "income",
  },
  {
    value: "transfer",
    label: TRANSACTION_TYPE_LABEL.transfer,
    description: "Dipakai saat edit transaksi pasangan transfer.",
    accent: "transfer",
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
  typeLocked = false,
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

  // When ``typeLocked`` is set the toggle also surfaces "Transfer" as
  // a third option so the user can SEE the original type instead of
  // seeing the form silently coerced to expense (regression: the
  // transfer row used to render as "Pengeluaran" with the income button
  // active — confusing and easy to misread).
  const typeOptions: readonly TypeOption[] = typeLocked
    ? TYPE_OPTIONS_WITH_TRANSFER
    : TYPE_OPTIONS_DEFAULT;
  const typeValue: CreatableTransactionType | "transfer" = typeLocked
    ? "transfer"
    : values.type;

  return (
    <div className="grid gap-5">
      <TypeToggle
        fieldId={fieldId}
        value={typeValue}
        error={typeError}
        disabled={disabled}
        locked={typeLocked}
        options={typeOptions}
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
  value: CreatableTransactionType | "transfer";
  error: string | undefined;
  disabled?: boolean;
  /**
   * When ``true`` every option is rendered disabled and no click handler
   * fires (the segment becomes a read-only display). Used while editing
   * a ``transfer`` row, where ``type`` is server-controlled and PATCH
   * never accepts it (the form layer must not let the user think they
   * changed something the backend will actually save).
   */
  locked?: boolean;
  options: readonly {
    value: CreatableTransactionType | "transfer";
    label: string;
    description: string;
    accent: "expense" | "income" | "transfer";
  }[];
  onChange: (next: CreatableTransactionType) => void;
}

function TypeToggle({
  fieldId,
  value,
  error,
  disabled,
  locked = false,
  options,
  onChange,
}: TypeToggleProps) {
  const isFullyDisabled = disabled || locked;
  return (
    <fieldset>
      <legend className="form-label">Tipe transaksi</legend>
      <div
        role="radiogroup"
        aria-label="Tipe transaksi"
        aria-invalid={error ? "true" : "false"}
        className={
          options.length === 3
            ? "mt-2 grid grid-cols-2 gap-2 sm:flex sm:gap-3"
            : "mt-2 grid grid-cols-2 gap-2 sm:flex sm:gap-3"
        }
      >
        {options.map((option) => {
          const isActive = option.value === value;
          const activeClasses =
            option.accent === "income"
              ? "border-emerald-500 bg-emerald-500 text-white shadow"
              : option.accent === "transfer"
                ? "border-sky-500 bg-sky-500 text-white shadow"
                : "border-rose-500 bg-rose-500 text-white shadow";
          const inactiveClasses =
            "border-slate-200 bg-white text-slate-700 hover:border-slate-300";
          const clickable = !isFullyDisabled && !isActive &&
            option.value !== "transfer";
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={isActive}
              onClick={() => {
                if (!clickable) return;
                if (option.value === "transfer") return;
                onChange(option.value);
              }}
              disabled={isFullyDisabled}
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
          ? "Tipe transaksi ditetapkan oleh alur transfer (sub-0003-03) dan tidak dapat diubah dari form ini."
          : "Transfer antar akun punya alur terpisah (sub-0003-03)."}
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

/**
 * Full submit-time skeleton used by the create + edit pages while
 * ``POST /transactions`` (or ``PATCH /transactions/:id``) is in flight.
 * Satisfies AC (d) — "loading skeleton saat submit" — so the user
 * gets the same visual cue as during the initial prefetch instead of
 * staring at a disabled form (defect 2: previously the disabled form
 * with the button label swap was deemed insufficient by QA).
 */
export function TransactionSubmitSkeleton(): ReactNode {
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
        <span>Menyimpan transaksi...</span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:flex sm:gap-3">
        <div className="h-16 animate-pulse rounded-xl bg-slate-100" />
        <div className="h-16 animate-pulse rounded-xl bg-slate-100" />
      </div>
      <div className="h-14 animate-pulse rounded-md bg-slate-100" />
      <div className="h-14 animate-pulse rounded-md bg-slate-100" />
      <div className="h-14 animate-pulse rounded-md bg-slate-100" />
      <div className="h-14 animate-pulse rounded-md bg-slate-100" />
      <div className="h-24 animate-pulse rounded-md bg-slate-100" />
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <div className="h-10 w-full animate-pulse rounded-md bg-slate-100 sm:w-24" />
        <div className="h-10 w-full animate-pulse rounded-md bg-slate-100 sm:w-32" />
      </div>
      <span className="sr-only">Mengirim transaksi ke server...</span>
    </div>
  );
}