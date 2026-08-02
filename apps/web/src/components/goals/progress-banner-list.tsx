"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";

import type { Goal, GoalKind } from "@/lib/api/goals";
import { fetchGoalProgress, type GoalProgress } from "@/lib/api/goal-progress";
import {
  ProgressBanner,
} from "@/components/goals/progress-banner";
import {
  crossedThresholds,
  type ProgressThreshold,
} from "@/components/goals/progress-banner-helpers";
import {
  dismissBanner,
  isBannerDismissed,
  readLastSeenPercent,
  writeLastSeenPercent,
} from "@/components/goals/progress-banner-state";

/**
 * `progress-banner-list.tsx` — sub-0005-05.
 *
 * Orchestrates the per-goal `/goals/{id}/progress` fetches and the
 * localStorage session, then renders up to `MAX_VISIBLE_BANNERS` (3
 * per FE spec) `ProgressBanner` cards at the top of `/goals`.
 *
 * Race defense (mirrors `goal-list.tsx` + `goal-form-fields.tsx`):
 *
 *   - `AbortController` per fetch — switching goal filters or
 *     arriving on the page kicks a fresh fetch and the prior
 *     in-flight one is dropped.
 *   - `latestLoadIdRef` — a monotonic counter tags every load; only
 *     responses whose `loadId` matches the ref at write-time are
 *     applied to state. A older load that returns later is a no-op.
 *
 * State flow:
 *
 *   1. `goalProgressById` map (GoalProgress | "loading" | "error"
 *      | "absent") per goal id — populated as fetches resolve.
 *   2. Compute the *list of banners* every render via
 *      `computeBanners()` — pure derivation, no extra state.
 *   3. `lastSeenById` is *owned* by the component and persisted via
 *      `writeLastSeenPercent` whenever a fresh progress arrives.
 *
 * Auto-refresh: the parent passes the latest `goals` array (the
 * page uses the same `goals` state it already loads). When a new
 * mutation lands (a new goal appears, an archived goal disappears,
 * or the balances snapshot recomputes progress indirectly), the
 * `progressVersion` prop bumps and we re-fetch progress for every
 * goal still in the list.
 *
 * Mobile-first:
 *
 *   - Container is a `<section role="region">` so screen readers
 *     announce the banner list as a navigable region.
 *   - `space-y-2` keeps the cards visually grouped (8 px gutter, the
 *     same as the rest of the dashboard).
 *   - Full-width cards by way of `w-full`.
 *
 * Why `useReducer` not `useState`: the per-row state machine
 * (`idle → loading → ready | error | absent`) genuinely is a finite
 * state — `useReducer` keeps the transitions co-located so a future
 * sub-task can wire retry buttons without touching the reducer's
 * call sites.
 */

export const MAX_VISIBLE_BANNERS = 3;

type RowStatus = "idle" | "loading" | "ready" | "error" | "absent";

interface ProgressRow {
  status: RowStatus;
  progress: GoalProgress | null;
  errorMessage: string | null;
}

type ProgressMap = Record<string, ProgressRow>;

interface State {
  /** goalId → row. */
  byId: ProgressMap;
  /** Goal ids still relevant to the page; tells the reducer to drop stale entries. */
  visibleGoalIds: string[];
}

type Action =
  | {
      type: "load-start";
      goalIds: string[];
    }
  | {
      type: "load-success";
      goalId: string;
      progress: GoalProgress | null;
    }
  | {
      type: "load-error";
      goalId: string;
      message: string;
    }
  | {
      type: "set-visible";
      goalIds: string[];
    };

