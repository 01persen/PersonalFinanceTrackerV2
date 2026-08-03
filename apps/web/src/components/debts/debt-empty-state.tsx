"use client";

import Link from "next/link";

import { NavigationIcon } from "@/components/shell/icons";

/**
 * Empty state for `/debts` (sub-0006-04). Mirrors the goals empty
 * state (`GoalsEmptyState` in sub-0005-03) so the user sees the
 * same component family across dashboard lists.
 *
 * The CTA links to `/debts/new` which is **not yet wired** — the
 * create/edit form lands in sub-0006-05 (Stage 4). Until then the
 * link is rendered as a "soon" hint so the user understands the
 * feature is on the way instead of bouncing on a 404.
 */
export function DebtEmptyState() {
  return (
    <section
      className="card mt-6 flex flex-col items-center gap-4 py-10 text-center"
      aria-labelledby="debts-empty-heading"
      data-testid="debts-empty-state"
    >
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-50 text-brand-700">
        <NavigationIcon name="debts" className="h-7 w-7" />
      </div>
      <div className="max-w-md">
        <h3
          id="debts-empty-heading"
          className="text-base font-semibold text-slate-900 sm:text-lg"
        >
          Belum ada utang yang tercatat.
        </h3>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Catat pinjaman, kartu kredit, atau paylater pertamamu agar
          sisa saldo dan cicilan per bulan bisa dipantau dari dasbor.
        </p>
      </div>
      <Link
        href="/debts/new"
        className="btn-primary !w-auto px-5"
        aria-label="Catat utang pertama"
      >
        Catat utang pertama
      </Link>
      <p className="text-xs text-slate-500">
        Form tambah utang akan tersedia pada sub-0006-05 (Stage 4).
      </p>
    </section>
  );
}