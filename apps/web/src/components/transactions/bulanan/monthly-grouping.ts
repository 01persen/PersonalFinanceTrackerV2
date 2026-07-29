"use client";

import type { Account } from "@/lib/api/accounts";
import type { Category } from "@/lib/api/categories";
import { TRANSACTION_TYPE_LABEL, type TransactionType } from "@/lib/api/transaction-client";
import type { Transaction } from "@/lib/api/transactions";

interface GroupRow {
  row: Transaction;
  accountName: string;
  categoryName: string;
}

export interface MonthlyTransactionGroup {
  /** ISO `YYYY-MM-DD` — the calendar date the rows belong to. */
  date: string;
  rows: GroupRow[];
  /** Sum of income cents for this date (positive only). */
  incomeCents: number;
  /** Sum of expense cents for this date (positive only). */
  expenseCents: number;
}

interface ResolvedRow {
  row: Transaction;
  accountName: string;
  categoryName: string;
}

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
 * Format `YYYY-MM-DD` as a localised Indonesian long date for the group
 * header. We resolve the date through UTC so the displayed weekday/day
 * never drifts to the previous/next day due to the runtime timezone.
 */
export function formatDateLongId(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return value;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("id-ID", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export const IDR_FORMATTER = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

export function formatIdrFromCents(cents: number): string {
  return IDR_FORMATTER.format(Math.round(cents / 100));
}

interface BadgeStyle {
  container: string;
  label: string;
}

export function badgeStyle(type: TransactionType): BadgeStyle {
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

function amountMeta(type: TransactionType): {
  color: string;
  prefix: string;
} {
  if (type === "expense") return { color: "text-rose-700", prefix: "−" };
  if (type === "income") return { color: "text-emerald-700", prefix: "+" };
  return { color: "text-sky-700", prefix: "↔" };
}

/**
 * Group the month's transactions by `occurredOn` and return the groups
 * in descending date order (newest first). The backend already orders
 * the list by `occurred_on DESC` so this is a single pass; the explicit
 * sort keeps the grouping stable even if the API order changes.
 */
export function groupTransactionsByDate(
  rows: Transaction[],
  accounts: Account[],
  categories: Category[],
): MonthlyTransactionGroup[] {
  const resolved = resolveRows(rows, accounts, categories);

  const groupsByDate = new Map<string, GroupRow[]>();
  for (const entry of resolved) {
    const existing = groupsByDate.get(entry.row.occurredOn) ?? [];
    existing.push(entry);
    groupsByDate.set(entry.row.occurredOn, existing);
  }

  const sortedDates = Array.from(groupsByDate.keys()).sort((a, b) =>
    a < b ? 1 : a > b ? -1 : 0,
  );

  return sortedDates.map((date) => {
    const rowsForDate = groupsByDate.get(date) ?? [];
    let incomeCents = 0;
    let expenseCents = 0;
    for (const { row } of rowsForDate) {
      if (row.type === "income") incomeCents += row.amountCents;
      else if (row.type === "expense") expenseCents += row.amountCents;
    }
    return {
      date,
      rows: rowsForDate,
      incomeCents,
      expenseCents,
    };
  });
}

export { amountMeta };
