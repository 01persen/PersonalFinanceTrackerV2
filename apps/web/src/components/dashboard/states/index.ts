/**
 * Reusable state components for the dashboard module (sub-0007-08).
 *
 * The components here mirror the patterns established by earlier
 * epics:
 *
 *   - `<DashboardEmptyState>` mirrors `<MonthlyEmptyState>` (sub-0003-07)
 *     and `<DebtEmptyState>` (sub-0006-04) — centered card + CTA.
 *   - `<DashboardSkeleton>` mirrors `<MonthlySkeleton>` (sub-0003-07)
 *     — `animate-pulse` + `role="status"` so the page reads as part
 *     of the same family.
 *   - `<DashboardError>` mirrors `<GoalsError>` (sub-0005-03) —
 *     red border, alert role, retry button.
 *   - `<LookupWarning>` mirrors the inline `<LookupWarning>` on
 *     `goals/page.tsx` (sub-0005-03) — amber border, status role,
 *     retry button. AC sub-0007-08 asks for this pair to also surface
 *     a non-blocking `<Toast>` so the user notices the fallback even
 *     if the banner is off-screen.
 *
 * Pages and feature widgets import from `@/components/dashboard/states`
 * only — never reach into individual files. Race defense lives in
 * the parent (`dashboard-content.tsx` via `latestLoadIdRef`,
 * sub-0007-02); see `dashboard-client.ts` for the abort + adapter
 * layering.
 */
export { DashboardEmptyState } from "@/components/dashboard/states/dashboard-empty-state";
export { DashboardSkeleton } from "@/components/dashboard/states/dashboard-skeleton";
export { DashboardError } from "@/components/dashboard/states/dashboard-error";
export { LookupWarning } from "@/components/dashboard/states/lookup-warning";
export { Toast, scheduleToastDismiss } from "@/components/dashboard/states/toast";