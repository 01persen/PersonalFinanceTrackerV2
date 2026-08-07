/**
 * Placeholder slot for the networth trend chart (sub-0007-03).
 *
 * sub-0007-02 ships the dashboard layout with an empty card slot so
 * the grid + KPI cards land together; the actual line-chart rendering
 * (hand-rolled SVG per the SOP decision) lands in sub-0007-03. The
 * placeholder here keeps the layout stable so the page doesn't shift
 * when the chart swaps in.
 */
export function NetworthTrendPlaceholder() {
  return (
    <section
      className="card flex h-full flex-col"
      aria-labelledby="dashboard-networth-trend-heading"
      data-placeholder="networth-trend"
    >
      <header className="flex items-center justify-between gap-3">
        <div>
          <h3
            id="dashboard-networth-trend-heading"
            className="text-base font-semibold text-slate-900"
          >
            Tren Networth
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            12 bulan terakhir
          </p>
        </div>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[0.65rem] font-semibold uppercase tracking-wide text-slate-500">
          Segera hadir
        </span>
      </header>
      <div className="mt-6 flex flex-1 items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-12 text-center text-xs text-slate-500">
        Grafik tren networth akan tampil di sini pada sub-0007-03.
      </div>
    </section>
  );
}