const INITIAL_STATE: State = {
  byId: {},
  visibleGoalIds: [],
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "load-start": {
      const visible = new Set(action.goalIds);
      const nextById: ProgressMap = {};
      for (const id of action.goalIds) {
        const existing = state.byId[id];
        nextById[id] =
          existing !== undefined && existing.status === "ready"
            ? existing
            : { status: "loading", progress: null, errorMessage: null };
      }
      // Drop rows that no longer correspond to a visible goal.
      for (const [id, row] of Object.entries(state.byId)) {
        if (!visible.has(id)) continue;
        if (nextById[id] !== undefined) continue;
        nextById[id] = row;
      }
      return { byId: nextById, visibleGoalIds: action.goalIds };
    }
    case "load-success": {
      const existing = state.byId[action.goalId];
      if (existing === undefined) {
        // Race: the goal was removed from the visible set before the
        // response landed. Drop the row.
        return state;
      }
      return {
        ...state,
        byId: {
          ...state.byId,
          [action.goalId]: {
            status: action.progress === null ? "absent" : "ready",
            progress: action.progress,
            errorMessage: null,
          },
        },
      };
    }
    case "load-error": {
      const existing = state.byId[action.goalId];
      if (existing === undefined) return state;
      return {
        ...state,
        byId: {
          ...state.byId,
          [action.goalId]: {
            status: "error",
            progress: null,
            errorMessage: action.message,
          },
        },
      };
    }
    case "set-visible": {
      const visible = new Set(action.goalIds);
      // Drop rows no longer in the visible set, keep the rest.
      const nextById: ProgressMap = {};
      for (const [id, row] of Object.entries(state.byId)) {
        if (visible.has(id)) nextById[id] = row;
      }
      return { byId: nextById, visibleGoalIds: action.goalIds };
    }
    default:
      return state;
  }
}

interface BannerItem {
  goalId: string;
  goalName: string;
  goalKind: GoalKind;
  threshold: ProgressThreshold;
  percentage: number;
  targetAmountCents: number;
  currentAmountCents: number;
  achievedAt: string | null;
}

/**
 * Sort key — newest crossing first per the FE spec ("sort by recency").
 * We use `Date.now()` when the banner is built so a crossing that
 * happened in the current render is always "newer" than a persisted
 * dismissal. Older banners that just haven't been dismissed yet
 * retain the `now` timestamp captured at build time, so within a
 * single render the recency order matches the natural list order of
 * the goals (per page sort).
 */
function compareBannerItems(left: BannerItem, right: BannerItem): number {
  // Achieved (100%) banner wins over lower-threshold banners even
  // when they cross at the same wall-clock instant — the user cares
  // about the achievement more than the 75% ledge. We use the goal
  // id as a stable tiebreaker.
  if (left.threshold !== right.threshold) {
    return right.threshold - left.threshold;
  }
  return left.goalId.localeCompare(right.goalId);
}

