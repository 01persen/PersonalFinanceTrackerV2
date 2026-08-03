"use client";

import {
  DEBT_KIND_FILTER_LABEL,
  formatDebtIdrAmountOnly,
  type DebtKindFilterValue,
} from "@/lib/api/debt-client";

interface DebtKindChipsProps {
  value: DebtKindFilterValue;
  onChange: (next: DebtKindFilterValue) => void;
  /** Optional counts surfaced inside each chip (e.g. "Kartu kredit (2)"). */
  counts?: Partial<Record<DebtKindFilterValue, number>>;
}

const KIND_ORDER: DebtKindFilterValue[] = [
  "all",
  "loan",
  "credit_card",
  "paylater",
  "KTA",
  "KKB",
  "KPR",
  "other",
];

const BASE_CHIP_CLASS =
  "inline-flex min-h-[2.75rem] shrink-0 items-center justify-center rounded-full border px-4 text-sm font-semibold transition focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2";

const ACTIVE_CHIP_CLASS =
  "border-transparent bg-brand-600 text-white shadow-sm shadow-brand-900/30";

const INACTIVE_CHIP_CLASS =
  "border-slate-300 bg-white text-slate-700 hover:bg-slate-100";

/**
 * Horizontal kind chip strip for the `/debts` list page. Mirrors
 * `GoalFilterChips` (sub-0005-03) so the chip row reads identically
 * across the app — same 44 px tap area, same horizontal scroll on
 * mobile (390 px baseline), same active/inactive palette.
 *
 * The page keeps two filter dimensions in sync with the URL
 * (``status`` via `?status=`, ``kind`` via `?kind=`). The kind chip
 * only mutates the kind dimension; the page handles URL hydration
 * for both.
 */
export function DebtKindChips({ value, onChange, counts }: DebtKindChipsProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Filter jenis utang"
      className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0"
      data-testid="debts-kind-chips"
    >
      {KIND_ORDER.map((chipValue) => {
        const active = chipValue === value;
        const count = counts?.[chipValue];
        return (
          <button
            key={chipValue}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(chipValue)}
            className={`${BASE_CHIP_CLASS} ${active ? ACTIVE_CHIP_CLASS : INACTIVE_CHIP_CLASS}`}
            data-value={chipValue}
          >
            <span>{DEBT_KIND_FILTER_LABEL[chipValue]}</span>
            {typeof count === "number" ? (
              <span
                className={`ml-2 rounded-full px-1.5 py-0.5 text-xs font-semibold ${
                  active ? "bg-white/20 text-white" : "bg-slate-100 text-slate-600"
                }`}
              >
                {count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Status chip strip ("Semua" / "Aktif" / "Lunas"). Visually identical
 * to `DebtKindChips` — only the labels differ — so the two rows look
 * like the same component family on mobile.
 */
interface DebtStatusChipsProps {
  value: "all" | "active" | "paid_off";
  onChange: (next: "all" | "active" | "paid_off") => void;
  counts?: Partial<Record<"all" | "active" | "paid_off", number>>;
}

const STATUS_LABELS: Record<"all" | "active" | "paid_off", string> = {
  all: "Semua",
  active: "Aktif",
  paid_off: "Lunas",
};

const STATUS_ORDER: ("all" | "active" | "paid_off")[] = [
  "all",
  "active",
  "paid_off",
];

export function DebtStatusChips({ value, onChange, counts }: DebtStatusChipsProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Filter status utang"
      className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0"
      data-testid="debts-status-chips"
    >
      {STATUS_ORDER.map((chipValue) => {
        const active = chipValue === value;
        const count = counts?.[chipValue];
        return (
          <button
            key={chipValue}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(chipValue)}
            className={`${BASE_CHIP_CLASS} ${active ? ACTIVE_CHIP_CLASS : INACTIVE_CHIP_CLASS}`}
            data-value={chipValue}
          >
            <span>{STATUS_LABELS[chipValue]}</span>
            {typeof count === "number" ? (
              <span
                className={`ml-2 rounded-full px-1.5 py-0.5 text-xs font-semibold ${
                  active ? "bg-white/20 text-white" : "bg-slate-100 text-slate-600"
                }`}
              >
                {count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Compact money helper used inside the ringkasan card. Re-exported so
 * the card itself doesn't have to thread a custom label through — it
 * reads ``Rp X`` formatted to whole rupiah.
 */
export function formatRupiahFromCents(cents: number): string {
  return formatDebtIdrAmountOnly(cents);
}