"use client";

import { useCallback, useMemo, useState } from "react";

import {
  extractGoalValidationError,
  type ExtractedGoalValidationError,
  type GoalFormErrors,
} from "@/lib/api/goal-client";
import { ApiError } from "@/lib/api/client";

export const GOAL_NOTE_MAX = 2000;
export const GOAL_NAME_MAX = 120;

/**
 * Acknowledged field bounds. Mirrors the Pydantic validators on
 * `GoalCreate` / `GoalUpdate` so the FE can short-circuit obvious
 * bad input before the submit round-trip. The bounds themselves are
 * authoritative on the BE; this struct exists only so the form layer
 * has a single source of truth for hint text + submit-time guards.
 */
export const ACKNOWLEDGED_GOAL_FIELDS = {
  nameMin: 1,
  nameMax: GOAL_NAME_MAX,
  noteMax: GOAL_NOTE_MAX,
} as const;

/**
 * Format an API error for the general-error banner above the form.
 * Per-field errors are surfaced separately via `extractGoalValidationError`.
 */
export function formatGoalApiError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return "Sesi kamu sudah berakhir. Masuk lagi untuk melanjutkan.";
    }
    if (error.status === 404) {
      return "Goal tidak ditemukan.";
    }
    if (error.status === 422) {
      // 422 is handled by the per-field error path; fall through to
      // the generic message for any non-mapped detail entries.
      return error.message || "Validasi gagal.";
    }
    if (error.status >= 500) {
      return "Server sedang bermasalah. Coba lagi beberapa saat.";
    }
    return error.message || "Permintaan gagal.";
  }
  return "Tidak bisa menghubungi server. Periksa koneksi lalu coba lagi.";
}

interface UseGoalFormStateOptions {
  initial: import("@/components/goals/goal-form-fields").GoalFormValues;
}

interface UseGoalFormStateResult {
  values: import("@/components/goals/goal-form-fields").GoalFormValues;
  errors: GoalFormErrors;
  generalError: string | null;
  setValues: (
    next: import("@/components/goals/goal-form-fields").GoalFormValues,
  ) => void;
  setFieldError: (field: keyof GoalFormErrors, message: string) => void;
  clearFieldError: (field: keyof GoalFormErrors) => void;
  clearMessages: () => void;
  setGeneralError: (message: string) => void;
  applyApiError: (error: unknown) => void;
}

/**
 * Shared form state hook for the create + edit pages. Keeps the values
 * (controlled inputs), per-field errors, and the general error banner
 * in one place so both pages render the same way. Mirrors the pattern
 * already used by the accounts / transactions form layers so the BE
 * ↔ FE boundary stays consistent across the app.
 */
export function useGoalFormState(
  initial: UseGoalFormStateOptions["initial"],
): UseGoalFormStateResult {
  const [values, setValuesState] = useState(initial);
  const [errors, setErrors] = useState<GoalFormErrors>({});
  const [generalError, setGeneralError] = useState<string | null>(null);

  const setValues = useCallback(
    (next: typeof initial) => {
      setValuesState(next);
      setErrors((current) => {
        if (Object.keys(current).length === 0) return current;
        return {};
      });
    },
    [],
  );

  const setFieldError = useCallback((field: keyof GoalFormErrors, message: string) => {
    setErrors((current) => ({ ...current, [field]: message }));
  }, []);

  const clearFieldError = useCallback((field: keyof GoalFormErrors) => {
    setErrors((current) => {
      if (current[field] === undefined) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }, []);

  const clearMessages = useCallback(() => {
    setErrors({});
    setGeneralError(null);
  }, []);

  const applyApiError = useCallback((error: unknown) => {
    const extracted: ExtractedGoalValidationError | null = extractGoalValidationError(error);
    if (extracted) {
      setErrors((current) => ({ ...current, ...extracted.fieldErrors }));
      const general =
        extracted.generalErrors.length > 0
          ? extracted.generalErrors.join(" ")
          : "Periksa kembali isian yang ditandai.";
      setGeneralError(general);
      return;
    }
    setGeneralError(formatGoalApiError(error));
  }, []);

  return useMemo(
    () => ({
      values,
      errors,
      generalError,
      setValues,
      setFieldError,
      clearFieldError,
      clearMessages,
      setGeneralError,
      applyApiError,
    }),
    [
      values,
      errors,
      generalError,
      setValues,
      setFieldError,
      clearFieldError,
      clearMessages,
      setGeneralError,
      applyApiError,
    ],
  );
}
