"use client";

import { useMemo, type ChangeEvent, type ReactNode } from "react";

import type { Account } from "@/lib/api/accounts";
import type { Category } from "@/lib/api/categories";
import {
  TRANSACTION_TYPE_LABEL,
  TRANSACTION_TYPE_VALUES,
  type TransactionSearchFilters,
  type TransactionType,
} from "@/lib/api/transaction-client";

/**
 * Filter panel for the global search bar (sub-0004-05 AC (2)).
 *
 * Layout intent:
 *
 *   - **Desktop (≥ lg).** Renders inline as a side panel / card — same
 *     "card" shape as the existing transaction filter (sub-0003-06)
 *     so the page composition is uniform across the two filters.
 *   - **Mobile (< lg).** Mounted inside a bottom-sheet drawer controlled
 *     by the parent. The body is scrollable, the header + footer stay
 *     pinned so the "Terapkan" / "Reset" buttons are always reachable
 *     on a 390×844 viewport (AC (5)).
 *
 * The panel is fully controlled: the parent owns the filter state via
 * ``TransactionSearchFilters`` and ``onChange``. Empty / "All" values
 * are mapped back to ``null`` (or ``""`` for ``q``) so the URL query
 * never carries empty-string noise.
 */

interface TransactionSearchFiltersPanelProps {
  values: TransactionSearchFilters;
  accounts: Account[];
  categories: Category[];
  onChange: (next: TransactionSearchFilters) => void;
  onReset: () => void;
  /** Optional section title override (default: "Filter pencarian"). */
  title?: string;
  /** Layout mode. ``"panel"`` (desktop side panel) or ``"sheet"`` (mobile). */
  variant?: "panel" | "sheet";
  /** When ``variant === "sheet"``, hide the "Reset" button in the header. */
  hideHeaderReset?: boolean;
  /** Footer slot for the mobile sheet ("Terapkan" / "Reset semua"). */
  footer?: ReactNode;
}

const IDR_NUMBER_FORMATTER = new Intl.NumberFormat("id-ID", {
  maximumFractionDigits: 0,
});