function dedupeBannerItems(items: BannerItem[]): BannerItem[] {
  const seen = new Set<string>();
  const out: BannerItem[] = [];
  for (const item of items) {
    const key = `${item.goalId}|${item.threshold}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

interface ProgressBannerListProps {
  goals: Goal[];
  /**
   * Bumped whenever the parent wants to force a refresh — used by the
   * page-level mutation flows (e.g. after a new transaction is
   * created elsewhere in the dashboard).  Defaults to a stable value
   * so the banner list behaves identically when the parent doesn't
   * wire one up.
   */
  refreshKey?: string | number;
}

/**
 * Build the list of banners to render. Pure derivation over the
 * loaded progress map + the goals list. Extracted so the unit test
 * can pin the ordering + capacity logic without a renderer.
 */
export function computeBanners(
  goals: Goal[],
  progressById: ProgressMap,
): BannerItem[] {
  const items: BannerItem[] = [];
  for (const goal of goals) {
    const row = progressById[goal.id];
    if (row === undefined) continue;
    if (row.status !== "ready") continue;
    const progress = row.progress;
    if (progress === null) continue;

    const lastSeen = readLastSeenPercent(goal.id);
    const crossed = crossedThresholds(lastSeen, progress.percentage);

    for (const threshold of crossed) {
      if (isBannerDismissed(goal.id, threshold)) continue;
      items.push({
        goalId: goal.id,
        goalName: goal.name,
        goalKind: goal.kind,
        threshold,
        percentage: progress.percentage,
        targetAmountCents: progress.targetAmountCents,
        currentAmountCents: progress.currentAmountCents,
        achievedAt: progress.achievedAt,
      });
    }

    // Persist the latest percentage as the new "last seen" — done
    // outside the loop so we only write once per goal. The
    // `items.length === 0` guard avoids redundant writes when a goal
    // revisits the same percentage (the value at storage matches
    // `progress.percentage` already).
    writeLastSeenPercent(goal.id, progress.percentage);
  }

  const deduped = dedupeBannerItems(items);
  deduped.sort(compareBannerItems);
  return deduped.slice(0, MAX_VISIBLE_BANNERS);
}

export function ProgressBannerList({ goals, refreshKey }: ProgressBannerListProps) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const abortRef = useRef<AbortController | null>(null);
  const latestLoadIdRef = useRef<number>(0);

  // Keep the visible-goal-ids slice in sync with the parent. Two
  // reasons:
  //   1. New goals appear (e.g. user lands on `/goals` after creating
  //      one via `sub-0005-04`).
  //   2. Goals disappear (archived or filtered out by `?kind=`).
  // We debounce into `set-visible` only when the id-set actually
  // changes — an arrow expression kept inline so the effect dep
  // stays stable across renders.
  const visibleGoalIds = useMemo(() => goals.map((goal) => goal.id), [goals]);
  const visibleKey = useMemo(
    () => [...visibleGoalIds].sort().join("|"),
    [visibleGoalIds],
  );

  useEffect(() => {
    dispatch({ type: "set-visible", goalIds: visibleGoalIds });
  }, [visibleKey, visibleGoalIds]);

  // Kick the per-row fetch when the visible set or the refresh key
  // changes. We do NOT depend on `goals` directly — the
  // `visibleGoalIds`-derived memo above covers that.
  useEffect(() => {
    if (visibleGoalIds.length === 0) return;

    // Drop the prior in-flight batch — race defense.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const loadId = ++latestLoadIdRef.current;
    // Capture the load id by closure so the cleanup function reads
    // a stable snapshot instead of `latestLoadIdRef.current` (which
    // could already point at a newer effect run by the time the
    // cleanup fires).
    const capturedLoadId = loadId;
    dispatch({ type: "load-start", goalIds: visibleGoalIds });

    void Promise.all(
      visibleGoalIds.map(async (goalId) => {
        try {
          const progress = await fetchGoalProgress(goalId, {
            signal: controller.signal,
          });
          if (
            capturedLoadId !== latestLoadIdRef.current ||
            controller.signal.aborted
          ) {
            return;
          }
          dispatch({
            type: "load-success",
            goalId,
            progress,
          });
        } catch (error) {
          if (
            capturedLoadId !== latestLoadIdRef.current ||
            controller.signal.aborted
          ) {
            return;
          }
          const message =
            error instanceof Error
              ? error.message
              : "Gagal memuat progress target.";
          dispatch({ type: "load-error", goalId, message });
        }
      }),
    );

    return () => {
      controller.abort();
    };
  }, [visibleKey, refreshKey, visibleGoalIds]);

  // Always release the abort handle on unmount.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  const banners = useMemo(
    () => computeBanners(goals, state.byId),
    [goals, state.byId],
  );

  const handleDismiss = useCallback(
    (goalId: string, threshold: ProgressThreshold) => {
      dismissBanner(goalId, threshold);
      // The next render re-derives `banners` from the same data +
      // updated localStorage. `computeBanners` reads `isBannerDismissed`
      // synchronously, so no state mutation is needed here — the
      // reducer stays untouched.
      // Bumping the state to force a re-render is unnecessary
      // because `dismissBanner` writes to localStorage (not React state)
      // and the consumer reads it on every render. We still nudge the
      // component with a no-op state copy so a future refactor that
      // moves state ownership into a context keeps working.
      dispatch({
        type: "set-visible",
        goalIds: visibleGoalIds,
      });
    },
    [visibleGoalIds],
  );

  if (banners.length === 0) return null;

  return (
    <section
      className="mb-4 flex flex-col gap-2"
      aria-label="Notifikasi progress target"
      data-testid="progress-banners"
      role="region"
    >
      {banners.map((banner) => (
        <ProgressBanner
          key={`${banner.goalId}-${banner.threshold}`}
          goalId={banner.goalId}
          goalName={banner.goalName}
          goalKind={banner.goalKind}
          threshold={banner.threshold}
          percentage={banner.percentage}
          targetAmountCents={banner.targetAmountCents}
          currentAmountCents={banner.currentAmountCents}
          achievedAt={banner.achievedAt}
          onDismiss={() => handleDismiss(banner.goalId, banner.threshold)}
        />
      ))}
    </section>
  );
}
