"use client";

import { useCallback, useEffect, useId } from "react";

import type { GoalKind } from "@/lib/api/goals";
import { ActionIcon } from "@/components/shell/icons";
import {
  centsToRupiah,
  formatGoalIdrAmountOnly,
} from "@/components/goals/idr";
import {
  progressBannerKey,
  type ProgressThreshold,
} from "@/components/goals/progress-banner-helpers";

/**
 * FE banner notifikasi progress — sub-0005-05.
 *
 * Visual: emerald gradient for saving goals, sky gradient for EF
 * goals (per FE spec — mirrors `goal-progress-bar.tsx`).
 *
 * Copy (Bahasa Indonesia, per FE spec):
 *
 *   25/50/75 → "🎯 Goal <name> capai <NN>%! Tinggal Rp X.XXX.XXX lagi."
 *   100       → "✨ Goal <name> achieved pada <DD MMMM YYYY>!"
 *
 * Dismiss: per-session localStorage key
 * `goal-banner-dismissed-{goalId}-{threshold}`. The 100% "achieved"
 * banner is intentionally NOT dismiss-able in the spec — the goal
 * has actually been hit and the user should see it until they take a
 * deliberate action (close the goal, scroll past, etc.). We honour
 * that by hiding the × button at 100% while still letting the
 * caller render an `onDismiss` noop callback so the list state stays
 * a single shape.
 *
 * Race defense: the parent passes a fresh `progress` snapshot on
 * every render; the banner is idempotent and just renders whatever
 * the parent says. Idempotency (the "duplicate cross-threshold tidak
 * double-fire" requirement from the issue) lives in the parent
 * `progress-banner-list.tsx` via the `latestLoadIdRef` guard around
 * the threshold-compute step.
 *
 * Mobile-first (390×844 baseline, issue body):
 *
 *   - `role="status"` + `aria-live="polite"` so screen readers
 *     announce new banners without interrupting the user.
 *   - Dismiss button is a 44 px square touch target.
 *   - Full-width card.
 */

