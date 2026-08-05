"use client";

import { useCallback, useMemo, useState } from "react";

import {
  extractSettingsValidationError,
  formatSettingsApiError,
  type ExtractedSettingsValidationError,
  type Settings,
  type SettingsFormErrors,
} from "@/lib/api/settings-client";
import { ApiError } from "@/lib/api/client";

/**
 * Acknowledged bounds for the settings form. Mirrors the Pydantic
 * validators on `SettingsUpdate` so the FE can short-circuit obvious
 * bad input before the submit round-trip. The bounds themselves are
 * authoritative on the BE; these constants exist only so the form
 * layer has a single source of truth for hint text + submit-time
 * guards (and so a future change to the BE contract has one place
 * to update on the FE).
 */
export const ACKNOWLEDGED_SETTINGS_FIELDS = {
  displayNameMin: 1,
  displayNameMax: 100,
  efMultiplierMin: 1,
  efMultiplierMax: 60,
} as const;

/**
 * Format an API error for the general-error banner above the form.
 * Per-field errors are surfaced separately via
 * `extractSettingsValidationError`. Mirrors `formatGoalApiError` so
 * the error UI across the app stays consistent.
 */
export function formatSettingsGeneralError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return "Sesi kamu sudah berakhir. Masuk lagi untuk menyimpan pengaturan.";
    }
    if (error.status === 412) {
      // Caller is expected to handle 412 separately (refresh + prompt)
      // but the formatter still produces a sensible fallback.
      return "Pengaturan telah berubah di sesi lain. Muat ulang lalu coba lagi.";
    }
    if (error.status === 422) {
      return error.message || "Validasi gagal.";
    }
    if (error.status >= 500) {
      return "Server sedang bermasalah. Coba lagi beberapa saat.";
    }
    return error.message || "Permintaan gagal.";
  }
  return "Tidak bisa menghubungi server. Periksa koneksi lalu coba lagi.";
}

/**
 * Form value shape — every editable settings field rendered on the
 * page. Mirrors the FE-camelCase convention used by the rest of the
 * form layer (`goal-form-fields`, `account-form-fields`). Non-
 * editable fields (``email``, ``currency``, ``locale``, ``theme``,
 * ``dependents_count``) live in `Settings` (read-only) and are
 * surfaced via the page header + disabled inputs.
 */
export interface SettingsFormValues {
  displayName: string;
  weekStart: Settings["weekStart"];
  efMultiplier: string;
}

export const INITIAL_SETTINGS_FORM_VALUES: SettingsFormValues = {
  displayName: "",
  weekStart: "senin",
  efMultiplier: "3",
};

/**
 * Build the initial form values from a persisted `Settings` row.
 * `displayName` is nullable on the wire (clears the profile
 * nickname) — empty string in the form state represents the
 * "cleared" intent and `null` on the wire represents the same
 * value once persisted.
 */
export function settingsToFormValues(settings: Settings): SettingsFormValues {
  return {
    displayName: settings.displayName ?? "",
    weekStart: settings.weekStart,
    efMultiplier: String(settings.efMultiplier),
  };
}

export interface SettingsValidationOk {
  ok: true;
  payload: {
    displayName: string | null;
    weekStart: Settings["weekStart"];
    efMultiplier: number;
  };
}
export interface SettingsValidationFailed {
  ok: false;
  fieldErrors: SettingsFormErrors;
  generalError: string | null;
}

/**
 * Validate the form values and produce either a typed payload ready
 * to ship to `updateSettings` or a structured error map the form
 * layer can render inline. Mirrors the BE Pydantic rules:
 *
 * * `displayName` length 0..100 — empty string round-trips to
 *   `null` on the wire (clears the nickname).
 * * `weekStart` is one of the seven Indonesian weekday names (the
 *   radio group already constrains this; the check is defensive).
 * * `efMultiplier` is a positive integer ≥ 1.
 */
