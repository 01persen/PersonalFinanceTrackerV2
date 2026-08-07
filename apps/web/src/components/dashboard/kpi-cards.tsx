"use client";

import type { ReactNode } from "react";

import { formatIdrFromCents } from "@/lib/dashboard/idr";

/**
 * Visual tone of a single KPI card. Drives the leading icon's color
 * pair (`bg-*` + `text-*`) — the FE never collapses tone into a single
 * neutral grey because the four KPIs cover different emotional signals
 * (positive cashflow vs neutral outflow vs safety buffer vs overall
 * networth sign). Keep this enum small: every new tone adds another
 * Tailwind pair to the safelist.
 */
export type KpiTone = "positive" | "negative" | "neutral" | "info";

interface KpiCardProps {
  /** Top-line label, e.g. "Networth". */
  label: string;
  /**
   * Formatted display string. Pass the already-formatted IDR string
   * (`formatIdrFromCents(cents)`) so the card stays pure and easy to
   * test — the page owns the formatter + cents-to-rupiah conversion.
   */
  value: string;
  /** Optional helper text below the value (e.g. "Bulan ini"). */
  hint?: string;
  /** Visual tone — defaults to `neutral`. */
  tone?: KpiTone;
  /**
   * Optional inline SVG icon path (24x24 viewBox, stroke="currentColor").
   * When provided the card renders the icon inside the leading badge
   * so each card stays scannable without reaching for an icon library.
   */
  icon?: ReactNode;
  /**
   * Optional ARIA label override. When omitted the label is used
   * verbatim. Useful for screen-reader-only clarifications like the
   * EF empty state.
   */
  ariaLabel?: string;
  /**
   * When true the card renders in a disabled / muted state — used by
   * the EF empty state ("Belum ada dana darurat") to surface a
   * first-time-user hint without making the card visually noisy.
   */
  disabled?: boolean;
}

const TONE_STYLES: Record<KpiTone, { badge: string; value: string }> = {
  positive: { badge: "bg-emerald-100 text-emerald-700", value: "text-emerald-700" },
  negative: { badge: "bg-rose-100 text-rose-700", value: "text-rose-700" },
  neutral: { badge: "bg-slate-100 text-slate-700", value: "text-slate-900" },
  info: { badge: "bg-sky-100 text-sky-700", value: "text-sky-800" },
};

/**
 * Single KPI card slot for the dashboard summary row. Pure presentation
 * component — does no fetching, no formatting, no client-side state.
 * Compose four of these inside `<KpiCards>` to build the summary row.
 *
 * Mobile responsive: collapses to a 1-up stack under the `sm`
 * breakpoint and a 2-up grid at `sm` → `lg`. The dashboard grid
 * container handles the desktop 4-up layout (see `dashboard-grid.tsx`).
 */
