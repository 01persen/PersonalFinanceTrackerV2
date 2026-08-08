"use client";

import { formatIdrFromCents } from "@/lib/dashboard/idr";
import type { DashboardDebtsSummary } from "@/lib/dashboard/types";

interface DebtSummarySectionProps {
  /**
   * Per-user debt ledger aggregate returned by `GET /dashboard/debts-summary`
   * (sub-0007-01 BE + `dashboard-client.ts` adapter). Same prop-driven
   * contract as `<GoalProgressSection>`: the page owns the parallel
   * fetch and race defense, the widget stays purely presentational.
   *
   * `null` means "the page has not loaded the endpoint yet" — the
   * widget renders a skeleton grid so the slot keeps its footprint
   * while the rest of the dashboard bundle resolves.
   */
  summary: DashboardDebtsSummary | null;
}

/**
 * True when the debts summary has no active AND no paid-off debts.
 * Drives the empty-state branching — the dashboard section hides
 * itself with a guided message so a brand-new user (who hasn't
 * recorded any debt yet) doesn't see four zeros that look like a
 * real report.
 */
export function isDebtsSummaryEmpty(summary: DashboardDebtsSummary): boolean {
  return summary.activeCount === 0 && summary.paidOffCount === 0;
}

/**
 * Pick the visual tone for the "Sisa saldo" tile. The spec calls for
 * rose-600 when there's outstanding debt (warning) and slate when
 * the user has paid everything off (so the tile doesn't keep the
 * warning colour after the user is debt-free).
 */
export function resolveRemainingTone(summary: DashboardDebtsSummary): "rose" | "slate" {
  return summary.totalRemainingCents > 0 ? "rose" : "slate";
}

/**
 * Build the screen-reader summary line. Pinned here (not at the
 * call-site) so the order of clauses stays consistent between the
 * visible card and any future ARIA-live re-announcement.
 */
export function buildDebtsAriaSummary(summary: DashboardDebtsSummary): string {
  return `${summary.activeCount} utang aktif, ${summary.paidOffCount} lunas. Total sisa saldo ${formatIdrFromCents(summary.totalRemainingCents)}, total bunga dibayar ${formatIdrFromCents(summary.totalInterestPaidCents)}.`;
}

interface TileSpec {
  label: string;
  hint: string;
  tone: "rose" | "amber" | "slate" | "emerald";
  testId: string;
}

const REMAINING_TILE: TileSpec = {
  label: "Sisa saldo",
  hint: "Total pokok utang aktif yang belum dibayar.",
  tone: "rose",
  testId: "debt-tile-remaining",
};

const INTEREST_TILE: TileSpec = {
  label: "Total bunga dibayar",
  hint: "Akumulasi porsi bunga dari setiap cicilan.",
  tone: "amber",
  testId: "debt-tile-interest",
};

const ACTIVE_TILE: TileSpec = {
  label: "Utang aktif",
  hint: "Jumlah utang berstatus aktif.",
  tone: "slate",
  testId: "debt-tile-active",
};

const PAID_OFF_TILE: TileSpec = {
  label: "Lunas",
  hint: "Jumlah utang yang sudah lunas.",
  tone: "emerald",
  testId: "debt-tile-paid",
};

const TONE_TEXT_CLASSES: Record<TileSpec["tone"], string> = {
  rose: "text-rose-600",
  amber: "text-amber-600",
  slate: "text-slate-600",
  emerald: "text-emerald-600",
};

const TONE_BADGE_CLASSES: Record<TileSpec["tone"], string> = {
  rose: "bg-rose-100 text-rose-700",
  amber: "bg-amber-100 text-amber-700",
  slate: "bg-slate-100 text-slate-700",
  emerald: "bg-emerald-100 text-emerald-700",
};

/**
 * Dashboard widget that surfaces the per-user debt ledger aggregate
 * (sub-0007-06). The widget renders four tiles mirroring the colour
 * palette pinned on the debts list page (sub-0006-04):
 *
 *   - "Sisa saldo"   → rose-600 when > 0, slate otherwise
 *   - "Total bunga dibayar" → amber-600
 *   - "Utang aktif"  → slate-600
 *   - "Lunas"        → emerald-600
 *
 * Currency formatting goes through `formatIdrFromCents` (sub-0007-02)
 * so the values read consistently with the KPI cards and the goals
 * widget. Empty state mirrors `<DebtEmptyState>` (sub-0006-04):
 * when the user has no debt at all the section collapses to a
 * guided message that links the user back to the debts page if
 * they want to record one.
 */
