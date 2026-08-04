"use client";

import { useCallback, useMemo, useState } from "react";

import {
  extractDebtValidationError,
  formatDebtFormApiError,
  type DebtFormErrors,
  type ExtractedDebtValidationError,
} from "@/lib/api/debt-client";

/* -------------------------------------------------------------------------- *
 * Form state hook                                                            *
 * -------------------------------------------------------------------------- *
 *
 * Mirrors `useGoalFormState` (sub-0005-04): keeps the values
 * (controlled inputs), per-field errors, and the general error banner
 * in one place so the create / edit / pay pages render the same way.
 *
 * The hook re-exports `formatDebtFormApiError` from `debt-client` so
 * the page-level wrappers don't have to import two modules for the
 * same status-code mapping.
 */

export {
  DEBT_NAME_MAX,
  DEBT_NOTE_MAX,
  INITIAL_DEBT_FORM_VALUES,
} from "@/components/debts/debt-form-fields";

export { formatDebtFormApiError };

export type DebtFormValues = import("@/components/debts/debt-form-fields").DebtFormValues;

interface UseDebtFormStateOptions {
  initial: DebtFormValues;
}

interface UseDebtFormStateResult {
  values: DebtFormValues;
  errors: DebtFormErrors;
  generalError: string | null;
  setValues: (next: DebtFormValues) => void;
  setFieldError: (field: keyof DebtFormErrors, message: string) => void;
  clearFieldError: (field: keyof DebtFormErrors) => void;
  clearMessages: () => void;
  setGeneralError: (message: string) => void;
  applyApiError: (error: unknown) => void;
}

/**
 * Shared form state hook for the debt create + edit pages. Mirrors
 * `useGoalFormState` so the form layer has the same affordances
 * across the app.
 */
export function useDebtFormState(
  initial: UseDebtFormStateOptions["initial"],
): UseDebtFormStateResult {
  const [values, setValuesState] = useState(initial);
  const [errors, setErrors] = useState<DebtFormErrors>({});
  const [generalError, setGeneralError] = useState<string | null>(null);

  const setValues = useCallback((next: DebtFormValues) => {
    setValuesState(next);
    // Clear stale per-field errors on any change so the form doesn't
    // keep a red border on a field the user has already corrected.
    // The submit step re-runs the validators so a fresh attempt gets
    // a fresh error set.
    setErrors((current) => {
      if (Object.keys(current).length === 0) return current;
      return {};
    });
  }, []);

  const setFieldError = useCallback((field: keyof DebtFormErrors, message: string) => {
    setErrors((current) => ({ ...current, [field]: message }));
  }, []);

  const clearFieldError = useCallback((field: keyof DebtFormErrors) => {
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
    const extracted: ExtractedDebtValidationError | null = extractDebtValidationError(error);
    if (extracted) {
      setErrors((current) => ({ ...current, ...extracted.fieldErrors }));
      const general =
        extracted.generalErrors.length > 0
          ? extracted.generalErrors.join(" ")
          : "Periksa kembali isian yang ditandai.";
      setGeneralError(general);
      return;
    }
    const fallback = error instanceof Error ? error.message : "Permintaan gagal.";
    setGeneralError(fallback);
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
