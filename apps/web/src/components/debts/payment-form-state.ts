"use client";

import { useCallback, useMemo, useState } from "react";

import {
  extractDebtValidationError,
  formatDebtFormApiError,
  type DebtPaymentFormErrors,
  type ExtractedDebtValidationError,
} from "@/lib/api/debt-client";

/* -------------------------------------------------------------------------- *
 * Form state hook                                                            *
 * -------------------------------------------------------------------------- *
 *
 * Mirrors `useDebtFormState` and `useGoalFormState`. Keeps the
 * values (controlled inputs), per-field errors, and the general
 * error banner in one place so the create / pay page renders the
 * same way.
 *
 * The hook re-exports `formatDebtFormApiError` from `debt-client`
 * so the page-level wrappers don't have to import two modules for
 * the same status-code mapping.
 */

export {
  INITIAL_PAYMENT_FORM_VALUES,
  PAYMENT_NOTE_MAX,
  initialPaymentFormValuesForCreate,
} from "@/components/debts/payment-form-fields";

export { formatDebtFormApiError };

export type PaymentFormValues = import("@/components/debts/payment-form-fields").PaymentFormValues;

interface UsePaymentFormStateOptions {
  initial: PaymentFormValues;
}

interface UsePaymentFormStateResult {
  values: PaymentFormValues;
  errors: DebtPaymentFormErrors;
  generalError: string | null;
  setValues: (next: PaymentFormValues) => void;
  setFieldError: (field: keyof DebtPaymentFormErrors, message: string) => void;
  clearFieldError: (field: keyof DebtPaymentFormErrors) => void;
  clearMessages: () => void;
  setGeneralError: (message: string) => void;
  applyApiError: (error: unknown) => void;
}

/**
 * Shared form state hook for the payment form. Mirrors
 * `useDebtFormState` so the form layer has the same affordances
 * across the app.
 */
export function usePaymentFormState(
  initial: UsePaymentFormStateOptions["initial"],
): UsePaymentFormStateResult {
  const [values, setValuesState] = useState(initial);
  const [errors, setErrors] = useState<DebtPaymentFormErrors>({});
  const [generalError, setGeneralError] = useState<string | null>(null);

  const setValues = useCallback((next: PaymentFormValues) => {
    setValuesState(next);
    // Clear stale per-field errors on any change so the form doesn't
    // keep a red border on a field the user has already corrected.
    setErrors((current) => {
      if (Object.keys(current).length === 0) return current;
      return {};
    });
  }, []);

  const setFieldError = useCallback(
    (field: keyof DebtPaymentFormErrors, message: string) => {
      setErrors((current) => ({ ...current, [field]: message }));
    },
    [],
  );

  const clearFieldError = useCallback((field: keyof DebtPaymentFormErrors) => {
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
