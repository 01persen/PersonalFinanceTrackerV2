"use client";

import Link from "next/link";

import { GoalProgressBar } from "@/components/goals/goal-progress-bar";
import { GOAL_KIND_LABEL } from "@/lib/api/goal-client";
import { formatIdrFromCents } from "@/lib/dashboard/idr";
import type { DashboardGoalProgress } from "@/lib/dashboard/types";

interface GoalProgressSectionProps {
  /**
   * Per-goal progress entries returned by `GET /dashboard/goals-progress`
   * (sub-0007-01 BE + `dashboard-client.ts` adapter). The widget is
   * purely presentational: the page owns the fetch + race-defense so
   * the widget never blocks the rest of the dashboard on a slow
   * goals endpoint.
   *
   * `null` means "the page has not loaded the endpoint yet" — the
   * widget renders a row of skeletons so the slot keeps its vertical
   * footprint while the user waits for the parallel bundle.
   */
  goals: DashboardGoalProgress[] | null;
}

/**
 * `true` when the user has no goals to show — drives the empty
 * state branching on the section. Exported for the unit test so the
 * "0 goals → empty CTA" rule can be pinned in isolation from React.
 */
export function isGoalsSectionEmpty(goals: DashboardGoalProgress[]): boolean {
  return goals.length === 0;
}

/**
 * Count goals whose `status` is `"achieved"`. Surfaced in the screen-
 * reader summary below the list ("3 tercapai dari 5 total") so the
 * user can hear the progress without scanning every bar. Exported
 * for the unit test.
 */
export function countAchievedGoals(goals: DashboardGoalProgress[]): number {
  let count = 0;
  for (const goal of goals) {
    if (goal.status === "achieved") count += 1;
  }
  return count;
}

/**
 * Build the count-badge label that sits next to the section heading.
 * Mirrors the language used by the goals list page (sub-0005-03) so
 * the dashboard surfaces the same vocabulary: "N target" when there
 * are some goals, "Kosong" when there are none.
 */
export function goalsCountBadgeLabel(goals: DashboardGoalProgress[]): string {
  if (goals.length === 0) return "Kosong";
  return `${goals.length} target`;
}

/**
 * Dashboard widget that surfaces the per-goal progress bar stack
 * (sub-0007-06). Mirrors the goals list card chrome from sub-0005-03
 * (heading + count badge + accessible region) but stays narrow — the
 * dashboard row pairs this widget with `<DebtSummarySection>` so each
 * card is bounded to a 6/12 column.
 *
 * Reuses `<GoalProgressBar>` from sub-0005-03 — never re-implements
 * the bar — so the colour palette (emerald for saving, sky for EF)
 * stays identical between the goals list page and the dashboard.
 * Currency formatting goes through `formatIdrFromCents` (sub-0007-02)
 * so the "Rp X / Rp Y" labels read consistently with the KPI cards
 * and the networth chart.
 *
 * Empty state mirrors `<GoalsEmptyState>` (sub-0005-03 / sub-0007-08
 * family): when the user has no goals the section collapses to a
 * single CTA that links to `/goals/new` so the user can land on the
 * creation flow without bouncing off the dashboard.
 */
export function GoalProgressSection({ goals }: GoalProgressSectionProps) {
  if (goals === null) {
    return <GoalProgressSectionSkeleton />;
  }

  if (isGoalsSectionEmpty(goals)) {
    return <GoalProgressEmptyState />;
  }

  const achievedCount = countAchievedGoals(goals);
  const badgeLabel = goalsCountBadgeLabel(goals);

  return (
    <section
      className="card flex h-full flex-col"
      role="region"
      aria-label="Target & Dana Darurat"
      data-testid="dashboard-goals-progress"
      data-empty="false"
      data-count={goals.length}
    >
      <header className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-900">
            Target &amp; Dana Darurat
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            Tabungan &amp; dana darurat aktif
          </p>
        </div>
        <span
          className="rounded-full bg-slate-100 px-2.5 py-1 text-[0.65rem] font-semibold uppercase tracking-wide text-slate-500"
          data-testid="dashboard-goals-progress-count"
        >
          {badgeLabel}
        </span>
      </header>
      <ul className="mt-4 grid list-none grid-cols-1 gap-4 p-0">
        {goals.map((goal) => (
          <li key={goal.goalId} className="list-none">
            <GoalProgressRow goal={goal} />
          </li>
        ))}
      </ul>
      <p className="sr-only">
        {goals.length} target terdaftar, {achievedCount} tercapai.
      </p>
    </section>
  );
}

