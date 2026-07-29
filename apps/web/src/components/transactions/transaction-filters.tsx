"use client";

import type { ChangeEvent } from "react";

import type { Account } from "@/lib/api/accounts";
import type { Category } from "@/lib/api/categories";
import {
  TRANSACTION_TYPE_LABEL,
  TRANSACTION_TYPE_VALUES,
  type TransactionListFilters,
  type TransactionType,
} from "@/lib/api/transaction-client";

interface TransactionFiltersProps {
  values: TransactionListFilters;
  accounts: Account[];
  categories: Category[];
  onChange: (next: TransactionListFilters) => void;
  onReset: () => void;
}

/**
 * Render a date input as `YYYY-MM-DD` so it round-trips through the
 * backend query param without timezone drift.
 */
function toIsoDateInput(value: string | null): string {
  if (!value) return "";
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return "";
  return `${match[1]}-${match[2]}-${match[3]}`;
}

/**
 * Build a sorted, active-first view of categories. The backend returns a
 * flat list ordered kind → parent → name; we group the leaf entries under
 * their parent so the dropdown reads naturally.
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

/**
 * Filter bar for the transaction list view. Controls date range, account,
 * type, and category. Empty/All values are mapped to `null` filters so the
 * parent page can echo them back to the API.
 */
export function TransactionFilters({
  values,
  accounts,
  categories,
  onChange,
  onReset,
}: TransactionFiltersProps) {
  const handleDateFrom = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value.length > 0 ? event.target.value : null;
    onChange({ ...values, dateFrom: value });
  };

  const handleDateTo = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value.length > 0 ? event.target.value : null;
    onChange({ ...values, dateTo: value });
  };

  const handleAccount = (event: ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value.length > 0 ? event.target.value : null;
    onChange({ ...values, accountId: value });
  };

  const handleType = (event: ChangeEvent<HTMLSelectElement>) => {
    const raw = event.target.value;
    const value = raw.length > 0 ? (raw as TransactionType) : null;
    onChange({ ...values, type: value });
  };

  const handleCategory = (event: ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value.length > 0 ? event.target.value : null;
    onChange({ ...values, categoryId: value });
  };

  const activeCount =
    (values.dateFrom ? 1 : 0) +
    (values.dateTo ? 1 : 0) +
    (values.accountId ? 1 : 0) +
    (values.type ? 1 : 0) +
    (values.categoryId ? 1 : 0);

  const categoryOptions = buildCategoryOptions(categories);

  return (
    <section
      className="card mt-6 space-y-4"
      aria-label="Filter transaksi"
    >
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-900">Filter</h3>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Kombinasikan untuk mempersempit daftar. Filter dikirim sebagai
            query param ke{" "}
            <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">
              GET /transactions
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

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div>
          <label className="form-label" htmlFor="filter-date-from">
            Dari tanggal
          </label>
          <input
            id="filter-date-from"
            type="date"
            className="form-input mt-1"
            value={toIsoDateInput(values.dateFrom)}
            onChange={handleDateFrom}
            aria-label="Filter dari tanggal"
          />
        </div>
        <div>
          <label className="form-label" htmlFor="filter-date-to">
            Sampai tanggal
          </label>
          <input
            id="filter-date-to"
            type="date"
            className="form-input mt-1"
            value={toIsoDateInput(values.dateTo)}
            onChange={handleDateTo}
            aria-label="Filter sampai tanggal"
          />
        </div>
        <div>
          <label className="form-label" htmlFor="filter-account">
            Akun
          </label>
          <select
            id="filter-account"
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
        <div>
          <label className="form-label" htmlFor="filter-type">
            Tipe
          </label>
          <select
            id="filter-type"
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
          <label className="form-label" htmlFor="filter-category">
            Kategori
          </label>
          <select
            id="filter-category"
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
      </div>
    </section>
  );
}
