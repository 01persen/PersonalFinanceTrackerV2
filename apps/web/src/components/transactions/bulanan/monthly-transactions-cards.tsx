"use client";

import {
  amountMeta,
  badgeStyle,
  formatDateLongId,
  formatIdrFromCents,
  type MonthlyTransactionGroup,
} from "@/components/transactions/bulanan/monthly-grouping";

interface MonthlyTransactionsCardsProps {
  groups: MonthlyTransactionGroup[];
}

/**
 * Card fallback for the monthly view at viewport widths below the `md`
 * breakpoint. Each date group is rendered as a stacked card container,
 * and each transaction is a compact card with tipe, nominal, kategori,
 * and catatan. The layout is full-width, touch-friendly, and reads
 * naturally on a phone screen.
 */
export function MonthlyTransactionsCards({ groups }: MonthlyTransactionsCardsProps) {
  if (groups.length === 0) return null;

  return (
    <section
      className="space-y-4 md:hidden"
      aria-label="Daftar transaksi bulanan"
    >
      {groups.map((group) => (
        <article
          key={group.date}
          className="card p-0"
          aria-labelledby={`group-${group.date}`}
        >
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
            <h3
              id={`group-${group.date}`}
              className="text-sm font-semibold text-slate-900"
            >
              {formatDateLongId(group.date)}
            </h3>
            <p className="text-xs text-slate-500">
              {group.rows.length} transaksi
            </p>
          </header>
          <ul className="divide-y divide-slate-100" role="list">
            {group.rows.map(({ row, accountName, categoryName }) => {
              const badge = badgeStyle(row.type);
              const meta = amountMeta(row.type);
              return (
                <li key={row.id} className="flex flex-col gap-2 px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
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
                    <p
                      className={`shrink-0 text-sm font-semibold tabular-nums ${meta.color}`}
                      aria-label={`Nominal ${row.type} ${formatIdrFromCents(row.amountCents)}`}
                    >
                      {meta.prefix} {formatIdrFromCents(row.amountCents)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        </article>
      ))}
    </section>
  );
}
