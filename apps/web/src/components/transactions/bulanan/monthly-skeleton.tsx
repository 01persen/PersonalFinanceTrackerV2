"use client";

export function MonthlySkeleton() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="space-y-3">
        <div className="h-5 w-48 animate-pulse rounded bg-slate-200" />
        <div className="grid gap-3 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <div
              key={index}
              className="rounded-2xl border border-slate-200 bg-slate-50 p-5"
            >
              <div className="h-3 w-24 animate-pulse rounded bg-slate-200" />
              <div className="mt-4 h-7 w-32 animate-pulse rounded bg-slate-200" />
            </div>
          ))}
        </div>
      </div>

      <div className="card hidden overflow-hidden p-0 md:block">
        <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
          <div className="h-3 w-32 animate-pulse rounded bg-slate-200" />
        </div>
        <ul className="divide-y divide-slate-100">
          {Array.from({ length: 5 }).map((_, index) => (
            <li key={index} className="flex items-center gap-4 px-4 py-3">
              <div className="h-4 w-16 animate-pulse rounded bg-slate-200" />
              <div className="h-4 w-20 animate-pulse rounded bg-slate-200" />
              <div className="h-4 w-24 animate-pulse rounded bg-slate-200" />
              <div className="h-4 flex-1 animate-pulse rounded bg-slate-100" />
              <div className="h-4 w-32 animate-pulse rounded bg-slate-200" />
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-3 md:hidden">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="card">
            <div className="h-4 w-32 animate-pulse rounded bg-slate-200" />
            <div className="mt-3 space-y-2">
              <div className="h-3 w-full animate-pulse rounded bg-slate-100" />
              <div className="h-3 w-4/5 animate-pulse rounded bg-slate-100" />
            </div>
          </div>
        ))}
      </div>

      <span className="sr-only">Memuat ringkasan bulanan...</span>
    </div>
  );
}
