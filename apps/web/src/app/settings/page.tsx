"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { AppShell } from "@/components/shell/app-shell";
import {
  SettingsFormFields,
  SettingsFormSkeleton,
} from "@/components/settings/settings-form-fields";
import {
  formatSettingsGeneralError,
  isSettingsFormDirty,
  settingsToFormValues,
  useSettingsFormState,
  validateSettingsForm,
  type SettingsFormValues,
} from "@/components/settings/settings-form-state";
import { ApiError } from "@/lib/api/client";
import {
  fetchSettings,
  updateSettings,
  type Settings,
} from "@/lib/api/settings-client";
import { useAuth } from "@/lib/auth/auth-context";
import { AuthGuard } from "@/lib/auth/auth-guard";

/**
 * `/settings` — Profil + Preferensi settings page (sub-0008-04).
 *
 * State flow:
 *
 *   1. **Load** — `GET /settings` on mount. Skeleton state until the
 *      response arrives (no flash of `undefined`). Race defense via
 *      `latestLoadIdRef` so a stale response from a slow request
 *      can't overwrite the live snapshot.
 *   2. **Edit** — controlled inputs render from `form.values`. The
 *      Save button is disabled until the form is dirty AND valid.
 *      The dirty check compares the live values against the
 *      `initialRef` snapshot taken at mount (sub-0005-04 mirror).
 *   3. **Optimistic save** — on submit we snapshot the *current*
 *      values for rollback, fire `PATCH /settings` with the
 *      optimistic-concurrency `If-Match` header, and on 200 we
 *      adopt the BE response as the new baseline. On error we
 *      rollback to the snapshot, surface the error, and on 412 we
 *      refetch + prompt (never a silent clobber, AC (e)).
 *   4. **Double-submit guard** — `submit.kind === "submitting"`
 *      disables the Save button so a tap-tap can't fire two PATCH
 *      calls in flight.
 *   5. **ETag handling** — the BE surfaces `version: int` in the
 *      body *and* the `ETag: "<v>"` response header. The FE stores
 *      both and round-trips on PATCH so a 2-tab race with one tab
 *      editing while another has unsaved stale state surfaces a
 *      clean 412 instead of silently clobbering either side (AC
 *      (e)).
 *
 * Mobile-first (PRD §15, reference 390×844): single-column sections,
 * ≥44px touch targets via the `min-h-[44px]` radio chips + the
 * default `form-input` padding, and the error/success banners stack
 * above the submit row.
 */

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; settings: Settings; etag: string | null }
  | { kind: "error"; message: string };

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; at: number }
  | { kind: "stale" };

export default function SettingsPage() {
  return (
    <AuthGuard>
      <SettingsContent />
    </AuthGuard>
  );
}

