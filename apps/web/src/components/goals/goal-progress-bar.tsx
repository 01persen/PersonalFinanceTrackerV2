import type { GoalKind } from "@/lib/api/goals";

interface GoalProgressBarProps {
  /** Current amount in cents (null for unlinked goals with no stored value). */
  currentCents: number | null;
  /** Target amount in cents. Always > 0 (enforced by the BE schema). */
  targetCents: number;
  /** Goal kind — drives the bar color (saving = emerald, EF = sky). */
  kind: GoalKind;
  /** When true, render the "achieved" state (bar full, label "Tercapai"). */
  achieved?: boolean;
}

/**
 * Compute the displayed percentage as a clamped 0..100 integer. Mirrors
 * the backend `compute_goal_progress` clamp behaviour so the FE never
 * shows a percentage above 100 even when current > target (the BE
 * caps it to 100 and stamps `achieved_at` once).
 */
function computePercentage(
  currentCents: number | null,
  targetCents: number,
): number {
  const current = currentCents ?? 0;
  if (targetCents <= 0) return 0;
  const raw = (current / targetCents) * 100;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/**
 * Accessible progress bar (`role="progressbar"` + `aria-valuenow` /
 * `aria-valuemin` / `aria-valuemax`) for a single goal row. Colour
 * mirrors the category kind palette from sub-0004-04:
 *
 *   - `saving`         → emerald (positive / "nabung")
 *   - `emergency_fund` → sky (safety / "dana darurat")
 *
 * The visual width is rounded to a whole percent so the bar fills in
 * 1% steps; the numeric percentage is rendered beside the bar in the
 * parent card.
 */
export function GoalProgressBar({
  currentCents,
  targetCents,
  kind,
  achieved = false,
}: GoalProgressBarProps) {
  const percent = computePercentage(currentCents, targetCents);
  const displayPercent = achieved ? 100 : percent;
  const barColor =
    kind === "emergency_fund"
      ? "bg-sky-500"
      : "bg-emerald-500";
  const trackColor = achieved ? "bg-emerald-100" : "bg-slate-200";

  return (
    <div
      className={`relative h-2 w-full overflow-hidden rounded-full ${trackColor}`}
      role="progressbar"
      aria-label="Progress target"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={displayPercent}
      data-achieved={achieved ? "true" : "false"}
      data-kind={kind}
    >
      <div
        className={`h-full rounded-full transition-all duration-300 ${barColor}`}
        style={{ width: `${displayPercent}%` }}
      />
    </div>
  );
}

/**
 * Pure helper exported for the unit test (sub-0005-03 AC). Mirrors
 * the production `computePercentage` so the test can pin the rounding
 * + clamping behaviour without going through the DOM.
 */
export function computeGoalProgressPercentage(
  currentCents: number | null,
  targetCents: number,
): number {
  return computePercentage(currentCents, targetCents);
}