interface GoalProgressRowProps {
  goal: DashboardGoalProgress;
}

function GoalProgressRow({ goal }: GoalProgressRowProps) {
  const achieved = goal.status === "achieved";
  const currentRupiah = formatIdrFromCents(goal.currentCents);
  const targetRupiah = formatIdrFromCents(goal.targetCents);

  return (
    <article
      className="flex flex-col gap-2 rounded-xl border border-slate-100 bg-white p-3"
      data-goal-id={goal.goalId}
      data-kind={goal.kind}
      data-status={goal.status}
      aria-label={`Target ${goal.name}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p
            className="truncate text-sm font-semibold text-slate-900"
            title={goal.name}
          >
            {goal.name}
          </p>
          <p className="mt-0.5 text-[0.7rem] uppercase tracking-[0.12em] text-slate-500">
            {GOAL_KIND_LABEL[goal.kind]}
          </p>
        </div>
        {achieved ? (
          <span className="inline-flex shrink-0 items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-emerald-700">
            Tercapai
          </span>
        ) : null}
      </div>
      <GoalProgressBar
        currentCents={goal.currentCents}
        targetCents={goal.targetCents}
        kind={goal.kind}
        achieved={achieved}
      />
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="tabular-nums text-slate-600">
          <span className="font-semibold text-slate-900">{currentRupiah}</span>
          {" / "}
          {targetRupiah}
        </span>
        <span className="font-semibold tabular-nums text-slate-700">
          {Math.round(goal.pct)}%
        </span>
      </div>
    </article>
  );
}

function GoalProgressEmptyState() {
  return (
    <section
      className="card flex h-full flex-col items-center justify-center gap-3 py-8 text-center"
      role="region"
      aria-label="Target & Dana Darurat"
      data-testid="dashboard-goals-progress"
      data-empty="true"
    >
      <h3 className="text-base font-semibold text-slate-900">
        Belum ada target. Mulai dengan menentukan goal pertama kamu.
      </h3>
      <p className="max-w-sm text-xs leading-5 text-slate-500">
        Buat target tabungan atau dana darurat agar progresnya bisa
        dipantau dari dasbor.
      </p>
      <Link
        href="/goals/new"
        className="btn-primary !w-auto px-4 py-1.5 text-xs"
        aria-label="Buat target pertama"
        data-testid="dashboard-goals-progress-cta"
      >
        Buat target pertama
      </Link>
    </section>
  );
}

function GoalProgressSectionSkeleton() {
  return (
    <section
      className="card flex h-full flex-col"
      role="region"
      aria-label="Target & Dana Darurat"
      aria-busy="true"
      aria-live="polite"
      data-testid="dashboard-goals-progress"
      data-loading="true"
    >
      <header className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-900">
            Target &amp; Dana Darurat
          </h3>
          <p className="mt-1 text-xs text-slate-500">Memuat progres…</p>
        </div>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[0.65rem] font-semibold uppercase tracking-wide text-slate-500">
          Memuat
        </span>
      </header>
      <ul className="mt-4 grid list-none grid-cols-1 gap-4 p-0">
        {[0, 1, 2].map((row) => (
          <li key={`goal-skeleton-${row}`} className="list-none">
            <div className="flex flex-col gap-2 rounded-xl border border-slate-100 bg-white p-3">
              <div className="h-4 w-32 animate-pulse rounded bg-slate-200" />
              <div className="h-2 w-full animate-pulse rounded-full bg-slate-100" />
              <div className="flex items-baseline justify-between gap-2">
                <div className="h-3 w-24 animate-pulse rounded bg-slate-100" />
                <div className="h-3 w-10 animate-pulse rounded bg-slate-100" />
              </div>
            </div>
          </li>
        ))}
      </ul>
      <span className="sr-only">Memuat progres target…</span>
    </section>
  );
}