export function validateSettingsForm(
  values: SettingsFormValues,
): SettingsValidationOk | SettingsValidationFailed {
  const fieldErrors: SettingsFormErrors = {};
  const trimmedName = values.displayName.trim();

  if (values.displayName.length > ACKNOWLEDGED_SETTINGS_FIELDS.displayNameMax) {
    fieldErrors.displayName = `Nama tampilan maksimal ${ACKNOWLEDGED_SETTINGS_FIELDS.displayNameMax} karakter.`;
  }

  const weekStart = values.weekStart;
  const weekStartOk = (
    weekStart === "senin"
    || weekStart === "selasa"
    || weekStart === "rabu"
    || weekStart === "kamis"
    || weekStart === "jumat"
    || weekStart === "sabtu"
    || weekStart === "minggu"
  );
  if (!weekStartOk) {
    fieldErrors.weekStart = "Hari pertama minggu tidak dikenali.";
  }

  const multiplierRaw = values.efMultiplier.trim();
  let multiplierValue: number | null = null;
  if (multiplierRaw === "") {
    fieldErrors.efMultiplier = "Multiplier wajib diisi.";
  } else if (!/^\d+$/.test(multiplierRaw)) {
    fieldErrors.efMultiplier = "Multiplier hanya angka (contoh: 3).";
  } else {
    multiplierValue = Number.parseInt(multiplierRaw, 10);
    if (
      multiplierValue < ACKNOWLEDGED_SETTINGS_FIELDS.efMultiplierMin
      || multiplierValue > ACKNOWLEDGED_SETTINGS_FIELDS.efMultiplierMax
    ) {
      fieldErrors.efMultiplier = `Multiplier wajib antara ${ACKNOWLEDGED_SETTINGS_FIELDS.efMultiplierMin} dan ${ACKNOWLEDGED_SETTINGS_FIELDS.efMultiplierMax}.`;
      multiplierValue = null;
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return {
      ok: false,
      fieldErrors,
      generalError: "Periksa kembali isian yang ditandai.",
    };
  }

  return {
    ok: true,
    payload: {
      // Empty trimmed string clears the nickname on the BE side
      // (null round-trip → ``display_name IS NULL``).
      displayName: trimmedName === "" ? null : trimmedName,
      weekStart: weekStart,
      efMultiplier: multiplierValue as number,
    },
  };
}

/**
 * Compare the live form values against the persisted snapshot to
 * decide whether the Save button should be enabled. Mirrors
 * `isGoalFormDirty` / `isFormDirty` from the accounts + transactions
 * form layers.
 *
 * The currency/locale/theme/email fields are read-only so they
 * never contribute to the dirty check.
 */
export function isSettingsFormDirty(
  current: SettingsFormValues,
  initial: SettingsFormValues,
): boolean {
  return (
    current.displayName !== initial.displayName
    || current.weekStart !== initial.weekStart
    || current.efMultiplier !== initial.efMultiplier
  );
}

interface UseSettingsFormStateOptions {
  initial: SettingsFormValues;
}

interface UseSettingsFormStateResult {
  values: SettingsFormValues;
  errors: SettingsFormErrors;
  generalError: string | null;
  setValues: (next: SettingsFormValues) => void;
  setFieldError: (field: keyof SettingsFormErrors, message: string) => void;
  clearFieldError: (field: keyof SettingsFormErrors) => void;
  clearMessages: () => void;
  setGeneralError: (message: string) => void;
  applyApiError: (error: unknown) => void;
  resetValues: (next: SettingsFormValues) => void;
}

/**
 * Shared form state hook for the settings page. Keeps the values
 * (controlled inputs), per-field errors, and the general error
 * banner in one place so the renderer is a pure projection of the
 * form state. Mirrors the pattern used by the goal form layer
 * (sub-0005-04) so the BE ↔ FE boundary stays consistent across
 * the app.
 *
 * Optimistic-update + rollback is handled by the page wrapper —
 * the form layer just exposes the values/errors + setters.
 */
export function useSettingsFormState(
  initial: UseSettingsFormStateOptions["initial"],
): UseSettingsFormStateResult {
  const [values, setValuesState] = useState(initial);
  const [errors, setErrors] = useState<SettingsFormErrors>({});
  const [generalError, setGeneralError] = useState<string | null>(null);

  const setValues = useCallback((next: SettingsFormValues) => {
    setValuesState(next);
    setErrors((current) => {
      if (Object.keys(current).length === 0) return current;
      return {};
    });
  }, []);

  const resetValues = useCallback((next: SettingsFormValues) => {
    setValuesState(next);
    setErrors({});
    setGeneralError(null);
  }, []);

  const setFieldError = useCallback((field: keyof SettingsFormErrors, message: string) => {
    setErrors((current) => ({ ...current, [field]: message }));
  }, []);

  const clearFieldError = useCallback((field: keyof SettingsFormErrors) => {
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
    const extracted: ExtractedSettingsValidationError | null = extractSettingsValidationError(error);
    if (extracted) {
      setErrors((current) => ({ ...current, ...extracted.fieldErrors }));
      const general = extracted.generalErrors.length > 0
        ? extracted.generalErrors.join(" ")
        : "Periksa kembali isian yang ditandai.";
      setGeneralError(general);
      return;
    }
    setGeneralError(formatSettingsGeneralError(error));
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
      resetValues,
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
      resetValues,
    ],
  );
}

/** Re-export so import sites don't have to drill into `settings-client.ts`. */
export { formatSettingsApiError };