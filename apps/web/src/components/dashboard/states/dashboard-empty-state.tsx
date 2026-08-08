"use client";

import Link from "next/link";

import { NavigationIcon } from "@/components/shell/icons";

/**
 * Empty state for the dashboard page (sub-0007-08).
 *
 * Shown when a brand-new user has no accounts yet — invites them to
 * add their first account so the dashboard has data to aggregate.
 * Mirrors the centered-card + supporting-copy + primary CTA layout
 * from `<MonthlyEmptyState>` (sub-0003-07) and `<DebtEmptyState>`
 * (sub-0006-04) so the user sees the same family of empty-state
 * shapes across the app.
 *
 * The CTA links to `/accounts/new`. The illustration is a hand-drawn
 * inline SVG (no external dep) — pointing toward where the action
 * button sits — so the screen reader reads "Dashboard kamu masih
 * kosong" first, with the SVG marked `aria-hidden`.
 */
export function DashboardEmptyState() {
  return (
    <section
      className="card flex flex-col items-center gap-5 py-12 text-center"
      role="status"
      aria-live="polite"
      aria-labelledby="dashboard-empty-heading"
      data-testid="dashboard-empty-state"
    >
      <svg
        viewBox="0 0 200 140"
        className="h-28 w-40"
        aria-hidden="true"
        focusable="false"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <g className="text-slate-200">
          <rect x="30" y="28" width="90" height="80" rx="8" />
          <line x1="48" y1="48" x2="102" y2="48" />
          <line x1="48" y1="64" x2="102" y2="64" />
          <line x1="48" y1="80" x2="86" y2="80" />
        </g>
        <g className="text-brand-600">
          <path d="M122 96 q22 -10 40 -4 q14 4 12 18 q-2 12 -16 16 q-18 6 -36 2" />
          <path d="M148 110 l-6 -12 m-2 12 l-2 -16" />
        </g>
      </svg>

      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-50 text-brand-700">
        <NavigationIcon name="accounts" className="h-7 w-7" />
      </div>

      <div className="max-w-md">
        <h3
          id="dashboard-empty-heading"
          className="text-base font-semibold text-slate-900 sm:text-lg"
        >
          Dashboard kamu masih kosong.
        </h3>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Tambahkan akun pertama kamu — rekening bank, dompet digital,
          atau catatan tunai — supaya ringkasan networth, grafik, dan
          target bisa mulai terisi otomatis.
        </p>
      </div>

      <Link
        href="/accounts/new"
        className="btn-primary !w-auto px-5"
        aria-label="Tambah akun pertama"
      >
        Tambah akun pertama
      </Link>
    </section>
  );
}