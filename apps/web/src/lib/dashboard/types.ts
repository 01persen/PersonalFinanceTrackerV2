/**
 * FE mirrors of the dashboard aggregation endpoints (sub-0007-01).
 *
 * Each interface below is a hand-written counterpart to the Pydantic
 * `*Public` schema in `apps/api/src/app/api/schemas.py` — same field
 * names, same `cents`/integer convention, same `null`-vs-zero distinction
 * for the EF average. We don't ship a runtime validator here: the
 * `dashboard-client` adapter layer owns the snake_case → camelCase
 * mapping and treats malformed payloads as the error-retry path, so
 * the dashboard page only ever sees fully typed values.
 *
 * Field-level notes (cross-referenced with `dashboard.py`):
 *
 * - `DashboardSummary.emergencyFundAvgPct` is `null` when the user has
 *   no active EF goal — the FE renders "Belum ada dana darurat"
 *   instead of a misleading `0%`. Do not collapse to `0` here.
 * - All `*_cents` fields are integer minor units (1/100 rupiah). The
 *   FE surfaces whole-rupiah only; the IDR formatter (`idr.ts`)
 *   rounds down at display time.
 * - Trend point `month` strings are `YYYY-MM` (no day component).
 */

import type { GoalKind } from "@/lib/api/goals";

export interface DashboardSummary {
  currency: string;
  networthCents: number;
  totalAssetsCents: number;
  totalLiabilitiesCents: number;
  incomeThisMonthCents: number;
  expenseThisMonthCents: number;
  /** `null` when the user has no active EF goal — render empty state. */
  emergencyFundAvgPct: number | null;
}

export interface DashboardNetworthTrendPoint {
  month: string;
  networthCents: number;
}

export interface DashboardNetworthTrend {
  data: DashboardNetworthTrendPoint[];
}

export interface DashboardIncomeExpenseTrendPoint {
  month: string;
  incomeCents: number;
  expenseCents: number;
}

export interface DashboardIncomeExpenseTrend {
  data: DashboardIncomeExpenseTrendPoint[];
}

export interface DashboardTopCategory {
  categoryId: string | null;
  categoryName: string | null;
  totalCents: number;
  percentage: number;
}

export interface DashboardTopCategories {
  data: DashboardTopCategory[];
}

/**
 * Goal status as surfaced by the dashboard endpoint. Mirrors the BE
 * `Literal["active", "achieved", "archived"]` enum (see `schemas.py`).
 */
export type DashboardGoalStatus = "active" | "achieved" | "archived";

export interface DashboardGoalProgress {
  goalId: string;
  name: string;
  kind: GoalKind;
  currentCents: number;
  targetCents: number;
  pct: number;
  status: DashboardGoalStatus;
  dueDate: string | null;
}

export interface DashboardGoalsProgress {
  data: DashboardGoalProgress[];
}

export interface DashboardDebtsSummary {
  totalRemainingCents: number;
  totalInterestPaidCents: number;
  activeCount: number;
  paidOffCount: number;
}

/**
 * Convenience union for the four KPI-card slots the dashboard renders
 * above the charts. Mirrors the visual ordering — the FE renders them
 * left-to-right, top-to-bottom inside the responsive grid. Keep this
 * shape stable: chart sub-tasks (sub-0007-03/04/05) read the same
 * `DashboardSummary` object via the `fetchDashboardSummary` helper.
 */
export interface DashboardKpiSnapshot {
  networthCents: number;
  incomeThisMonthCents: number;
  expenseThisMonthCents: number;
  emergencyFundAvgPct: number | null;
}
