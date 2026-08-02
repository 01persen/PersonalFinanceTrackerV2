"use client";

import type { Account, AccountBalance } from "@/lib/api/accounts";
import type { Goal, GoalKind } from "@/lib/api/goal-client";
import { GoalCard } from "@/components/goals/goal-card";

interface GoalListProps {
  goals: Goal[];
  accounts: Account[];
  balances: AccountBalance[];
  total: number;
  /** True when the user has activated the "Semua" filter chip. */
  showAllKinds: boolean;
}

/**
 * EF rows sort before saving rows because the EF goal is treated as the
 * priority bucket (PRD §14 — emergency fund before discretionary
 * savings). Within each kind we sort by ``createdAt`` descending — the
 * FE spec (issue body, sub-0005-03) explicitly asks for
 * ``saving by created_at desc`` so the most recent goals float to the
 * top of the saving bucket. EF inherits the same tiebreaker for
 * stability so the user doesn't see EF rows jump around when they
 * land on the page.
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
    // Same kind — newest first. ``Date.parse`` keeps the comparison
    // total-ordered even when the input is malformed (returns NaN on
    // parse failure, but both sides either parse or both don't — we
    // fall back to ``id`` as the final tiebreaker for determinism).
    const leftCreated = Date.parse(left.createdAt);
    const rightCreated = Date.parse(right.createdAt);
    const leftTime = Number.isFinite(leftCreated) ? leftCreated : 0;
    const rightTime = Number.isFinite(rightCreated) ? rightCreated : 0;
    const timeDiff = rightTime - leftTime;
    if (timeDiff !== 0) return timeDiff;
    return left.id.localeCompare(right.id);
  });
}

/**
 * Render the full list of goals for the page. The wrapper exists so
 * the page can focus on data orchestration (load + filter + URL sync)
 * while the layout lives here. The "Semua" chip is handled at the
 * page level via `?kind=`; this component is rendering-only.
 *
 * ``balances`` is optional — when supplied, linked goals show the
 * live saldo (mirror of sub-0005-02's progress engine) so a freshly
 * created saving goal with a linked account doesn't render at 0%
 * until the persisted ``current_amount_cents`` is updated by the
 * recompute hook. Without balances, the card falls back to the
 * persisted ``currentAmountCents``.
 */
export function GoalList({
  goals,
  accounts,
  balances,
  total,
  showAllKinds,
}: GoalListProps) {
  const accountsById = new Map<string, Account>();
  for (const account of accounts) {
    accountsById.set(account.id, account);
  }
  const balanceByAccountId = new Map<string, AccountBalance>();
  for (const balance of balances) {
    balanceByAccountId.set(balance.accountId, balance);
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
            <GoalCard
              goal={goal}
              accountsById={accountsById}
              balanceByAccountId={balanceByAccountId}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}