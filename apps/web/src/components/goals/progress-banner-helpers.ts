/**
 * Progress banner threshold helpers (sub-0005-05 — FE banner notifikasi
 * progress). Pure functions only — no React, no DOM, no localStorage.
 *
 * The banner triggers when a goal's progress percentage crosses one of
 * the documented thresholds for the first time since the FE last saw
 * the value. The crossing logic is intentionally tiny so the unit
 * test in `__tests__/progress-banner.test.tsx` can pin every branch
 * without a renderer.
 *
 * Threshold ladder (per the FE spec — issue body sub-0005-05):
 *
 *   25% — first milestone
 *   50% — halfway
 *   75% — three-quarters
 *   100% — achieved (this is the "achieved" state UI, persistent &
 *          special-cased)
 *
 * Achieved banners never participate in the standard ladder — they
 * live on the goal card itself (sub-0005-03 `GoalCard`) and the banner
 * only shows a one-shot "Goal achieved on <date>" call-out at the
 * 100% crossing. See `buildBannerState` in
 * `progress-banner.tsx` for the consumer.
 *
 * Edge cases pinned by the helpers below (pinned by the unit test):
 *
 *   - `prev` is `null` → first time we observe the goal. We treat
 *     this as "0% seen" and only fire thresholds ABOVE 0 so a brand
 *     new saving goal at 5% never explodes into "you hit 25%!" spam
 *     on first render. The user must actually move past 25% before
 *     the banner shows.
 *   - `curr` may be above 100 (linked account saldo > target) — the
 *     BE clamps to 100 via `min(100, current/target*100)`, but the
 *     helper stays defensive and accepts any number, returning all
 *     thresholds whose value is `<= curr`.
 *   - Crossing is detected by `curr >= threshold && prev < threshold`
 *     so the same render is not reported twice for the same state.
 *   - `prev < 0` or `curr < 0` are defensive-zeroed so a stale
 *     localStorage value (e.g. "last seen 47%" got cleaned up to "")
 *     cannot crash the ladder.
 */

export const PROGRESS_THRESHOLDS = [25, 50, 75, 100] as const;
export type ProgressThreshold = (typeof PROGRESS_THRESHOLDS)[number];

/**
 * Lowest threshold we ever fire. Exposed so the page can decide how
 * many banners to surface (max 3 — issue body) without re-listing
 * the array in another file.
 */
export const LOWEST_PROGRESS_THRESHOLD: ProgressThreshold = PROGRESS_THRESHOLDS[0];

/**
 * Highest threshold. Above this (101+) is clamped to 100 by the BE,
 * but the helper stays defensive in case a future endpoint lets it
 * through.
 */
export const HIGHEST_PROGRESS_THRESHOLD: ProgressThreshold =
  PROGRESS_THRESHOLDS[PROGRESS_THRESHOLDS.length - 1];

function sanitize(value: number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value;
}

/**
 * Highest threshold at or below `percentage`. `0` when the percentage
 * hasn't crossed any threshold yet. Useful when callers want a
 * single-number "where is the user on the ladder" snapshot rather
 * than the full list.
 *
 *   highestThresholdReached( 0)  → null
 *   highestThresholdReached(24)  → null
 *   highestThresholdReached(25)  → 25
 *   highestThresholdReached(80)  → 75
 *   highestThresholdReached(100) → 100
 */
export function highestThresholdReached(
  percentage: number,
): ProgressThreshold | null {
  const safe = sanitize(percentage);
  let result: ProgressThreshold | null = null;
  for (const t of PROGRESS_THRESHOLDS) {
    if (safe >= t) result = t;
  }
  return result;
}

/**
 * Pure predicate — true iff `curr` just crossed `threshold` relative
 * to `prev`.
 *
 *   hasCrossedThreshold(null, 25)  // true — first observation past 25
 *   hasCrossedThreshold(null, 100) // true — first observation past 100
 *   hasCrossedThreshold(0,   25)  // true
 *   hasCrossedThreshold(25,  25)  // false — no new crossing
 *   hasCrossedThreshold(24,  25)  // true — just crossed
 *   hasCrossedThreshold(75,  100) // true
 *   hasCrossedThreshold(100, 90)  // false — never goes backwards
 *
 * Designed to be called per-threshold from the consumer so the page
 * can build a `<ProgressBanner>` per crossed threshold — or once per
 * call to `crossedThresholds()` to fan out into the banner list.
 */
export function hasCrossedThreshold(
  prev: number | null | undefined,
  curr: number,
  threshold: ProgressThreshold,
): boolean {
  const safePrev = sanitize(prev);
  const safeCurr = sanitize(curr);
  return safeCurr >= threshold && safePrev < threshold;
}

/**
 * Return every threshold the latest `curr` value crossed since the
 * last-seen `prev`. Multi-threshold jumps return multiple values
 * (ascending), which the banner consumer fans out into one banner
 * per threshold (issue body: max 3 visible at a time, so the caller
 * trims).
 *
 *   crossedThresholds(0, 80) → [25, 50, 75]
 *   crossedThresholds(80, 100) → [100]
 *   crossedThresholds(50, 50) → []
 *   crossedThresholds(null, 100) → [25, 50, 75, 100]
 *   crossedThresholds(null, 5)  → []   // never had 25% yet
 */
export function crossedThresholds(
  prev: number | null | undefined,
  curr: number,
): ProgressThreshold[] {
  const out: ProgressThreshold[] = [];
  for (const t of PROGRESS_THRESHOLDS) {
    if (hasCrossedThreshold(prev, curr, t)) out.push(t);
  }
  return out;
}

/**
 * Stable id used for `data-testid` + `key` props on the banner list.
 * Format: `progress-banner-{goalId}-{threshold}`. Centralised so the
 * test and the component agree on the same string.
 */
export function progressBannerKey(
  goalId: string,
  threshold: ProgressThreshold,
): string {
  return `progress-banner-${goalId}-${threshold}`;
}
