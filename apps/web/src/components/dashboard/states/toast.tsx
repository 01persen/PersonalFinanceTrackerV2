"use client";

interface ToastProps {
  /**
   * Message body to surface. Accepts plain text or a ReactNode when
   * the parent wants to embed a link (e.g. "Coba lagi" inline action).
   */
  message: string;
  /** Fired when the user clicks the close button. The parent owns the timer. */
  onDismiss: () => void;
  /** Visual tone. Defaults to "warning" to match the lookup-warning triangle. */
  tone?: "warning" | "info" | "error";
}

const TONE_CLASSES: Record<NonNullable<ToastProps["tone"]>, string> = {
  warning: "border-amber-300 bg-amber-50 text-amber-900",
  info: "border-sky-300 bg-sky-50 text-sky-900",
  error: "border-red-300 bg-red-50 text-red-900",
};

/**
 * Transient, non-blocking notification for the dashboard (sub-0007-08).
 *
 * Renders a fixed-position banner at the bottom-right of the viewport.
 * The parent owns the open/close state AND the auto-dismiss timer —
 * this component is intentionally pure so it can be unit-tested
 * without spinning up a React renderer. The parent (dashboard-content)
 * uses `useEffect` + `setTimeout` to schedule the dismiss.
 *
 * The toast pairs with the inline `<LookupWarning>` so a user who
 * has just lost a lookup can read more detail by dismissing the
 * toast and looking at the persistent banner.
 *
 * Accessibility: `role="status"` + `aria-live="polite"` so a screen
 * reader announces the entry without interrupting the current focus.
 * The dismiss button is `aria-label`-ed so the close gesture is
 * discoverable without sight.
 */
export function Toast({ message, onDismiss, tone = "warning" }: ToastProps) {
  const toneClass = TONE_CLASSES[tone];

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="dashboard-toast"
      data-tone={tone}
      className={`fixed bottom-4 right-4 z-50 flex max-w-sm items-start gap-3 rounded-xl border px-4 py-3 shadow-lg ${toneClass}`}
    >
      <p className="flex-1 text-sm leading-5">{message}</p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Tutup notifikasi"
        className="shrink-0 text-xs font-semibold uppercase tracking-wide opacity-70 hover:opacity-100"
      >
        Tutup
      </button>
    </div>
  );
}

/**
 * Shared auto-dismiss scheduler for the dashboard toast (sub-0007-08).
 * Returns a `setTimeout` handle so the parent can `clearTimeout` it
 * on unmount. Pulled out of `<Toast>` so the component itself stays
 * hook-free (testable without a React renderer) and the parent owns
 * the side-effect lifecycle.
 */
export function scheduleToastDismiss(
  onDismiss: () => void,
  durationMs = 5000,
): ReturnType<typeof setTimeout> {
  if (durationMs <= 0) {
    // `setTimeout(fn, 0)` still yields to the event loop — calling
    // synchronously keeps the API ergonomic for the caller.
    onDismiss();
    return setTimeout(() => undefined, 0);
  }
  return setTimeout(onDismiss, durationMs);
}