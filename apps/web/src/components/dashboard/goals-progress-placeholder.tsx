/**
 * Placeholder slot for the per-goal progress widget (sub-0007-06).
 * See `networth-trend-placeholder.tsx` for the rationale.
 */
export function GoalsProgressPlaceholder() {
  return (
    <section
      className="card flex h-full flex-col"
      aria-labelledby="dashboard-goals-progress-heading"
      data-placeholder="goals-progress"
    >
      <header className="flex items-center justify-between gap-3">
        <div>
          <h3
            id="dashboard-goals-progress-heading"
            className="text-base font-semibold text-slate-900"
          >
            Progres Target
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            Tabungan &amp; dana darurat aktif
          </p>
        </div>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[0.65rem] font-semibold uppercase tracking-wide text-slate-500">
          Segera hadir
        </span>
      </header>
      <div className="mt-6 flex flex-1 items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-12 text-center text-xs text-slate-500">
        Daftar progres target akan tampil di sini pada sub-0007-06.
      </div>
    </section>
  );
}
