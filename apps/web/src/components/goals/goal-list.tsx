"use client";

import type { Account } from "@/lib/api/accounts";
import type { Goal, GoalKind } from "@/lib/api/goal-client";
import { GoalCard } from "@/components/goals/goal-card";

interface GoalListProps {
  goals: Goal[];
  accounts: Account[];
  total: number;
  /** True when the user has activated the "Semua" filter chip. */
  showAllKinds: boolean;
}

/**
 * EF rows sort before saving rows because the EF goal is treated as the
 * priority bucket (PRD §14 — emergency fund before discretionary
 * savings). Within each kind we fall back to the BE's deterministic
 * order (`start_date desc, created_at desc, id asc`) so the FE doesn't
 * reshuffle rows the user has already scrolled past.
 *
 * Exported for the unit test (sub-0005-03 AC) so the sort logic can be
 * pinned in isolation from the rendered list.
 */
export function sortGoalsForDisplay(goals: Goal[]): Goal[] {
  const kindOrder: Record<GoalKind, number> = {
    emergency_fund: 0,
    saving: 1,
  };
  return [...goals].sort((left, right) => {
    const kindDiff = kindOrder[left.kind] - kindOrder[right.kind];
    if (kindDiff !== 0) return kindDiff;
    // Same kind — defer to the BE order (which is itself deterministic).
    // The FE only needs to keep the kind grouping stable; we don't
    // re-sort within a kind.
    return 0;
  });
}

/**
 * Render the full list of goals for the page. The wrapper exists so
 * the page can focus on data orchestration (load + filter + URL sync)
 * while the layout lives here. The "Semua" chip is handled at the
 * page level via `?kind=`; this component is rendering-only.
 */
export function GoalList({ goals, accounts, total, showAllKinds }: GoalListProps) {
  const accountsById = new Map<string, Account>();
  for (const account of accounts) {
    accountsById.set(account.id, account);
  }
  const ordered = showAllKinds ? sortGoalsForDisplay(goals) : goals;

  return (
    <section
      className="mt-4 space-y-4"
      aria-label="Daftar target keuangan"
      data-testid="goals-list"
    >
      <p className="text-xs text-slate-500">
        Menampilkan {ordered.length} dari {total} target aktif
        {showAllKinds ? "" : " · sesuai filter jenis"}.
      </p>
      <ul className="grid list-none grid-cols-1 gap-3 p-0 sm:gap-4">
        {ordered.map((goal) => (
          <li key={goal.id} className="list-none">
            <GoalCard goal={goal} accountsById={accountsById} />
          </li>
        ))}
      </ul>
    </section>
  );
}