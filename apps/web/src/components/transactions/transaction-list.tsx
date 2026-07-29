"use client";

import { useEffect, useMemo, useRef } from "react";

import type { Account } from "@/lib/api/accounts";
import type { Category } from "@/lib/api/categories";
import { TRANSACTION_TYPE_LABEL, type TransactionType } from "@/lib/api/transaction-client";
import type { Transaction } from "@/lib/api/transactions";

interface TransactionListProps {
  rows: Transaction[];
  accounts: Account[];
  categories: Category[];
  total: number;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
}

interface ResolvedRow {
  row: Transaction;
  accountName: string;
  categoryName: string;
}

/**
 * Resolve a transaction's `accountId` and `categoryId` to display labels.
 * `null` IDs fall back to neutral Indonesian labels so the row is still
 * readable when the lookup map is stale (e.g. an account was archived or
 * the categories request failed).
 */
function resolveRows(
  rows: Transaction[],
  accounts: Account[],
  categories: Category[],
): ResolvedRow[] {
  const accountNameById = new Map<string, string>();
  for (const account of accounts) {
    accountNameById.set(account.id, account.name);
  }
  const categoryNameById = new Map<string, string>();
  for (const category of categories) {
    categoryNameById.set(category.id, category.name);
  }

  return rows.map((row) => ({
    row,
    accountName: accountNameById.get(row.accountId) ?? "Akun tidak diketahui",
    categoryName: row.categoryId
      ? categoryNameById.get(row.categoryId) ?? "Kategori tidak diketahui"
      : "Tanpa kategori",
  }));
}

/**
 * Format `YYYY-MM-DD` as a localised Indonesian short date. We keep the
 * string parser on the ISO format so timezone drift doesn't push the row
 * to the previous/next day (the backend stores the calendar date).
 */
function formatDate(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return value;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

const IDR_FORMATTER = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

function formatIdrFromCents(cents: number): string {
  return IDR_FORMATTER.format(Math.round(cents / 100));
}

interface BadgeStyle {
  container: string;
  label: string;
}

function badgeStyle(type: TransactionType): BadgeStyle {
  if (type === "income") {
    return {
      container: "bg-emerald-100 text-emerald-800",
      label: TRANSACTION_TYPE_LABEL.income,
    };
  }
  if (type === "expense") {
    return {
      container: "bg-rose-100 text-rose-800",
      label: TRANSACTION_TYPE_LABEL.expense,
    };
  }
  return {
    container: "bg-sky-100 text-sky-800",
    label: TRANSACTION_TYPE_LABEL.transfer,
  };
}

/**
 * Render the current page of transactions. Empty rows fall through to the
 * parent's empty state; this component is only mounted when at least one
 * row exists. `onLoadMore` fires when the user scrolls to the bottom of
 * the rendered list (IntersectionObserver).
 */
export function TransactionList({
  rows,
  accounts,
  categories,
  total,
  hasMore,
  isLoadingMore,
  onLoadMore,
}: TransactionListProps) {
  const resolved = useMemo(
    () => resolveRows(rows, accounts, categories),
    [rows, accounts, categories],
  );
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!hasMore || isLoadingMore) return;
    const node = sentinelRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting) {
          onLoadMore();
        }
      },
      { rootMargin: "200px 0px" },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [hasMore, isLoadingMore, onLoadMore]);

  return (
    <section
      className="card mt-6 overflow-hidden p-0"
      aria-label="Daftar transaksi"
    >
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-200 px-5 py-4">
        <div>
          <h3 className="text-base font-semibold text-slate-900">
            Daftar transaksi
          </h3>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            Menampilkan {rows.length} dari {total} transaksi · diurutkan
            tanggal terbaru dulu.
          </p>
        </div>
      </header>

      <ul className="divide-y divide-slate-100" role="list">
        {resolved.map(({ row, accountName, categoryName }) => {
          const badge = badgeStyle(row.type);
          const isExpense = row.type === "expense";
          const isIncome = row.type === "income";
          const amountColor = isExpense
            ? "text-rose-700"
            : isIncome
              ? "text-emerald-700"
              : "text-sky-700";
          const amountPrefix = isExpense ? "−" : isIncome ? "+" : "↔";
          return (
            <li
              key={row.id}
              className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:gap-4"
            >
              <div className="flex shrink-0 items-center sm:w-28">
                <span className="text-sm font-semibold text-slate-700 tabular-nums">
                  {formatDate(row.occurredOn)}
                </span>
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${badge.container}`}
                  >
                    {badge.label}
                  </span>
                  <span className="text-sm font-semibold text-slate-900">
                    {categoryName}
                  </span>
                </div>
                <p className="mt-1 truncate text-xs text-slate-500">
                  {accountName}
                  {row.note ? ` · ${row.note}` : ""}
                </p>
              </div>
              <div className="sm:text-right">
                <p
                  className={`text-sm font-semibold tabular-nums ${amountColor}`}
                  aria-label={`Nominal ${row.type} ${formatIdrFromCents(row.amountCents)}`}
                >
                  {amountPrefix} {formatIdrFromCents(row.amountCents)}
                </p>
                <p className="text-xs text-slate-500">{row.currency || "IDR"}</p>
              </div>
            </li>
          );
        })}
      </ul>

      {hasMore ? (
        <div
          ref={sentinelRef}
          className="border-t border-slate-100 px-5 py-4 text-center text-xs text-slate-500"
          aria-live="polite"
        >
          {isLoadingMore ? (
            <span className="inline-flex items-center gap-2">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-brand-100 border-t-brand-600" />
              Memuat transaksi berikutnya...
            </span>
          ) : (
            <button
              type="button"
              className="text-xs font-semibold text-brand-700 hover:text-brand-900 hover:underline focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2"
              onClick={onLoadMore}
            >
              Muat 50 transaksi berikutnya
            </button>
          )}
        </div>
      ) : rows.length > 0 ? (
        <div className="border-t border-slate-100 px-5 py-4 text-center text-xs text-slate-500">
          Sudah sampai akhir daftar.
        </div>
      ) : null}
    </section>
  );
}
