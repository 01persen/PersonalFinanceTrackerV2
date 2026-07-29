"use client";

import { useCallback, useMemo, useState } from "react";

import {
  extractTransactionValidationError,
  type ExtractedTransactionValidationError,
  type TransactionFormErrors,
} from "@/lib/api/transaction-client";
import { ApiError } from "@/lib/api/client";

export const TRANSACTION_ACKNOWLEDGED_FIELDS = {
  noteMax: 2000,
} as const;

/**
 * Format an API error for the general-error banner above the form.
 * Per-field errors are surfaced separately via
 * ``extractTransactionValidationError``.
 */
export function formatTransactionApiError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return "Sesi kamu sudah berakhir. Masuk lagi untuk melanjutkan.";
    }
    if (error.status === 404) {
      return "Transaksi tidak ditemukan.";
    }
    if (error.status === 422) {
      // 422 is handled by the per-field error path; fall through to the
      // generic message for any non-mapped detail entries.
      return error.message || "Validasi gagal.";
    }
    if (error.status >= 500) {
      return "Server sedang bermasalah. Coba lagi beberapa saat.";
    }
    return error.message || "Permintaan gagal.";
  }
  return "Tidak bisa menghubungi server. Periksa koneksi lalu coba lagi.";
}

interface UseTransactionFormStateOptions {
  initial: import("@/components/transactions/transaction-form-fields").TransactionFormValues;
}

interface UseTransactionFormStateResult {
  values: import("@/components/transactions/transaction-form-fields").TransactionFormValues;
  errors: TransactionFormErrors;
  generalError: string | null;
  setValues: (
    next: import("@/components/transactions/transaction-form-fields").TransactionFormValues,
  ) => void;
  setFieldError: (field: keyof TransactionFormErrors, message: string) => void;
  clearMessages: () => void;
  setGeneralError: (message: string) => void;
  applyApiError: (error: unknown) => void;
}

/**
 * Shared form state hook for the create + edit pages. Keeps the values
 * (controlled inputs), per-field errors, and the general error banner
 * in one place so both pages render the same way.
 */
export function useTransactionFormState(
  initial: UseTransactionFormStateOptions["initial"],
): UseTransactionFormStateResult {
  const [values, setValuesState] = useState(initial);
  const [errors, setErrors] = useState<TransactionFormErrors>({});
  const [generalError, setGeneralError] = useState<string | null>(null);

  const setValues = useCallback(
    (next: typeof initial) => {
      setValuesState(next);
      // Clear everything field-specific when the user edits anything. The
      // network/server errors stay until the next submit.
      setErrors((current) => {
        if (Object.keys(current).length === 0) return current;
        return {};
      });
    },
    [],
  );

  const setFieldError = useCallback(
    (field: keyof TransactionFormErrors, message: string) => {
      setErrors((current) => ({ ...current, [field]: message }));
    },
    [],
  );

  const clearMessages = useCallback(() => {
    setErrors({});
    setGeneralError(null);
  }, []);

  const applyApiError = useCallback((error: unknown) => {
    const extracted: ExtractedTransactionValidationError | null =
      extractTransactionValidationError(error);
    if (extracted) {
      setErrors((current) => ({ ...current, ...extracted.fieldErrors }));
      const general =
        extracted.generalErrors.length > 0
          ? extracted.generalErrors.join(" ")
          : "Periksa kembali isian yang ditandai.";
      setGeneralError(general);
      return;
    }
    setGeneralError(formatTransactionApiError(error));
  }, []);

  return useMemo(
    () => ({
      values,
      errors,
      generalError,
      setValues,
      setFieldError,
      clearMessages,
      setGeneralError,
      applyApiError,
    }),
    [values, errors, generalError, setValues, setFieldError, clearMessages, setGeneralError, applyApiError],
  );
}