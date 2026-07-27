"use client";

import { useCallback, useMemo, useState } from "react";

import {
  extractValidationError,
  type AccountFormErrors,
  type ExtractedValidationError,
} from "@/lib/api/account-client";
import { ApiError } from "@/lib/api/client";

export const ACKNOWLEDGED_FIELDS = {
  nameMax: 120,
} as const;

/**
 * Format an API error for the general-error banner above the form.
 * Per-field errors are surfaced separately via `extractValidationError`.
 */
export function formatApiError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return "Sesi kamu sudah berakhir. Masuk lagi untuk melanjutkan.";
    }
    if (error.status === 404) {
      return "Akun tidak ditemukan.";
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

interface UseAccountFormStateOptions {
  initial: import("@/components/accounts/account-form-fields").AccountFormValues;
}

interface UseAccountFormStateResult {
  values: import("@/components/accounts/account-form-fields").AccountFormValues;
  errors: AccountFormErrors;
  generalError: string | null;
  setValues: (
    next: import("@/components/accounts/account-form-fields").AccountFormValues,
  ) => void;
  setFieldError: (field: keyof AccountFormErrors, message: string) => void;
  clearFieldError: (field: keyof AccountFormErrors) => void;
  clearMessages: () => void;
  setGeneralError: (message: string) => void;
  applyApiError: (error: unknown) => void;
}

/**
 * Shared form state hook for the create + edit pages. Keeps the values
 * (controlled inputs), per-field errors, and the general error banner
 * in one place so both pages render the same way.
 */
export function useAccountFormState(
  initial: UseAccountFormStateOptions["initial"],
): UseAccountFormStateResult {
  const [values, setValuesState] = useState(initial);
  const [errors, setErrors] = useState<AccountFormErrors>({});
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

  const setFieldError = useCallback((field: keyof AccountFormErrors, message: string) => {
    setErrors((current) => ({ ...current, [field]: message }));
  }, []);

  const clearFieldError = useCallback((field: keyof AccountFormErrors) => {
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
    const extracted: ExtractedValidationError | null = extractValidationError(error);
    if (extracted) {
      setErrors((current) => ({ ...current, ...extracted.fieldErrors }));
      const general =
        extracted.generalErrors.length > 0
          ? extracted.generalErrors.join(" ")
          : "Periksa kembali isian yang ditandai.";
      setGeneralError(general);
      return;
    }
    setGeneralError(formatApiError(error));
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
