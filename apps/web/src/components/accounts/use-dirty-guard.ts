"use client";

import { useCallback, useEffect, useRef } from "react";

interface UseDirtyGuardOptions {
  /** True when the form has unsaved changes that should be guarded. */
  isDirty: boolean;
  /** Confirmation message for the in-app + browser dialogs. */
  message: string;
  /**
   * Set to false while the form is loading or after a successful submit
   * (when we're about to navigate away programmatically) to disable the
   * guard entirely.
   */
  enabled: boolean;
}

interface UseDirtyGuardResult {
  /**
   * Synchronous confirmation check for in-app navigation (e.g. the
   * "Kembali" link or the "Batal" button). Returns `true` when it's
   * safe to navigate, `false` when the user wants to stay.
   */
  confirmLeave: () => boolean;
  /**
   * Temporarily disable the guard for a single programmatic navigation.
   * Call this right before `router.replace()` after a successful submit
   * so the `popstate` event from the in-app navigation doesn't trigger
   * the prompt.
   */
  armBypass: () => void;
}

/**
 * Guard an in-progress form against losing data on navigation.
 *
 * - `beforeunload` covers tab close / refresh / external nav.
 * - `popstate` covers browser back / forward. We push a trap state on
 *   mount so the first back-press fires `popstate` instead of leaving
 *   the page; when dirty we prompt and either let the user go
 *   (second back-press with a `bypassRef` flag) or re-push the trap
 *   state to keep them on the form.
 * - `confirmLeave()` is the synchronous gate for in-app navigation
 *   (the header "Kembali" link and the form "Batal" button).
 *
 * The `popstate` listener is set up once per `enabled` flip — not on
 * every `isDirty` change — by reading the live value through a ref.
 * Without that, typing a character would push a fresh trap state and
 * nest the history stack.
 */
export function useDirtyGuard({
  isDirty,
  message,
  enabled,
}: UseDirtyGuardOptions): UseDirtyGuardResult {
  const isDirtyRef = useRef<boolean>(isDirty);
  isDirtyRef.current = isDirty;

  const bypassRef = useRef<boolean>(false);

  // 1. beforeunload — tab close / refresh / external nav. Browsers
  // ignore the custom message string and show their own; we set
  // `returnValue` to opt into the prompt on Chrome/Edge/Firefox.
  useEffect(() => {
    if (!enabled || !isDirty) return;

    const handler = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = message;
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [enabled, isDirty, message]);

  // 2. popstate — browser back / forward, intercepted via a trap state.
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;

    const pushTrap = (): void => {
      try {
        window.history.pushState(null, "", window.location.href);
      } catch {
        // Some browsers throw on pushState in sandboxed iframes; fall
        // through — the guard will degrade to "no trap" but the
        // confirm dialog in `handlePopState` still runs because we
        // attached the listener.
      }
    };

    pushTrap();

    const handlePopState = (): void => {
      if (bypassRef.current) {
        bypassRef.current = false;
        return;
      }
      if (isDirtyRef.current) {
        const confirmed = window.confirm(message);
        if (confirmed) {
          bypassRef.current = true;
          window.history.back();
        } else {
          pushTrap();
        }
      } else {
        bypassRef.current = true;
        window.history.back();
      }
    };

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, [enabled, message]);

  const confirmLeave = useCallback((): boolean => {
    if (!enabled || !isDirty) return true;
    return window.confirm(message);
  }, [enabled, isDirty, message]);

  const armBypass = useCallback((): void => {
    bypassRef.current = true;
  }, []);

  return { confirmLeave, armBypass };
}
