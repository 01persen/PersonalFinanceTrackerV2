"use client";

import type { Account, AccountBalance } from "@/lib/api/accounts";
import { GOAL_KIND_LABEL, type Goal, type GoalKind } from "@/lib/api/goal-client";
import { GoalProgressBar } from "@/components/goals/goal-progress-bar";
import {
  centsToRupiah,
  formatGoalIdrAmountOnly,
} from "@/components/goals/idr";

interface GoalCardProps {
  goal: Goal;
  /** Lookup map so the linked account name resolves without a second fetch. */
  accountsById: Map<string, Account>;
  /**
   * Lookup map for live account saldo (`balanceCents` per
   * `apps/api/src/app/api/v1/accounts.py` balance endpoint). When a
   * goal has `linkedAccountId` set, the live saldo drives the
   * progress display — this mirrors the BE progress engine in
   * sub-0005-02 so a freshly-created saving goal whose persisted
   * `current_amount_cents` is still 0 doesn't render at 0% before
   * the recompute hook runs. When the lookup is empty (e.g. the
   * balances endpoint hasn't been fetched yet) the card falls back
   * to the persisted `currentAmountCents`.
   */
  balanceByAccountId: Map<string, AccountBalance>;
}

const KIND_BADGE_STYLES: Record<
  GoalKind,
  { badge: string; barColor: string }
> = {
  saving: {
    badge: "bg-emerald-100 text-emerald-800",
    barColor: "emerald",
  },
  emergency_fund: {
    badge: "bg-sky-100 text-sky-800",
    barColor: "sky",
  },
};

const ACCOUNT_INITIAL_FALLBACK = "A";

const DATE_FORMATTER = new Intl.DateTimeFormat("id-ID", {
  day: "2-digit",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

function formatIsoDate(value: string): string {
  // Parse `YYYY-MM-DD` as a UTC calendar date so timezone drift doesn't
  // shift the day. Returns the raw input when the parse fails so the
  // card still renders something readable.
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return value;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (Number.isNaN(date.getTime())) return value;
  return DATE_FORMATTER.format(date);
}

function formatTimestamp(value: string): string {
  // Parses an ISO datetime. Used for `achieved_at` which comes back as
  // a full timestamp (not just a date).
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(date);
}

/**
 * Resolve the displayed ``currentCents`` for a goal.
 *
 * For linked goals (`linkedAccountId` set), the live saldo from the
 * balances snapshot wins — same source-of-truth as the BE progress
 * engine (`compute_goal_progress` in sub-0005-02). The persisted
 * ``current_amount_cents`` is only used when the goal is unlinked
 * (no live source to read from) or when the balances lookup doesn't
 * cover the linked account yet (stale lookup or the linked account
 * was archived after the snapshot).
 */
function resolveCurrentCents(
  goal: Goal,
  balanceByAccountId: Map<string, AccountBalance>,
): number {
  if (goal.linkedAccountId) {
    const live = balanceByAccountId.get(goal.linkedAccountId);
    if (live && typeof live.balanceCents === "number") {
      return live.balanceCents;
    }
  }
  return goal.currentAmountCents ?? 0;
}

/**
 * Single goal card — used in the goals list page (sub-0005-03). The
 * card surfaces:
 *
 *   - Goal name + kind badge (color matches `sub-0004-04` category kind
 *     palette: emerald for saving, sky for EF).
 *   - Linked account name + initial (when set).
 *   - Numeric progress `Rp X / Rp Y (NN%)` — `IDR locale`, no decimals
 *     per the IDR convention (sub-0003-05 baseline).
 *   - Progress bar (`GoalProgressBar` — accessible via
 *     `role="progressbar"`).
 *   - Achieved banner when `achieved_at` is set: replaces the percentage
 *     with `Tercapai · DD MMMM YYYY`.
 *
 * Mobile-first: tap area ≥ 44 px on the wrapper, full-width on the
 * 390 px baseline.
 */
export function GoalCard({ goal, accountsById, balanceByAccountId }: GoalCardProps) {
  const styles = KIND_BADGE_STYLES[goal.kind];
  const linkedAccount = goal.linkedAccountId
    ? accountsById.get(goal.linkedAccountId)
    : null;
  const achieved = goal.achievedAt !== null;
  const currentCents = resolveCurrentCents(goal, balanceByAccountId);
  const targetRupiah = centsToRupiah(goal.targetAmountCents);
  const currentRupiah = centsToRupiah(currentCents);
  const hasLinkedAccount = linkedAccount !== null && linkedAccount !== undefined;
  const displayedPercent = Math.round(
    (currentCents / Math.max(goal.targetAmountCents, 1)) * 100,
  );

  return (
    <article
      className="card flex min-h-[11rem] flex-col gap-3"
      data-goal-id={goal.id}
      data-kind={goal.kind}
      data-achieved={achieved ? "true" : "false"}
      aria-label={`Target ${goal.name}`}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold text-slate-900" title={goal.name}>
            {goal.name}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Mulai {formatIsoDate(goal.startDate)}
            {goal.targetDate ? ` · Target ${formatIsoDate(goal.targetDate)}` : ""}
          </p>
        </div>
        <span
          className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-xs font-semibold ${styles.badge}`}
        >
          {GOAL_KIND_LABEL[goal.kind]}
        </span>
      </header>

      {hasLinkedAccount && linkedAccount ? (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[0.625rem] font-bold text-slate-600"
            aria-hidden="true"
          >
            {(linkedAccount.name.charAt(0) || ACCOUNT_INITIAL_FALLBACK).toUpperCase()}
          </span>
          <span className="truncate" title={linkedAccount.name}>
            {linkedAccount.name}
          </span>
        </div>
      ) : null}

      <div className="mt-1 flex flex-col gap-1.5">
        <GoalProgressBar
          currentCents={currentCents}
          targetCents={goal.targetAmountCents}
          kind={goal.kind}
          achieved={achieved}
        />
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <span className="tabular-nums text-slate-600">
            <span className="font-semibold text-slate-900">
              Rp {formatGoalIdrAmountOnly(currentCents)}
            </span>
            {" / "}
            Rp {formatGoalIdrAmountOnly(goal.targetAmountCents)}
          </span>
          {achieved ? (
            <span className="font-semibold text-emerald-700">
              Tercapai · {formatTimestamp(goal.achievedAt ?? "")}
            </span>
          ) : (
            <span className="font-semibold tabular-nums text-slate-700">
              {displayedPercent}%
            </span>
          )}
        </div>
        <p className="sr-only">
          Target {goal.name}: Rp {currentRupiah.toLocaleString("id-ID")} dari Rp{" "}
          {targetRupiah.toLocaleString("id-ID")}{" "}
          ({achieved ? "tercapai" : "belum tercapai"}).
        </p>
      </div>
    </article>
  );
}