export function DebtSummarySection({ summary }: DebtSummarySectionProps) {
  if (summary === null) {
    return <DebtSummarySectionSkeleton />;
  }

  if (isDebtsSummaryEmpty(summary)) {
    return <DebtSummaryEmptyState />;
  }

  const remainingTone = resolveRemainingTone(summary);
  const remainingTile: TileSpec = {
    ...REMAINING_TILE,
    tone: remainingTone,
  };

  return (
    <section
      className="card flex h-full flex-col"
      role="region"
      aria-label="Ringkasan Utang"
      data-testid="dashboard-debts-summary"
      data-empty="false"
    >
      <header className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-900">
            Ringkasan Utang
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            Sisa saldo &amp; total bunga
          </p>
        </div>
        <span
          className="rounded-full bg-slate-100 px-2.5 py-1 text-[0.65rem] font-semibold uppercase tracking-wide text-slate-500"
          data-testid="dashboard-debts-summary-count"
        >
          {summary.activeCount + summary.paidOffCount} utang
        </span>
      </header>
      <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <SummaryTile spec={remainingTile} value={formatIdrFromCents(summary.totalRemainingCents)} />
        <SummaryTile spec={INTEREST_TILE} value={formatIdrFromCents(summary.totalInterestPaidCents)} />
        <SummaryTile spec={ACTIVE_TILE} value={String(summary.activeCount)} />
        <SummaryTile spec={PAID_OFF_TILE} value={String(summary.paidOffCount)} />
      </dl>
      <p className="sr-only">{buildDebtsAriaSummary(summary)}</p>
    </section>
  );
}

interface SummaryTileProps {
  spec: TileSpec;
  value: string;
}

function SummaryTile({ spec, value }: SummaryTileProps) {
  return (
    <div
      className="flex flex-col gap-1 rounded-xl border border-slate-100 bg-white p-3"
      data-testid={spec.testId}
      data-tone={spec.tone}
    >
      <div className="flex items-center justify-between gap-2">
        <dt className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-slate-500">
          {spec.label}
        </dt>
        <span
          className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[0.65rem] font-bold ${TONE_BADGE_CLASSES[spec.tone]}`}
          aria-hidden="true"
        >
          ●
        </span>
      </div>
      <dd
        className={`text-xl font-bold tabular-nums ${TONE_TEXT_CLASSES[spec.tone]}`}
      >
        {value}
      </dd>
      <p className="text-[0.7rem] leading-4 text-slate-500">{spec.hint}</p>
    </div>
  );
}

function DebtSummaryEmptyState() {
  return (
    <section
      className="card flex h-full flex-col items-center justify-center gap-2 py-8 text-center"
      role="region"
      aria-label="Ringkasan Utang"
      data-testid="dashboard-debts-summary"
      data-empty="true"
    >
      <h3 className="text-base font-semibold text-slate-900">
        Tidak ada utang aktif. Lewati section ini.
      </h3>
      <p className="max-w-sm text-xs leading-5 text-slate-500">
        Begitu kamu mencatat pinjaman pertama di halaman Utang,
        ringkasan sisa saldo &amp; total bunga akan tampil di sini.
      </p>
    </section>
  );
}

function DebtSummarySectionSkeleton() {
  return (
    <section
      className="card flex h-full flex-col"
      role="region"
      aria-label="Ringkasan Utang"
      aria-busy="true"
      aria-live="polite"
      data-testid="dashboard-debts-summary"
      data-loading="true"
    >
      <header className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-900">
            Ringkasan Utang
          </h3>
          <p className="mt-1 text-xs text-slate-500">Memuat ringkasan…</p>
        </div>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[0.65rem] font-semibold uppercase tracking-wide text-slate-500">
          Memuat
        </span>
      </header>
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {[0, 1, 2, 3].map((tile) => (
          <div
            key={`debt-skeleton-${tile}`}
            className="flex flex-col gap-2 rounded-xl border border-slate-100 bg-white p-3"
          >
            <div className="h-3 w-20 animate-pulse rounded bg-slate-200" />
            <div className="h-6 w-28 animate-pulse rounded bg-slate-100" />
            <div className="h-3 w-32 animate-pulse rounded bg-slate-100" />
          </div>
        ))}
      </div>
      <span className="sr-only">Memuat ringkasan utang…</span>
    </section>
  );
}
