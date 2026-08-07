/**
 * Public surface for the dashboard module (sub-0007-02 + sub-0007-03+).
 * Pages import from `@/components/dashboard` only — never reach into
 * individual files. Mirrors the same barrel convention used by the
 * goals / transactions / debts modules so refactors stay contained.
 */
export { DashboardHeader } from "@/components/dashboard/dashboard-header";
export { DashboardGrid } from "@/components/dashboard/dashboard-grid";
export { DashboardError } from "@/components/dashboard/dashboard-error";
export { DashboardSkeleton } from "@/components/dashboard/dashboard-skeleton";
export {
  KpiCard,
  KpiCards,
  type KpiTone,
  formatPercent,
  TONE_STYLES,
} from "@/components/dashboard/kpi-cards";
export { NetworthTrendChart } from "@/components/dashboard/charts/networth-trend-chart";
export { IncomeExpenseChart } from "@/components/dashboard/charts/income-expense-chart";
export { TopCategoriesPlaceholder } from "@/components/dashboard/top-categories-placeholder";
export { GoalsProgressPlaceholder } from "@/components/dashboard/goals-progress-placeholder";
export { DebtsSummaryPlaceholder } from "@/components/dashboard/debts-summary-placeholder";
