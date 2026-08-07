/**
 * Placeholder slot for the income-vs-expense bar chart (sub-0007-04).
 * See `networth-trend-placeholder.tsx` for the rationale.
 */
export function IncomeExpenseTrendPlaceholder() {
  return (
    <section
      className="card flex h-full flex-col"
      aria-labelledby="dashboard-income-expense-trend-heading"
      data-placeholder="income-expense-trend"
    >
      <header className="flex items-center justify-between gap-3">
        <div>
          <h3
            id="dashboard-income-expense-trend-heading"
            className="text-base font-semibold text-slate-900"
          >
            Pemasukan vs Pengeluaran
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
        Grafik batang pemasukan &amp; pengeluaran akan tampil di sini
        pada sub-0007-04.
      </div>
    </section>
  );
}
