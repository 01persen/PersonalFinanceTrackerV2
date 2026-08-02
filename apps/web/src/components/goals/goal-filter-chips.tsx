"use client";

import { GOAL_KIND_LABEL, type GoalKind } from "@/lib/api/goal-client";

export type GoalFilterValue = GoalKind | "all";

interface GoalFilterChipsProps {
  value: GoalFilterValue;
  onChange: (next: GoalFilterValue) => void;
  /** Optional counts surfaced inside each chip (e.g. "Tabungan (3)"). */
  counts?: Partial<Record<GoalFilterValue, number>>;
}

interface ChipSpec {
  value: GoalFilterValue;
  label: string;
}

const CHIPS: ChipSpec[] = [
  { value: "all", label: "Semua" },
  { value: "saving", label: GOAL_KIND_LABEL.saving },
  { value: "emergency_fund", label: GOAL_KIND_LABEL.emergency_fund },
];

const BASE_CHIP_CLASS =
  "inline-flex min-h-[2.75rem] items-center justify-center rounded-full border px-4 text-sm font-semibold transition focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2";

const ACTIVE_CHIP_CLASS =
  "border-transparent bg-brand-600 text-white shadow-sm shadow-brand-900/30";

const INACTIVE_CHIP_CLASS =
  "border-slate-300 bg-white text-slate-700 hover:bg-slate-100";

/**
 * "Semua" / "Tabungan" / "Dana darurat" filter chips for the goals list
 * page. Controlled by the `?kind=` query param so the URL stays
 * shareable. The chips live in a horizontal scrollable row on mobile
 * (390 px baseline) — each chip has a 44 px tap area (AC mobile-first).
 */
export function GoalFilterChips({ value, onChange, counts }: GoalFilterChipsProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Filter jenis target"
      className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0"
      data-testid="goals-filter-chips"
    >
      {CHIPS.map((chip) => {
        const active = chip.value === value;
        const count = counts?.[chip.value];
        return (
          <button
            key={chip.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(chip.value)}
            className={`${BASE_CHIP_CLASS} ${active ? ACTIVE_CHIP_CLASS : INACTIVE_CHIP_CLASS}`}
            data-value={chip.value}
          >
            <span>{chip.label}</span>
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