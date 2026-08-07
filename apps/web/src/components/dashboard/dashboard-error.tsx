"use client";

import { ActionIcon } from "@/components/shell/icons";

interface DashboardErrorProps {
  message: string | null;
  onRetry: () => void;
}

/**
 * Inline error card for the dashboard page (sub-0007-02). Mirrors the
 * `<MonthlyError>` styling from sub-0003-07 so the page reads as part
 * of the same family — red border, alert role, retry button. The
 * dashboard summary uses this card when any of the six underlying
 * fetches rejects (the page treats a partial failure as a full failure
 * so the user always sees a coherent state).
 */
export function DashboardError({ message, onRetry }: DashboardErrorProps) {
  const displayMessage =
    message ?? "Tidak bisa memuat dashboard. Coba lagi beberapa saat.";
  return (
    <section
      className="card flex flex-col items-start gap-3 border-red-200 bg-red-50"
      role="alert"
      aria-live="assertive"
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
