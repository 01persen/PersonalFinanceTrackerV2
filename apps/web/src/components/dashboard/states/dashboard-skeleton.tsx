"use client";

/**
 * Loading skeleton for the dashboard page (sub-0007-08).
 *
 * Renders 4 KPI card placeholders + 3 chart placeholders (line + bar +
 * donut outline) using Tailwind `animate-pulse`. Mirrors the structure
 * of the loaded dashboard so the layout doesn't shift when data lands,
 * and matches the pulse pattern from `<MonthlySkeleton>` (sub-0003-07)
 * and `<GoalsSkeleton>` (sub-0005-03) so the dashboard reads as part
 * of the same family.
 *
 * Pure presentational — no fetch / state of its own. Race defense
 * lives in the parent (`dashboard-content.tsx` via `latestLoadIdRef`,
 * sub-0007-02).
 */
export function DashboardSkeleton() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-live="polite"
      aria-busy="true"
      data-testid="dashboard-skeleton"
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={`kpi-${index}`}
            className="card flex h-full flex-col gap-3"
            data-testid={`dashboard-kpi-skeleton-${index}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="h-3 w-24 animate-pulse rounded bg-slate-200" />
              <div className="h-9 w-9 animate-pulse rounded-xl bg-slate-200" />
            </div>
            <div className="h-7 w-32 animate-pulse rounded bg-slate-200" />
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-12 md:gap-6">
        <div className="card md:col-span-8" data-testid="dashboard-line-skeleton">
          <div className="h-4 w-32 animate-pulse rounded bg-slate-200" />
          <div className="mt-6 h-48 w-full animate-pulse rounded-xl bg-slate-100" />
        </div>
        <div className="card md:col-span-4" data-testid="dashboard-bar-skeleton">
          <div className="h-4 w-28 animate-pulse rounded bg-slate-200" />
          <div className="mt-6 flex h-48 items-end gap-2">
            {Array.from({ length: 5 }).map((_, index) => (
              <div
                key={`bar-${index}`}
                className="h-full w-full animate-pulse rounded bg-slate-100"
              />
            ))}
          </div>
        </div>
        <div
          className="card md:col-span-12"
          data-testid="dashboard-donut-skeleton"
        >
          <div className="h-4 w-36 animate-pulse rounded bg-slate-200" />
          <div className="mt-6 flex h-40 items-center justify-center">
            <div className="h-32 w-32 animate-pulse rounded-full border-8 border-slate-100" />
          </div>
        </div>
      </div>

      <span className="sr-only">Memuat dashboard...</span>
    </div>
  );
}