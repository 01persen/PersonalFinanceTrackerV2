"use client";

import { useEffect, type ReactNode } from "react";

/**
 * Mobile bottom-sheet wrapper (sub-0004-05 AC (5)).
 *
 * Behaviour:
 *
 *   - Slides up from the bottom on viewports < lg. Anchored to the
 *     bottom edge with a max-height of 90vh so the header + footer
 *     stay reachable on a 390×844 device.
 *   - Backdrop is a fixed full-screen button — tapping it dismisses
 *     the sheet, mirroring the sidebar pattern from
 *     ``components/shell/app-shell.tsx``.
 *   - ``Escape`` key dismisses (unless ``disableDismiss`` is set) —
 *     same a11y affordance as the category editor sheet.
 *   - Body scroll is locked while the sheet is open so the page
 *     beneath doesn't bleed through during pull-to-refresh style
 *     gestures on iOS Safari.
 *   - Returns ``null`` when ``open`` is ``false`` so the host doesn't
 *     pay the cost of mounting the panel until the user actually
 *     opens it.
 */

export interface BottomSheetProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  /** Set ``true`` for irreversible flows (e.g. save-in-progress). */
  disableDismiss?: boolean;
}

export function BottomSheet({
  open,
  title,
  description,
  onClose,
  children,
  disableDismiss = false,
}: BottomSheetProps) {
  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !disableDismiss) {
        event.preventDefault();
        onClose();
      }
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose, disableDismiss]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center lg:hidden"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bottom-sheet-title"
    >
      <button
        type="button"
        className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm"
        aria-label="Tutup panel filter"
        onClick={() => {
          if (!disableDismiss) onClose();
        }}
      />
      <section className="relative z-10 flex max-h-[90vh] w-full flex-col rounded-t-2xl bg-white shadow-2xl">
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div>
            <h2
              id="bottom-sheet-title"
              className="text-base font-bold text-slate-950"
            >
              {title}
            </h2>
            {description ? (
              <p className="mt-1 text-xs leading-5 text-slate-500">
                {description}
              </p>
            ) : null}
          </div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col px-5 py-4">{children}</div>
      </section>
    </div>
  );
}