export function KpiCard({
  label,
  value,
  hint,
  tone = "neutral",
  icon,
  ariaLabel,
  disabled = false,
}: KpiCardProps) {
  const styles = TONE_STYLES[tone];

  return (
    <article
      className={`card flex h-full flex-col gap-3 ${
        disabled ? "bg-slate-50/70 opacity-90" : ""
      }`}
      aria-label={ariaLabel ?? label}
      data-tone={tone}
      data-disabled={disabled ? "true" : "false"}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
            {label}
          </p>
          {hint ? (
            <p className="mt-1 text-[0.7rem] font-medium text-slate-400">
              {hint}
            </p>
          ) : null}
        </div>
        {icon ? (
          <span
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${styles.badge}`}
            aria-hidden="true"
          >
            {icon}
          </span>
        ) : null}
      </header>
      <p
        className={`tabular-nums text-2xl font-bold leading-tight sm:text-3xl ${styles.value} ${
          disabled ? "text-slate-500" : ""
        }`}
      >
        {value}
      </p>
    </article>
  );
}

// --- card row -------------------------------------------------------------

interface KpiCardsProps {
  /** Backend-derived networth in cents (signed). */
  networthCents: number;
  /** Income for the current calendar month in cents (>= 0). */
  incomeThisMonthCents: number;
  /** Expense for the current calendar month in cents (>= 0). */
  expenseThisMonthCents: number;
  /**
   * Average EF goal percentage (0..100). `null` when the user has no
   * active EF goal — the EF card flips to the disabled empty state
   * "Belum ada dana darurat" in that case.
   */
  emergencyFundAvgPct: number | null;
}

const NetworthIcon = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-5 w-5"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M3 17l5-5 4 4 8-8" />
    <path d="M14 8h6v6" />
  </svg>
);

const IncomeIcon = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-5 w-5"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M12 19V5" />
    <path d="m6 11 6-6 6 6" />
  </svg>
);

const ExpenseIcon = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-5 w-5"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M12 5v14" />
    <path d="m6 13 6 6 6-6" />
  </svg>
);

const EmergencyFundIcon = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-5 w-5"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M12 3 4 6v6c0 5 3.5 8.5 8 9 4.5-.5 8-4 8-9V6l-8-3Z" />
    <path d="M9.5 12.5 11 14l3.5-3.5" />
  </svg>
);

/**
 * Format a clamped percentage (0..100) as a whole-number string with
 * the `%` suffix. The BE returns `0..100` (already clamped); the FE
 * only normalizes here for the edge case where a backend drift returns
 * 100.49 or -0.1.
 */
function formatPercent(value: number): string {
  const clamped = Math.max(0, Math.min(100, value));
  return `${Math.round(clamped)}%`;
}

/**
 * Top-row KPI cards for the dashboard (sub-0007-02). Renders the four
 * summary slots — Networth, Income bulan ini, Expense bulan ini,
 * Emergency Fund progress — inside a responsive 1/2/4 column grid.
 *
 * Pure presentation: every value is pre-formatted via the dashboard
 * IDR formatter (`formatIdrFromCents`) so the component stays easy to
 * test. Tones mirror the value's emotional sign (positive networth →
 * green, negative → rose) so the summary row reads at a glance.
 *
 * Empty state for the EF card: when `emergencyFundAvgPct` is `null`
 * the card flips to the disabled style + "Belum ada dana darurat"
 * label so a brand-new user (no EF goal yet) sees a guided next step
 * instead of a misleading 0%.
 */
export function KpiCards({
  networthCents,
  incomeThisMonthCents,
  expenseThisMonthCents,
  emergencyFundAvgPct,
}: KpiCardsProps) {
  const hasEmergencyFund = emergencyFundAvgPct !== null;
  const networthTone: KpiTone = networthCents >= 0 ? "positive" : "negative";

  return (
    <section
      aria-labelledby="dashboard-kpi-heading"
      className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
    >
      <h2 id="dashboard-kpi-heading" className="sr-only">
        Ringkasan utama
      </h2>

      <KpiCard
        label="Networth"
        value={formatIdrFromCents(networthCents)}
        hint="Aset − Kewajiban"
        tone={networthTone}
        icon={NetworthIcon}
      />

      <KpiCard
        label="Pemasukan bulan ini"
        value={formatIdrFromCents(incomeThisMonthCents)}
        tone="positive"
        icon={IncomeIcon}
      />

      <KpiCard
        label="Pengeluaran bulan ini"
        value={formatIdrFromCents(expenseThisMonthCents)}
        tone="neutral"
        icon={ExpenseIcon}
      />

      <KpiCard
        label="Dana darurat"
        value={
          hasEmergencyFund && emergencyFundAvgPct !== null
            ? formatPercent(emergencyFundAvgPct)
            : "Belum ada dana darurat"
        }
        hint={
          hasEmergencyFund
            ? "Rata-rata progress target darurat"
            : "Tambahkan target dana darurat untuk mulai memantau"
        }
        tone="info"
        icon={EmergencyFundIcon}
        disabled={!hasEmergencyFund}
        ariaLabel={
          hasEmergencyFund
            ? undefined
            : "Dana darurat: belum ada. Tambahkan target dana darurat untuk mulai memantau."
        }
      />
    </section>
  );
}

// Pure helpers exposed for the unit test (sub-0007-02 AC):
// `formatPercent(0..100) → "NN%"`, `KpiTone` color mapping, and the
// EF empty-state branching are all covered.
export { formatPercent };
export { TONE_STYLES };
