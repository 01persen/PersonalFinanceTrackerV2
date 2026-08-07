"use client";

import Link from "next/link";

import { NetworthTrendChart } from "@/components/dashboard/charts/networth-trend-chart";
import {
  KpiCard,
  formatPercent,
} from "@/components/dashboard/kpi-cards";
import { formatIdrFromCents } from "@/lib/dashboard/idr";
import type {
  DashboardNetworthTrend,
  DashboardSummary,
} from "@/lib/dashboard/types";

interface DashboardMobileSummaryProps {
  /**
   * Pre-fetched dashboard summary (KPI numbers + EF percentage).
   * Pure presentation — the page owns the fetch + race-defense, this
   * component just renders. Matches the contract pinned by sub-0007-02
   * for the full desktop dashboard.
   */
  summary: DashboardSummary;
  /**
   * Pre-fetched networth trend series. The component trims the series
   * to `MOBILE_TREND_MONTHS` (last 6 months) before passing it to the
   * chart so the 390×844 viewport reads cleanly without cramming 12
   * labels into a narrow column.
   */
  networthTrend: DashboardNetworthTrend;
}

/**
 * Default trend window for the mobile ringkas view. Six months strikes
 * a balance between "enough data to read the direction" and "labels
 * still readable on a 390 px viewport" — twelve months would force
 * the chart's month labels to overlap on a phone screen. Exported so
 * the unit test can pin the rule without reaching into the component.
 */
export const MOBILE_TREND_MONTHS = 6;

/**
 * Touch-target floor per Apple HIG + WCAG 2.5.5 (≥ 44 × 44 px). The
 * KPI cards already inherit `.card` padding (24 px) so the visible
 * value sits inside a tappable region well above the threshold; the
 * "Lihat dashboard lengkap" CTA is built on `.btn-primary` with an
 * explicit `min-h-[44px]` so the link stays a comfortable tap target
 * even when the label is short.
 */
const MIN_TOUCH_TARGET_HEIGHT = "min-h-[44px]";

/**
 * Compute the trend slice for the mobile view. Returns the last
 * `MOBILE_TREND_MONTHS` entries so the chart still anchors on the
 * freshest data even when the BE returns a longer series. Exported so
 * the unit test can pin the slice behaviour without re-implementing
 * the page-level wiring.
 */
export function trimTrendForMobile(
  data: DashboardNetworthTrend["data"],
  months: number = MOBILE_TREND_MONTHS,
): DashboardNetworthTrend["data"] {
  if (data.length <= months) return data;
  return data.slice(-months);
}

/**
 * Build the ARIA label for the "Lihat dashboard lengkap" CTA. The label
 * spells out the destination so a screen reader doesn't have to follow
 * the link to know it's a navigation, not a destructive action.
 */
export function buildExpandLabel(): string {
  return "Lihat dashboard lengkap pada halaman penuh";
}

/**
 * Compact ringkas view rendered below the `md` breakpoint (390 × 844
 * viewport — PRD §5). Mirrors the table-vs-cards pattern from
 * sub-0003-07 / sub-0007-02:
 *
 *   - Two-column KPI grid (4 cards in a 2 × 2 layout) so each card
 *     stays scannable on a narrow phone column.
 *   - One chart utama — `<NetworthTrendChart>` trimmed to the last
 *     six months so labels stay readable on a phone.
 *   - One full-width CTA that jumps to the dedicated
 *     `/dashboard/full` route for users who want the desktop view on
 *     their phone.
 *
 * Touch targets: every KPI card inherits the `.card` padding (24 px)
 * which already exceeds 44 × 44 px; the CTA carries an explicit
 * `min-h-[44px]` per Apple HIG / WCAG 2.5.5. Hidden on `md+` so the
 * desktop `<DashboardPage>` (12-column grid, four-up KPI row, four
 * charts + widgets) takes over above 768 px.
 *
 * The component is purely presentational — fetching, race defense,
 * retry, and route wiring live in `app/page.tsx` so the same
 * `loadDashboard()` call services both views.
 */
export function DashboardMobileSummary({
  summary,
  networthTrend,
}: DashboardMobileSummaryProps) {
  const trimmed = trimTrendForMobile(networthTrend.data);
  const hasEmergencyFund = summary.emergencyFundAvgPct !== null;
  const networthTone =
    summary.networthCents >= 0 ? "positive" : "negative";

  return (
    <section
      className="space-y-4 md:hidden"
      aria-labelledby="dashboard-mobile-summary-heading"
      data-testid="dashboard-mobile-summary"
      data-trend-months={trimmed.length}
    >
      <h2
        id="dashboard-mobile-summary-heading"
        className="sr-only"
      >
        Ringkasan dashboard untuk layar kecil
      </h2>

      <div
        className="grid grid-cols-2 gap-3"
        role="list"
        data-testid="dashboard-mobile-summary-kpis"
      >
        <div role="listitem" className="min-h-[88px]">
          <KpiCard
            label="Networth"
            value={formatIdrFromCents(summary.networthCents)}
            hint="Aset − Kewajiban"
            tone={networthTone}
          />
        </div>
        <div role="listitem" className="min-h-[88px]">
          <KpiCard
            label="Pemasukan"
            value={formatIdrFromCents(summary.incomeThisMonthCents)}
            hint="Bulan ini"
            tone="positive"
          />
        </div>
        <div role="listitem" className="min-h-[88px]">
          <KpiCard
            label="Pengeluaran"
            value={formatIdrFromCents(summary.expenseThisMonthCents)}
            hint="Bulan ini"
            tone="neutral"
          />
        </div>
        <div role="listitem" className="min-h-[88px]">
          <KpiCard
            label="Dana darurat"
            value={
              hasEmergencyFund && summary.emergencyFundAvgPct !== null
                ? formatPercent(summary.emergencyFundAvgPct)
                : "Belum ada dana darurat"
            }
            hint={
              hasEmergencyFund
                ? "Rata-rata progress"
                : "Tambahkan target dana darurat"
            }
            tone="info"
            disabled={!hasEmergencyFund}
            ariaLabel={
              hasEmergencyFund
                ? undefined
                : "Dana darurat: belum ada. Tambahkan target dana darurat untuk mulai memantau."
            }
          />
        </div>
      </div>

      <NetworthTrendChart data={trimmed} />

      <Link
        href="/dashboard/full"
        className={`btn-primary ${MIN_TOUCH_TARGET_HEIGHT}`}
        aria-label={buildExpandLabel()}
        data-testid="dashboard-mobile-summary-expand"
      >
        Lihat dashboard lengkap
      </Link>
    </section>
  );
}