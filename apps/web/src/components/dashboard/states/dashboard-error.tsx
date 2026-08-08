"use client";

import { ActionIcon } from "@/components/shell/icons";

interface DashboardErrorProps {
  /** Error message to display. Falls back to a generic Indonesian string when `null`. */
  message: string | null;
  /** Retry callback fired when the user clicks the "Coba lagi" button. */
  onRetry: () => void;
}

/**
 * Error state for the dashboard page (sub-0007-08). Mirrors the
 * `<GoalsError>` (sub-0005-03) and `<MonthlyError>` (sub-0003-07)
 * patterns — red border, alert role, retry button — so the page reads
 * as part of the same family. `role="alert"` + `aria-live="assertive"`
 * makes the failure immediately discoverable to assistive tech.
 *
 * Pure presentational — `onRetry` is wired by the parent (typically
 * `dashboard-content.tsx`'s `handleRetry` that re-invokes `load()`
 * with a fresh `loadId` via `latestLoadIdRef`, sub-0007-02).
 */
export function DashboardError({ message, onRetry }: DashboardErrorProps) {
  const displayMessage =
    message ?? "Tidak bisa memuat dashboard. Coba lagi beberapa saat.";
  return (
    <section
      className="card flex flex-col items-start gap-3 border-red-200 bg-red-50"
      role="alert"
      aria-live="assertive"
      data-testid="dashboard-error"
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100 text-red-700">
        <ActionIcon name="close" className="h-5 w-5" />
      </div>
      <h3 className="text-base font-semibold text-red-900">
        Gagal memuat dashboard
      </h3>
      <p className="text-sm leading-6 text-red-800">{displayMessage}</p>
      <button
        type="button"
        className="btn-primary !w-auto px-4"
        onClick={onRetry}
      >
        Coba lagi
      </button>
    </section>
  );
}