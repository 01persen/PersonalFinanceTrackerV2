/**
 * localStorage helpers for the progress banner (sub-0005-05).
 *
 * Two prefixes are owned by this module:
 *
 *   - `goal-progress-lastseen-{goalId}` → number percentage (string in
 *     localStorage). Persists across reloads so the same threshold
 *     crossing doesn't re-fire when the user navigates
 *     `/goals` → detail → back.
 *   - `goal-banner-dismissed-{goalId}-{threshold}` → `"1"`. Tracks
 *     per-session dismissals; explicit `clearBannerSession()` clears
 *     every matching key (logout hook calls this).
 *
 * Both helpers are SSR-safe — they no-op when `window` is undefined.
 * Nothing here reads or writes React state; the consumer owns the
 * React-side reducers and is responsible for the dependency array on
 * `useEffect` (`useCallback` won't save you if the function is the
 * same shape — React still re-runs `useEffect` when the dep
 * identity changes).
 */

import type { ProgressThreshold } from "@/components/goals/progress-banner-helpers";

export const PROGRESS_LAST_SEEN_PREFIX = "goal-progress-lastseen-";
export const PROGRESS_BANNER_DISMISSED_PREFIX = "goal-banner-dismissed-";

function isClient(): boolean {
  return typeof window !== "undefined";
}

function lastSeenKey(goalId: string): string {
  return `${PROGRESS_LAST_SEEN_PREFIX}${goalId}`;
}

function dismissedKey(goalId: string, threshold: ProgressThreshold): string {
  return `${PROGRESS_BANNER_DISMISSED_PREFIX}${goalId}-${threshold}`;
}

/**
 * Read the last-seen percentage for a goal. Returns `null` when no
 * record exists or the stored payload is unparseable (stale data
 * from a future migration, user wiped storage, etc.). The caller
 * treats `null` as "first observation" so the threshold ladder never
 * downgrades to a negative baseline.
 */
export function readLastSeenPercent(goalId: string): number | null {
  if (!isClient()) return null;
  const raw = window.localStorage.getItem(lastSeenKey(goalId));
  if (raw === null || raw.length === 0) return null;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < 0) return null;
  return parsed > 100 ? 100 : parsed;
}

/**
 * Persist the *new* last-seen percentage for a goal. Clamps to
 * 0..100 so a future BE that returns 100.0001 cannot leak a >100
 * percentage into the next ladder computation.
 */
export function writeLastSeenPercent(goalId: string, percentage: number): void {
  if (!isClient()) return;
  const clamped = Math.max(0, Math.min(100, percentage));
  window.localStorage.setItem(lastSeenKey(goalId), clamped.toString());
}

/**
 * True when the user has dismissed the banner for this exact
 * (goalId, threshold) pair during the current session. Reads from
 * localStorage so a hard reload still respects the dismissal — the
 * session reset only fires on logout via `clearBannerSession`.
 */
export function isBannerDismissed(
  goalId: string,
  threshold: ProgressThreshold,
): boolean {
  if (!isClient()) return false;
  return window.localStorage.getItem(dismissedKey(goalId, threshold)) === "1";
}

/**
 * Mark a banner as dismissed. Idempotent.
 */
export function dismissBanner(
  goalId: string,
  threshold: ProgressThreshold,
): void {
  if (!isClient()) return;
  window.localStorage.setItem(dismissedKey(goalId, threshold), "1");
}

/**
 * Clear every banner-related localStorage key. Wired into
 * `auth-context.tsx::logout` (via the page-level effect) so a
 * logout (or a user with two tabs open) doesn't leak a session-A
 * dismissal into session B.
 *
 * Implementation note: we walk `localStorage.key(i)` rather than the
 * keys themselves — the browser API doesn't expose a prefix scan
 * primitive, and the prefix list is short (only two prefixes), so an
 * O(n) scan is fine.
 */
export function clearBannerSession(): void {
  if (!isClient()) return;
  const storage = window.localStorage;
  const prefixes = [PROGRESS_LAST_SEEN_PREFIX, PROGRESS_BANNER_DISMISSED_PREFIX];
  // Collect first, mutate second — removing keys while iterating
  // would shift the index and skip entries.
  const toRemove: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key === null) continue;
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      toRemove.push(key);
    }
  }
  for (const key of toRemove) {
    storage.removeItem(key);
  }
}