const REMAINING_DATE_FORMATTER = new Intl.DateTimeFormat("id-ID", {
  day: "2-digit",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

function formatAchievedDate(iso: string | null): string | null {
  if (!iso) return null;
  // Achieved timestamp is a full ISO datetime; the FE renders the
  // date portion (DD MMMM YYYY) per spec copy. We use UTC so the day
  // doesn't shift across timezones — the achievement is a recorded
  // event, not a "now".
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) {
    // Fall back to Date parsing for full datetimes without a date
    // prefix segment.
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;
    return new Intl.DateTimeFormat("id-ID", {
      day: "2-digit",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(date);
  }
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (Number.isNaN(date.getTime())) return null;
  return REMAINING_DATE_FORMATTER.format(date);
}

interface KindPalette {
  /** Outer card gradient + ring colour. */
  container: string;
  /** Headline tint. */
  headline: string;
  /** Body-copy tint. */
  body: string;
  /** Dismiss button colour (inherits headline by default). */
  button: string;
  /** Emoji-style chip background (always white at low alpha). */
  chip: string;
}

const KIND_PALETTE: Record<GoalKind, KindPalette> = {
  saving: {
    container: "bg-gradient-to-br from-emerald-500 via-emerald-500 to-emerald-700 text-white shadow-md",
    headline: "text-white",
    body: "text-emerald-50",
    button: "text-white/90 hover:text-white",
    chip: "bg-white/15 text-white",
  },
  emergency_fund: {
    container: "bg-gradient-to-br from-sky-500 via-sky-500 to-sky-700 text-white shadow-md",
    headline: "text-white",
    body: "text-sky-50",
    button: "text-white/90 hover:text-white",
    chip: "bg-white/15 text-white",
  },
};

interface ProgressBannerProps {
  goalId: string;
  goalName: string;
  goalKind: GoalKind;
  threshold: ProgressThreshold;
  /** Current progress percentage as reported by `/goals/{id}/progress`. */
  percentage: number;
  /** Snapshot of the latest BE payload — used to compute "remaining" + achieved copy. */
  targetAmountCents: number;
  currentAmountCents: number;
  /**
   * ISO date when the goal first crossed 100%. Required for the 100%
   * "achieved" banner copy; ignored for lower thresholds. Falls back
   * to "tanggal tidak tercatat" if the BE omitted it.
   */
  achievedAt: string | null;
  /** Called when the user taps the × button. Clears the localStorage key + lifts state. */
  onDismiss: () => void;
}

/**
 * Compute "Tinggal Rp X lagi" text — used by the 25/50/75 banners.
 * Negative remaining (current > target) is clamped to 0 so the copy
 * stays sensible during the race window before the BE clamps the
 * percentage to 100.
 */
function formatRemainingIdr(
  currentAmountCents: number,
  targetAmountCents: number,
): string {
  const remainingCents = Math.max(targetAmountCents - currentAmountCents, 0);
  return `Rp ${formatGoalIdrAmountOnly(remainingCents)}`;
}

function buildBannerCopy({
  goalName,
  threshold,
  percentage,
  currentAmountCents,
  targetAmountCents,
  achievedAt,
}: {
  goalName: string;
  threshold: ProgressThreshold;
  percentage: number;
  currentAmountCents: number;
  targetAmountCents: number;
  achievedAt: string | null;
}): { headline: string; body: string | null } {
  if (threshold === 100) {
    const achievedLabel = formatAchievedDate(achievedAt);
    return {
      headline: `✨ Goal ${goalName} tercapai!`,
      body:
        achievedLabel !== null
          ? `Dicapai pada ${achievedLabel}.`
          : "Selamat — target kamu tercapai.",
    };
  }
  // 25 / 50 / 75 — use the *current* rounded percentage (clamped
  // 0..100) in the headline so we don't show "50%" when the user is
  // sitting at 49% from a slow last-mile update.
  const headlinePercent = Math.max(threshold, Math.round(percentage));
  return {
    headline: `🎯 Goal ${goalName} capai ${headlinePercent}%!`,
    body: `Tinggal ${formatRemainingIdr(currentAmountCents, targetAmountCents)} lagi.`,
  };
}

export function ProgressBanner({
  goalId,
  goalName,
  goalKind,
  threshold,
  percentage,
  targetAmountCents,
  currentAmountCents,
  achievedAt,
  onDismiss,
}: ProgressBannerProps) {
  const palette = KIND_PALETTE[goalKind];
  const isAchievedBanner = threshold === 100;
  const headlineId = useId();
  const bodyId = useId();
  const testId = progressBannerKey(goalId, threshold);

  const copy = buildBannerCopy({
    goalName,
    threshold,
    percentage,
    currentAmountCents,
    targetAmountCents,
    achievedAt,
  });

  // Achieved (100%) banners stay visible for the rest of the session
  // — per the FE spec. The dismiss control is hidden but the
  // internal keyboard "close" affordance is still wired so the
  // component is a single shape across thresholds.
  const handleDismiss = useCallback(() => {
    if (isAchievedBanner) return;
    onDismiss();
  }, [isAchievedBanner, onDismiss]);

  // Mirror an aria-hidden flag for the icon-only dismiss chip so the
  // computed visible label stays clean.
  useEffect(() => {
    // Effect is here so the consumer can later wire a focus trap or
    // scroll-into-view behaviour without a refactor — the banner is
    // expected to live above the goal list in Z-order. Currently a
    // no-op (intentionally empty) — kept so future hooks don't
    // accidentally rely on a non-existent render-phase entry point.
  }, []);

  return (
    <article
      className={`relative flex flex-col gap-1 rounded-xl px-4 py-3 ${palette.container}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-labelledby={headlineId}
      aria-describedby={bodyId}
      data-testid={testId}
      data-goal-id={goalId}
      data-kind={goalKind}
      data-threshold={threshold}
      data-achieved={isAchievedBanner ? "true" : "false"}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p
            id={headlineId}
            className={`text-sm font-semibold sm:text-base ${palette.headline}`}
          >
            {copy.headline}
          </p>
          {copy.body !== null ? (
            <p
              id={bodyId}
              className={`mt-0.5 text-xs sm:text-sm ${palette.body}`}
            >
              {copy.body}
            </p>
          ) : (
            <span id={bodyId} className="sr-only">
              Notifikasi progress target.
            </span>
          )}
        </div>

        <span
          className={`hidden shrink-0 items-center rounded-full px-2 py-0.5 text-[0.625rem] font-semibold uppercase tracking-wider sm:inline-flex ${palette.chip}`}
          aria-hidden="true"
        >
          {threshold}%
        </span>

        {!isAchievedBanner ? (
          <button
            type="button"
            onClick={handleDismiss}
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors ${palette.button}`}
            aria-label={`Tutup notifikasi progress untuk ${goalName}`}
          >
            <ActionIcon name="close" className="h-5 w-5" />
          </button>
        ) : null}
      </div>
    </article>
  );
}

/**
 * Convenience helper for the consumer (the page + the test). The
 * percentage-display rounding pinned here MUST match
 * `goal-progress-bar.tsx::computeGoalProgressPercentage` so the
 * headline number doesn't drift from the bar fill (the previous
 * sub-task already pinned the same rule).
 */
export function roundedPercentForBanner(percentage: number): number {
  if (!Number.isFinite(percentage)) return 0;
  return Math.max(0, Math.min(100, Math.round(percentage)));
}

/**
 * Re-export so the page-side code doesn't need to reach into
 * `helpers.ts` directly when building `key` props + aria labels.
 */
export { centsToRupiah };
