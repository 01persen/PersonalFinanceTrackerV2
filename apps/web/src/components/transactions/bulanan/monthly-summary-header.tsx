"use client";

import type { TransactionSummary } from "@/lib/api/transaction-summary-client";

interface MonthlySummaryHeaderProps {
  summary: TransactionSummary;
  year: number;
  month: number;
}

const IDR_FORMATTER = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

function formatIdrFromCents(cents: number): string {
  return IDR_FORMATTER.format(Math.round(cents / 100));
}

interface TileStyle {
  container: string;
  label: string;
  amount: string;
  badge: string;
}

function incomeTile(): TileStyle {
  return {
    container: "border-emerald-200 bg-emerald-50",
    label: "Total Pemasukan",
    amount: "text-emerald-800",
    badge: "bg-emerald-100 text-emerald-700",
  };
}

function expenseTile(): TileStyle {
  return {
    container: "border-rose-200 bg-rose-50",
    label: "Total Pengeluaran",
    amount: "text-rose-800",
    badge: "bg-rose-100 text-rose-700",
  };
}

function netTile(netCents: number): TileStyle {
  if (netCents >= 0) {
    return {
      container: "border-brand-200 bg-brand-50",
      label: "Selisih (Net)",
      amount: "text-brand-900",
      badge: "bg-brand-100 text-brand-700",
    };
  }
  return {
    container: "border-amber-200 bg-amber-50",
    label: "Selisih (Defisit)",
    amount: "text-amber-900",
    badge: "bg-amber-100 text-amber-700",
  };
}

function SummaryTile({
  label,
  cents,
  style,
  hint,
}: {
  label: string;
  cents: number;
  style: TileStyle;
  hint: string;
}) {
  const sign = cents > 0 ? "+" : cents < 0 ? "−" : "";
  const display = cents === 0 ? formatIdrFromCents(0) : `${sign} ${formatIdrFromCents(Math.abs(cents))}`;
  return (
    <div className={`rounded-2xl border p-5 shadow-sm ${style.container}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-700">
          {label}
        </p>
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[0.625rem] font-semibold ${style.badge}`}>
          {hint}
        </span>
      </div>
      <p
        className={`mt-3 text-2xl font-bold tabular-nums sm:text-3xl ${style.amount}`}
        aria-label={`${label} ${display}`}
      >
        {display}
      </p>
    </div>
  );
}

/**
 * Header strip showing the monthly summary tiles (total income, total
 * expense, net). Renders three tiles laid out as a grid that collapses
 * to a single column on mobile. Tiles are sourced from the
 * `GET /transactions/summary` response so the totals stay consistent
 * with the backend's soft-delete-aware aggregation.
 */
export function MonthlySummaryHeader({
  summary,
  year,
  month,
}: MonthlySummaryHeaderProps) {
  const income = incomeTile();
  const expense = expenseTile();
  const net = netTile(summary.netCents);

  return (
    <section
      className="space-y-3"
      aria-labelledby="monthly-summary-heading"
    >
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2
            id="monthly-summary-heading"
            className="text-base font-semibold text-slate-900"
          >
            Ringkasan bulan {month}/{year}
          </h2>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            Total dihitung dari transaksi aktif (income + expense). Transfer
            internal tidak ikut memengaruhi selisih.
          </p>
        </div>
        <p className="text-xs text-slate-500">
          {summary.transactionCount} transaksi aktif
        </p>
      </header>
      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryTile
          label={income.label}
          cents={summary.totalIncomeCents}
          style={income}
          hint="Pemasukan"
        />
        <SummaryTile
          label={expense.label}
          cents={summary.totalExpenseCents}
          style={expense}
          hint="Pengeluaran"
        />
        <SummaryTile
          label={net.label}
          cents={summary.netCents}
          style={net}
          hint={summary.netCents >= 0 ? "Surplus" : "Defisit"}
        />
      </div>
    </section>
  );
}
