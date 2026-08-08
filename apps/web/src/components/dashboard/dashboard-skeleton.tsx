/**
 * Loading skeleton for the dashboard page (sub-0007-02).
 *
 * Mirrors the structure of the loaded dashboard so the layout doesn't
 * shift when data lands: four KPI-card slots in the first row, two
 * chart slots in the second row, and two widget slots in the third
 * row. Animation reuse matches `<MonthlySkeleton>` so the page reads
 * as part of the same family.
 */
export function DashboardSkeleton() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={`kpi-${index}`}
            className="card flex h-full flex-col gap-3"
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
        <div className="card md:col-span-8">
          <div className="h-4 w-32 animate-pulse rounded bg-slate-200" />
          <div className="mt-6 h-48 w-full animate-pulse rounded-xl bg-slate-100" />
        </div>
        <div className="card md:col-span-4">
          <div className="h-4 w-28 animate-pulse rounded bg-slate-200" />
          <div className="mt-6 h-48 w-full animate-pulse rounded-xl bg-slate-100" />
        </div>
        <div className="card md:col-span-6">
          <div className="h-4 w-36 animate-pulse rounded bg-slate-200" />
          <div className="mt-6 h-40 w-full animate-pulse rounded-xl bg-slate-100" />
        </div>
        <div className="card md:col-span-6">
          <div className="h-4 w-36 animate-pulse rounded bg-slate-200" />
          <div className="mt-6 h-40 w-full animate-pulse rounded-xl bg-slate-100" />
        </div>
      </div>

      <span className="sr-only">Memuat dashboard...</span>
    </div>
  );
}
