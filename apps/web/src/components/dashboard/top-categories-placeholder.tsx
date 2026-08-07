/**
 * Placeholder slot for the top-categories donut chart (sub-0007-05).
 * See `networth-trend-placeholder.tsx` for the rationale.
 */
export function TopCategoriesPlaceholder() {
  return (
    <section
      className="card flex h-full flex-col"
      aria-labelledby="dashboard-top-categories-heading"
      data-placeholder="top-categories"
    >
      <header className="flex items-center justify-between gap-3">
        <div>
          <h3
            id="dashboard-top-categories-heading"
            className="text-base font-semibold text-slate-900"
          >
            Kategori Pengeluaran Teratas
          </h3>
          <p className="mt-1 text-xs text-slate-500">Bulan ini</p>
        </div>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[0.65rem] font-semibold uppercase tracking-wide text-slate-500">
          Segera hadir
        </span>
      </header>
      <div className="mt-6 flex flex-1 items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-12 text-center text-xs text-slate-500">
        Grafik donat kategori pengeluaran akan tampil di sini pada
        sub-0007-05.
      </div>
    </section>
  );
}
