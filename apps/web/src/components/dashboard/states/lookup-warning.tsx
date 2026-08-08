"use client";

interface LookupWarningProps {
  /** Lookup surface that failed. Drives the heading + description copy. */
  kind: "categories" | "goals" | "debts";
  /** Optional message — the BE detail string when available. */
  message?: string | null;
  /** Retry callback fired when the user clicks "Coba lagi". */
  onRetry?: () => void;
}

const HEADING_BY_KIND: Record<LookupWarningProps["kind"], string> = {
  categories: "Kategori tidak dapat dimuat",
  goals: "Target tidak dapat dimuat",
  debts: "Utang tidak dapat dimuat",
};

const DESCRIPTION_BY_KIND: Record<LookupWarningProps["kind"], string> = {
  categories:
    "Bagian chart tampil dengan label \"Tanpa nama\". Coba muat ulang untuk mengembalikan label asli kategori.",
  goals:
    "Bagian Target & Dana Darurat tampil dengan nama kosong. Coba muat ulang untuk mengembalikan nama target.",
  debts:
    "Bagian Ringkasan Utang tampil dengan nama kosong. Coba muat ulang untuk mengembalikan nama utang.",
};

/**
 * Non-blocking warning banner for the dashboard (sub-0007-08).
 *
 * Mirrors the `<LookupWarning>` shape pinned on the goals list page
 * (sub-0005-03) — amber border, status role, retry button — so the
 * user sees the same family across the app. The warning is
 * intentionally non-blocking: the rest of the dashboard still renders
 * with the fallback label ("Tanpa nama") so the user isn't blocked
 * from anything else; this banner just explains WHY the fallback is
 * showing.
 *
 * The companion `<Toast>` component (sub-0007-08) provides the
 * transient side-channel notification when the lookup failure first
 * lands.
 */
export function LookupWarning({ kind, message, onRetry }: LookupWarningProps) {
  const heading = HEADING_BY_KIND[kind];
  const description = message ?? DESCRIPTION_BY_KIND[kind];
  return (
    <section
      className="card flex flex-col items-start gap-3 border-amber-200 bg-amber-50"
      role="status"
      aria-live="polite"
      data-warning-kind={kind}
      data-testid={`dashboard-lookup-warning-${kind}`}
    >
      <h3 className="text-sm font-semibold text-amber-900">{heading}</h3>
      <p className="text-sm leading-6 text-amber-800">{description}</p>
      {onRetry ? (
        <button
          type="button"
          className="btn-primary !w-auto px-4"
          onClick={onRetry}
        >
          Coba lagi
        </button>
      ) : null}
    </section>
  );
}