function toIsoDateInput(value: string | null): string {
  if (!value) return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return "";
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function toDateValue(event: ChangeEvent<HTMLInputElement>): string | null {
  const value = event.target.value;
  return value.length > 0 ? value : null;
}

/** Convert a cents string from the wire to an IDR string for the input. */
function centsToIdrInput(cents: number | null): string {
  if (cents === null || cents < 0) return "";
  return IDR_NUMBER_FORMATTER.format(Math.trunc(cents / 100));
}

/** Convert an IDR-formatted string from the input back to cents for the wire. */
function idrInputToCents(raw: string): number | null {
  const stripped = raw.replace(/[^0-9]/g, "");
  if (stripped.length === 0) return null;
  const whole = Number.parseInt(stripped, 10);
  if (!Number.isFinite(whole) || whole < 0) return null;
  return whole * 100;
}

/**
 * Build a sorted, indented category option list. Mirrors the structure
 * used in sub-0003-06 / sub-0004-04 — roots first, children indented
 * with an em-dash prefix so the dropdown reads naturally without
 * pulling in a tree picker.
 */
function buildCategoryOptions(categories: Category[]): CategoryOption[] {
  const byId = new Map<string, Category>();
  for (const category of categories) {
    if (!category.archived) byId.set(category.id, category);
  }

  const childrenByParent = new Map<string, Category[]>();
  for (const category of byId.values()) {
    if (!category.parentId) continue;
    const siblings = childrenByParent.get(category.parentId) ?? [];
    siblings.push(category);
    childrenByParent.set(category.parentId, siblings);
  }

  const options: CategoryOption[] = [];
  for (const category of byId.values()) {
    if (category.parentId) continue;
    options.push({ id: category.id, label: category.name });
    const children = (childrenByParent.get(category.id) ?? []).slice().sort((a, b) =>
      a.name.localeCompare(b.name, "id-ID"),
    );
    for (const child of children) {
      options.push({ id: child.id, label: `— ${child.name}` });
    }
  }
  return options;
}

interface CategoryOption {
  id: string;
  label: string;
}

export function TransactionSearchFiltersPanel({
  values,
  accounts,
  categories,
  onChange,
  onReset,
  title = "Filter pencarian",
  variant = "panel",
  hideHeaderReset = false,
  footer,
}: TransactionSearchFiltersPanelProps) {
  const categoryOptions = useMemo(
    () => buildCategoryOptions(categories),
    [categories],
  );

  const activeCount =
    (values.q.trim().length > 0 ? 1 : 0) +
    (values.dateFrom ? 1 : 0) +
    (values.dateTo ? 1 : 0) +
    (values.accountId ? 1 : 0) +
    (values.type ? 1 : 0) +
    (values.categoryId ? 1 : 0) +
    (values.amountMinCents !== null ? 1 : 0) +
    (values.amountMaxCents !== null ? 1 : 0);

  const handleDateFrom = (event: ChangeEvent<HTMLInputElement>): void => {
    onChange({ ...values, dateFrom: toDateValue(event) });
  };
  const handleDateTo = (event: ChangeEvent<HTMLInputElement>): void => {
    onChange({ ...values, dateTo: toDateValue(event) });
  };
  const handleAccount = (event: ChangeEvent<HTMLSelectElement>): void => {
    const raw = event.target.value;
    onChange({ ...values, accountId: raw.length > 0 ? raw : null });
  };
  const handleType = (event: ChangeEvent<HTMLSelectElement>): void => {
    const raw = event.target.value;
    onChange({ ...values, type: raw.length > 0 ? (raw as TransactionType) : null });
  };
  const handleCategory = (event: ChangeEvent<HTMLSelectElement>): void => {
    const raw = event.target.value;
    onChange({ ...values, categoryId: raw.length > 0 ? raw : null });
  };
  const handleAmountMin = (event: ChangeEvent<HTMLInputElement>): void => {
    onChange({ ...values, amountMinCents: idrInputToCents(event.target.value) });
  };
  const handleAmountMax = (event: ChangeEvent<HTMLInputElement>): void => {
    onChange({ ...values, amountMaxCents: idrInputToCents(event.target.value) });
  };

  const isSheet = variant === "sheet";

  return (
    <section
      className={
        isSheet
          ? "flex min-h-0 flex-1 flex-col"
          : "card mt-6 space-y-4"
      }
      aria-label="Filter pencarian transaksi"
    >
      {!hideHeaderReset ? (
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-slate-900">{title}</h3>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              Kombinasikan untuk mempersempit hasil. Query dikirim ke{" "}
              <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">
                GET /transactions/search
              </code>
              .
            </p>
          </div>
          <button
            type="button"
            className="text-xs font-semibold text-brand-700 hover:text-brand-900 hover:underline focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
            onClick={onReset}
            disabled={activeCount === 0}
          >
            Reset semua filter
          </button>
        </header>
      ) : (
        <header>
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          <p className="mt-1 text-xs text-slate-500">
            {activeCount} filter aktif.
          </p>
        </header>
      )}

      <div className={isSheet ? "min-h-0 flex-1 overflow-y-auto" : ""}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="form-label" htmlFor="search-filter-date-from">
              Dari tanggal
            </label>
            <input
              id="search-filter-date-from"
              type="date"
              className="form-input mt-1"
              value={toIsoDateInput(values.dateFrom)}
              onChange={handleDateFrom}
              aria-label="Filter dari tanggal"
            />
          </div>
          <div>
            <label className="form-label" htmlFor="search-filter-date-to">
              Sampai tanggal
            </label>
            <input
              id="search-filter-date-to"
              type="date"
              className="form-input mt-1"
              value={toIsoDateInput(values.dateTo)}
              onChange={handleDateTo}
              aria-label="Filter sampai tanggal"
            />
          </div>

          <div>
            <label className="form-label" htmlFor="search-filter-type">
              Tipe
            </label>
            <select
              id="search-filter-type"
              className="form-input mt-1"
              value={values.type ?? ""}
              onChange={handleType}
              aria-label="Filter tipe transaksi"
            >
              <option value="">Semua tipe</option>
              {TRANSACTION_TYPE_VALUES.map((type) => (
                <option key={type} value={type}>
                  {TRANSACTION_TYPE_LABEL[type]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="form-label" htmlFor="search-filter-account">
              Akun
            </label>
            <select
              id="search-filter-account"
              className="form-input mt-1"
              value={values.accountId ?? ""}
              onChange={handleAccount}
              aria-label="Filter akun"
            >
              <option value="">Semua akun</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          </div>

          <div className="sm:col-span-2">
            <label className="form-label" htmlFor="search-filter-category">
              Kategori
            </label>
            <select
              id="search-filter-category"
              className="form-input mt-1"
              value={values.categoryId ?? ""}
              onChange={handleCategory}
              aria-label="Filter kategori"
            >
              <option value="">Semua kategori</option>
              {categoryOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="form-label" htmlFor="search-filter-amount-min">
              Nominal minimal (IDR)
            </label>
            <input
              id="search-filter-amount-min"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              className="form-input mt-1"
              placeholder="0"
              value={centsToIdrInput(values.amountMinCents)}
              onChange={handleAmountMin}
              aria-label="Nominal minimal dalam rupiah"
            />
          </div>
          <div>
            <label className="form-label" htmlFor="search-filter-amount-max">
              Nominal maksimal (IDR)
            </label>
            <input
              id="search-filter-amount-max"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              className="form-input mt-1"
              placeholder="0"
              value={centsToIdrInput(values.amountMaxCents)}
              onChange={handleAmountMax}
              aria-label="Nominal maksimal dalam rupiah"
            />
          </div>
        </div>

        {values.amountMinCents !== null &&
        values.amountMaxCents !== null &&
        values.amountMinCents > values.amountMaxCents ? (
          <p
            className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900"
            role="alert"
          >
            Nominal minimal lebih besar dari maksimal — backend akan
            mengembalikan 0 hasil sampai kamu menyesuaikan salah satu.
          </p>
        ) : null}
      </div>

      {footer ? <div className={isSheet ? "shrink-0 border-t border-slate-200 pt-3" : ""}>{footer}</div> : null}
    </section>
  );
}