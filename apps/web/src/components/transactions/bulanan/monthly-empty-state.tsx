"use client";

import Link from "next/link";

import { NavigationIcon } from "@/components/shell/icons";

interface MonthlyEmptyStateProps {
  year: number;
  month: number;
}

const MONTH_LABELS_ID = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
];

function formatMonthLabel(year: number, month: number): string {
  if (month < 1 || month > 12) return `${year}`;
  return `${MONTH_LABELS_ID[month - 1]} ${year}`;
}

export function MonthlyEmptyState({ year, month }: MonthlyEmptyStateProps) {
  return (
    <section
      className="card flex flex-col items-center gap-4 py-10 text-center"
      aria-labelledby="monthly-empty-heading"
    >
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-50 text-brand-700">
        <NavigationIcon name="reports" className="h-7 w-7" />
      </div>
      <div className="max-w-md">
        <h3
          id="monthly-empty-heading"
          className="text-base font-semibold text-slate-900 sm:text-lg"
        >
          Belum ada transaksi di {formatMonthLabel(year, month)}.
        </h3>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Catat pemasukan, pengeluaran, atau transfer pertama di bulan ini
          untuk mulai melihat ringkasan dan detail harian di sini.
        </p>
      </div>
      <Link
        href="/transactions/new"
        className="btn-primary !w-auto px-5"
        aria-label="Tambah transaksi pertama"
      >
        Tambah transaksi pertama
      </Link>
    </section>
  );
}
