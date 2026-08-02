/**
 * `GET /goals/{id}/progress` — wire shape + adapter for the banner.
 *
 * sub-0005-05 (FE banner) calls this endpoint once per goal in
 * `/goals` so the banner list can decide which thresholds each goal
 * just crossed. The backend response comes from
 * `apps/api/src/app/services/goal_engine.py::compute_goal_progress`
 * (sub-0005-02) so the FE never has to re-implement the
 * linked-account / unlinked semantics.
 *
 * Wire shape (verbatim from `GoalProgressPublic` in
 * `apps/api/src/app/api/schemas.py`):
 *
 *   {
 *     "goal_id": "<uuid>",
 *     "kind":    "saving" | "emergency_fund",
 *     "current_amount_cents": <int>,
 *     "target_amount_cents":  <int>,
 *     "percentage":           <float>,    // 0..100, BE clamps to 100
 *     "achieved_at":          "<iso>" | null,
 *     "tabungan_bulanan_cents":<int> | null,
 *     "lama_mengumpulkan_bulan":<int> | null
 *   }
 *
 * The adapter tolerates `currentAmountCents: null` (an unlinked goal
 * with no stored value) by coercing it to `0` so the banner never
 * renders against a NaN percentage.
 */

import { ApiError, apiRequest } from "@/lib/api/client";
import type { GoalKind } from "@/lib/api/goals";

export interface GoalProgress {
  goalId: string;
  kind: GoalKind;
  currentAmountCents: number;
  targetAmountCents: number;
  percentage: number;
  achievedAt: string | null;
  tabunganBulananCents: number | null;
  lamaMengumpulkanBulan: number | null;
}

interface RawGoalProgressPayload {
  goal_id?: unknown;
  kind?: unknown;
  current_amount_cents?: unknown;
  target_amount_cents?: unknown;
  percentage?: unknown;
  achieved_at?: unknown;
  tabungan_bulanan_cents?: unknown;
  lama_mengumpulkan_bulan?: unknown;
}

function toFiniteInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function toFiniteFloat(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function toNullableInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toNullableIsoString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function adaptGoalProgress(raw: unknown): GoalProgress | null {
  if (!raw || typeof raw !== "object") return null;
  const payload = raw as RawGoalProgressPayload;

  if (typeof payload.goal_id !== "string" || payload.goal_id.length === 0) {
    return null;
  }
  if (payload.kind !== "saving" && payload.kind !== "emergency_fund") {
    return null;
  }

  return {
    goalId: payload.goal_id,
    kind: payload.kind,
    currentAmountCents: toFiniteInt(payload.current_amount_cents, 0),
    targetAmountCents: toFiniteInt(payload.target_amount_cents, 0),
    percentage: clampPercentage(toFiniteFloat(payload.percentage, 0)),
    achievedAt: toNullableIsoString(payload.achieved_at),
    tabunganBulananCents: toNullableInt(payload.tabungan_bulanan_cents),
    lamaMengumpulkanBulan: toNullableInt(payload.lama_mengumpulkan_bulan),
  };
}

/**
 * Fetch a single goal's progress snapshot. Mirrors the rest of the
 * client side (`fetchGoals`, `fetchAccounts`, …) — accepts an
 * `AbortSignal` so a newer fetch can drop the prior response
 * mid-flight without flicker.
 *
 * Returns `null` when the payload is unrecognised (defensive — the
 * banner surfaces this as "skip rendering" rather than crashing).
 * A 404 (goal not found / archived / not the caller's) is surfaced
 * as `null` too — the goal has been deleted under our feet, the
 * banner just drops it.
 */
export async function fetchGoalProgress(
  goalId: string,
  options: { signal?: AbortSignal } = {},
): Promise<GoalProgress | null> {
  try {
    const raw = await apiRequest<unknown>(
      `/goals/${encodeURIComponent(goalId)}/progress`,
      { signal: options.signal },
    );
    return adaptGoalProgress(raw);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}