function SettingsContent() {
  const { user, logout, isLoading: isLoggingOut } = useAuth();

  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [submit, setSubmit] = useState<SubmitState>({ kind: "idle" });
  const latestLoadIdRef = useRef<number>(0);

  const initialRef = useRef<SettingsFormValues | null>(null);
  const settingsRef = useRef<Settings | null>(null);
  const etagRef = useRef<string | null>(null);

  const form = useSettingsFormState(
    initialRef.current ?? {
      displayName: "",
      weekStart: "senin",
      efMultiplier: "3",
    },
  );

  const isSubmitting = submit.kind === "submitting";
  const isStale = submit.kind === "stale";
  const isFormActive =
    load.kind === "ready" && !isSubmitting && !isStale;

  const isDirty = useMemo<boolean>(() => {
    if (!isFormActive) return false;
    if (initialRef.current === null) return false;
    return isSettingsFormDirty(form.values, initialRef.current);
  }, [form.values, isFormActive]);

  const liveValidation = useMemo(() => {
    if (!isFormActive) return null;
    return validateSettingsForm(form.values);
  }, [form.values, isFormActive]);

  const canSubmit = useMemo<boolean>(() => {
    if (!isFormActive) return false;
    if (!isDirty) return false;
    return liveValidation?.ok === true;
  }, [isDirty, liveValidation, isFormActive]);

  const loadSettings = useCallback(async () => {
    const loadId = ++latestLoadIdRef.current;
    setLoad({ kind: "loading" });

    try {
      const { settings, etag } = await fetchSettings();
      if (loadId !== latestLoadIdRef.current) return;

      const initial = settingsToFormValues(settings);
      initialRef.current = initial;
      settingsRef.current = settings;
      etagRef.current = etag;
      form.resetValues(initial);
      setLoad({ kind: "ready", settings, etag });
      setSubmit({ kind: "idle" });
    } catch (error) {
      if (loadId !== latestLoadIdRef.current) return;
      const message =
        error instanceof ApiError
          ? error.message || "Gagal memuat pengaturan."
          : "Tidak bisa memuat pengaturan. Periksa koneksi lalu coba lagi.";
      setLoad({ kind: "error", message });
    }
    // We intentionally don't depend on `form.resetValues` — the form
    // is reset once after a successful load and edits are tracked via
    // the form state. The ESLint rule for exhaustive-deps is
    // suppressed at the call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const persist = useCallback(
    async (values: SettingsFormValues): Promise<void> => {
      const validation = validateSettingsForm(values);
      if (!validation.ok) {
        // Should never happen — the Save button is disabled when
        // validation fails — but keep the guard so a programmatic
        // submit can't bypass it.
        return;
      }

      const baseSettings = settingsRef.current;
      if (baseSettings === null) return;
      const baseEtag = etagRef.current;
      const baseVersion = baseSettings.version;

      const payload = validation.payload;

      // Optimistic update — apply the new value locally so the UI
      // reflects the saved state without waiting for the round-trip
      // to resolve. The rollback snapshot is the *previous* values
      // so a failed PATCH restores the exact baseline.
      const rollbackValues = initialRef.current ?? values;
      const optimistic: Settings = {
        ...baseSettings,
        displayName: payload.displayName,
        weekStart: payload.weekStart,
        efMultiplier: payload.efMultiplier,
      };
      settingsRef.current = optimistic;
      // Optimistic version — the BE bumps it on commit. If the
      // commit fails we keep the original version (the rollback
      // branch restores `baseSettings`).
      form.setValues({
        displayName:
          payload.displayName === null ? "" : payload.displayName,
        weekStart: payload.weekStart,
        efMultiplier: String(payload.efMultiplier),
      });
      form.clearMessages();
      setSubmit({ kind: "submitting" });

      try {
        const { settings: next, etag: nextEtag } = await updateSettings(
          payload,
          { version: baseVersion, etag: baseEtag },
        );
        // Adopt the BE response as the new baseline — the version
        // token advances here.
        const nextInitial = settingsToFormValues(next);
        initialRef.current = nextInitial;
        settingsRef.current = next;
        etagRef.current = nextEtag;
        setLoad({ kind: "ready", settings: next, etag: nextEtag });
        form.resetValues(nextInitial);
        setSubmit({ kind: "success", at: Date.now() });
      } catch (error) {
        if (error instanceof ApiError && error.status === 412) {
          // Stale write — another tab/session wrote first. Rollback
          // the optimistic update and force a refetch so the user
          // sees the new baseline on the next render. The 412
          // message is friendlier than the generic banner because
          // it's an actionable "your edit lost a race" condition.
          initialRef.current = rollbackValues;
          settingsRef.current = baseSettings;
          form.resetValues(rollbackValues);
          setLoad({ kind: "ready", settings: baseSettings, etag: baseEtag });
          form.setGeneralError(
            "Pengaturan telah berubah di sesi lain. Muat ulang untuk melihat versi terbaru.",
          );
          setSubmit({ kind: "stale" });
          // Refetch in the background so the next edit round-trips
          // against the freshest version.
          void loadSettings();
          return;
        }
        // Generic failure — rollback to the previous baseline and
        // surface the API error inline.
        initialRef.current = rollbackValues;
        settingsRef.current = baseSettings;
        form.resetValues(rollbackValues);
        setLoad({ kind: "ready", settings: baseSettings, etag: baseEtag });
        if (error instanceof ApiError) {
          form.applyApiError(error);
        } else {
          form.setGeneralError(formatSettingsGeneralError(error));
        }
        setSubmit({ kind: "idle" });
      }
    },
    [form, loadSettings],
  );

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submit.kind === "submitting") return;
      if (!canSubmit) return;
      await persist(form.values);
    },
    [canSubmit, form.values, persist, submit.kind],
  );

  const handleReload = useCallback(() => {
    void loadSettings();
  }, [loadSettings]);

  const handleLogout = useCallback(async () => {
    await logout();
  }, [logout]);

  return (
    <AppShell user={user} isLoggingOut={isLoggingOut} onLogout={handleLogout}>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-700">
            Epic 0008 · Export, Backup &amp; Settings
          </p>
          <h2 className="mt-1 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">
            Pengaturan
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
            Perbarui nama tampilan dan preferensi akun. Perubahan
            langsung berlaku untuk sesi berikutnya.
          </p>
        </div>
        <button
          type="button"
          className="btn-secondary !w-auto px-4"
          onClick={handleReload}
          aria-label="Muat ulang pengaturan"
          disabled={load.kind === "loading"}
        >
          Muat ulang
        </button>
      </header>

      {load.kind === "loading" ? (
        <section className="card mt-6" aria-busy="true" aria-live="polite">
          <h3 className="sr-only">Memuat pengaturan</h3>
          <SettingsFormSkeleton />
        </section>
      ) : null}

      {load.kind === "error" ? (
        <section
          className="card mt-6 border-red-200 bg-red-50"
          role="alert"
          aria-live="assertive"
        >
          <h3 className="text-base font-semibold text-red-900">
            Gagal memuat pengaturan
          </h3>
          <p className="mt-2 text-sm leading-6 text-red-800">{load.message}</p>
          <button
            type="button"
            className="btn-primary mt-4 !w-auto px-4"
            onClick={handleReload}
          >
            Coba lagi
          </button>
        </section>
      ) : null}

      {load.kind === "ready" ? (
        <section className="card mt-6">
          <form className="grid gap-5" onSubmit={handleSubmit} noValidate>
            <SettingsFormFields
              values={form.values}
              errors={form.errors}
              onChange={form.setValues}
              settings={load.settings}
              disabled={!isFormActive}
              idPrefix="settings"
            />

            {form.generalError ? (
              <div
                role="alert"
                className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
              >
                {form.generalError}
              </div>
            ) : null}

            {submit.kind === "success" ? (
              <div
                role="status"
                className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
              >
                Pengaturan berhasil disimpan.
              </div>
            ) : null}

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                className="btn-secondary"
                onClick={handleReload}
                disabled={!isFormActive}
              >
                Batal
              </button>
              <button
                type="submit"
                className="btn-primary"
                disabled={!canSubmit}
                aria-disabled={!canSubmit}
                aria-busy={isSubmitting}
              >
                {isSubmitting ? "Menyimpan..." : "Simpan perubahan"}
              </button>
            </div>

            <p className="text-xs text-slate-500">
              Multiplier dana darurat dipakai oleh goal engine untuk
              menghitung snapshot dana darurat di goal baru (sub-0005-02).
              Tidak mengubah snapshot goal yang sudah dibuat.
            </p>
          </form>
        </section>
      ) : null}
    </AppShell>
  );
}