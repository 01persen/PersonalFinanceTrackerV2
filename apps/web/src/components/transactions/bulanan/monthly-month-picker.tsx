"use client";

interface MonthlyMonthPickerProps {
  year: number;
  month: number;
  onChange: (next: { year: number; month: number }) => void;
  isCurrentMonth: boolean;
}

const MONTH_LABELS_ID = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
];

/**
 * Format a 1-indexed month + 4-digit year as an Indonesian long label,
 * e.g. ``Juli 2026``. The picker renders this between the prev/next
 * buttons so the user always knows which month they're looking at.
 */
function formatMonthLabel(year: number, month: number): string {
  if (month < 1 || month > 12) return `${year}`;
  return `${MONTH_LABELS_ID[month - 1]} ${year}`;
}

function shiftMonth(
  year: number,
  month: number,
  delta: number,
): { year: number; month: number } {
  const next = new Date(year, month - 1 + delta, 1);
  return { year: next.getFullYear(), month: next.getMonth() + 1 };
}

/**
 * Month navigation for the "Pendapatan & Pengeluaran Bulanan" page.
 * Renders prev/next buttons, the current month label, and a "Bulan ini"
 * shortcut that fires when the user has paged away from the current
 * month. The shortcut is disabled when the user is already on it.
 */
export function MonthlyMonthPicker({
  year,
  month,
  onChange,
  isCurrentMonth,
}: MonthlyMonthPickerProps) {
  const handlePrev = () => {
    const next = shiftMonth(year, month, -1);
    onChange(next);
  };
  const handleNext = () => {
    const next = shiftMonth(year, month, 1);
    onChange(next);
  };
  const handleToday = () => {
    const now = new Date();
    onChange({ year: now.getFullYear(), month: now.getMonth() + 1 });
  };

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3"
      role="group"
      aria-label="Pilih bulan"
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="btn-secondary !w-auto px-3 py-2"
          onClick={handlePrev}
          aria-label="Bulan sebelumnya"
        >
          <span aria-hidden="true">‹</span>
          <span className="sr-only sm:not-sr-only sm:ml-1">Sebelumnya</span>
        </button>
        <button
          type="button"
          className="btn-secondary !w-auto px-3 py-2"
          onClick={handleNext}
          aria-label="Bulan berikutnya"
        >
          <span className="sr-only sm:not-sr-only sm:mr-1">Berikutnya</span>
          <span aria-hidden="true">›</span>
        </button>
        <p
          className="ml-2 text-base font-semibold text-slate-900 sm:text-lg"
          aria-live="polite"
        >
          {formatMonthLabel(year, month)}
        </p>
      </div>
      <button
        type="button"
        className="text-xs font-semibold text-brand-700 hover:text-brand-900 hover:underline focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
        onClick={handleToday}
        disabled={isCurrentMonth}
      >
        Bulan ini
      </button>
    </div>
  );
}
