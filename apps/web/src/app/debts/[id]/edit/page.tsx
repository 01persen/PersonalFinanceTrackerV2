"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { AppShell } from "@/components/shell/app-shell";
import {
  DebtFormFields,
  DebtFormFieldsSkeleton,
  DebtSubmitSkeleton,
  INITIAL_DEBT_FORM_VALUES,
  debtToFormValues,
  isDebtFormDirty,
  parseBungaPctInput,
  parseRupiahInputToCents,
  validateBungaPct,
  validatePrincipalAmount,
  validateTenorMonths,
} from "@/components/debts/debt-form-fields";
import {
  formatDebtFormApiError,
  useDebtFormState,
} from "@/components/debts/debt-form-state";
import { useDirtyGuard } from "@/components/accounts/use-dirty-guard";
import {
  fetchDebtById,
  updateDebt,
  type Debt,
} from "@/lib/api/debt-client";
import { ApiError } from "@/lib/api/client";
import { useAuth } from "@/lib/auth/auth-context";
import { AuthGuard } from "@/lib/auth/auth-guard";

const DIRTY_LEAVE_MESSAGE = "Perubahan belum disimpan. Yakin ingin keluar?";

interface PageProps {
  params: Promise<{ id: string }>;
}

type FormPrefetchState =
  | { kind: "loading" }
  | { kind: "ready"; debt: Debt }
  | { kind: "not_found" }
  | { kind: "error"; message: string };

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success" };

/**
 * `/debts/{id}/edit` — update an existing debt. Additive over the BE
 * `GET /debts/{id}` (sub-0006-01) + `PATCH /debts/{id}` (sub-0006-01)
 * endpoints.
 *
 * State flow:
 *
 *   1. Prefetch — load the debt by id. 404 surfaces a
 *      "Utang tidak ditemukan" panel with a back link to `/debts`.
 *   2. Prefill — seed the form from the persisted row via
 *      `debtToFormValues`. The page tracks the initial snapshot so
 *      `isDebtFormDirty` can opt the user into the leave guard.
 *   3. Submit — clear messages, run validators, then PATCH only the
 *      fields the user touched. `kind` is intentionally editable
 *      here (the BE schema allows it on PATCH) so a user can
 *      re-categorize a debt after creation.
 *   4. Success — show a brief banner, then `router.replace(/debts)`
 *      so the list page re-fetches with the updated row.
 *
 * Out of scope (per sub-0006-05): the payment form (deferred until
 * sub-0006-02 lands) and the history detail (sub-0006-06).
 */

export default function EditDebtPage({ params }: PageProps) {
  const { id } = use(params);
  return (
    <AuthGuard>
      <EditDebtContent debtId={id} />
    </AuthGuard>
  );
}

function EditDebtContent({ debtId }: { debtId: string }) {
  const router = useRouter();
  const { user, logout, isLoading: isLoggingOut } = useAuth();

  const initialRef = useRef<import("@/components/debts/debt-form-fields").DebtFormValues>(
    INITIAL_DEBT_FORM_VALUES,
  );
  const [prefetch, setPrefetch] = useState<FormPrefetchState>({ kind: "loading" });
  const [submit, setSubmit] = useState<SubmitState>({ kind: "idle" });

  const form = useDebtFormState(initialRef.current);

  const isSubmitting = submit.kind === "submitting";
  const isSuccess = submit.kind === "success";
  const isFormActive =
    !isSubmitting && !isSuccess && prefetch.kind === "ready";

  const isDirty = useMemo<boolean>(() => {
    if (!isFormActive) return false;
    return isDebtFormDirty(form.values, initialRef.current);
  }, [form.values, isFormActive]);

  const { confirmLeave, armBypass } = useDirtyGuard({
    isDirty,
    message: DIRTY_LEAVE_MESSAGE,
    enabled: isFormActive,
  });

  const loadDebt = useCallback(async () => {
    setPrefetch({ kind: "loading" });
    try {
      const debt = await fetchDebtById(debtId);
      if (!debt) {
        setPrefetch({ kind: "not_found" });
        return;
      }
      const initial = debtToFormValues(debt);
      initialRef.current = initial;
      form.setValues(initial);
      setPrefetch({ kind: "ready", debt });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        setPrefetch({ kind: "not_found" });
        return;
      }
      const message =
        error instanceof ApiError
          ? error.message || "Gagal memuat detail utang."
          : "Tidak bisa memuat detail utang. Periksa koneksi lalu coba lagi.";
      setPrefetch({ kind: "error", message });
    }
    // We intentionally don't depend on `form.setValues` — the form is
    // set once after load, and further edits are tracked via the form
    // state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debtId]);

  useEffect(() => {
    void loadDebt();
  }, [loadDebt]);

  const handleLogout = useCallback(async () => {
    if (!confirmLeave()) return;
    armBypass();
    await logout();
    router.replace("/login");
  }, [armBypass, confirmLeave, logout, router]);

  const persist = useCallback(
    async (values: import("@/components/debts/debt-form-fields").DebtFormValues): Promise<void> => {
      const name = values.name.trim();
      if (name.length === 0) {
        form.setFieldError("name", "Nama utang wajib diisi.");
        form.setGeneralError("Periksa kembali isian formulir.");
        return;
      }

      const principalValidation = validatePrincipalAmount(values.principalCents);
      if (!principalValidation.ok) {
        form.setFieldError("principalCents", principalValidation.reason);
        form.setGeneralError("Periksa kembali isian formulir.");
        return;
      }

      const bungaValidation = validateBungaPct(values.bungaPct);
      if (!bungaValidation.ok) {
        form.setFieldError("bungaPct", bungaValidation.reason);
        form.setGeneralError("Periksa kembali isian formulir.");
        return;
      }

      let tenorMonths: number | null = null;
      if (values.hasTenor) {
        const tenorValidation = validateTenorMonths(values.tenorMonths);
        if (!tenorValidation.ok) {
          form.setFieldError("tenorMonths", tenorValidation.reason);
          form.setGeneralError("Periksa kembali isian formulir.");
          return;
        }
        tenorMonths = tenorValidation.value;
      }

      const initial = initialRef.current;
      const startDate = values.startDate === "" ? initial.startDate : values.startDate;

      // Build the PATCH payload. The BE schema uses `exclude_unset`
      // semantics (only fields present in the request body are
      // touched) so we only emit fields the user actually changed.
      // The diff helpers below re-parse the initial string-form
      // values back into the wire shape (cents / decimal) before
      // comparing so a same-value edit doesn't emit a stray field.
      const initialPrincipalCents = parseRupiahInputToCents(initial.principalCents);
      const initialBungaPct = parseBungaPctInput(initial.bungaPct);
      const initialTenor: number | null =
        initial.hasTenor && initial.tenorMonths.trim() !== ""
          ? Number.parseInt(initial.tenorMonths, 10) || null
          : null;

      const payload: import("@/lib/api/debt-client").DebtUpdatePayload = {};
      if (name !== initial.name) payload.name = name;
      if (values.kind !== initial.kind) payload.kind = values.kind;
      if (principalValidation.cents !== initialPrincipalCents) {
        payload.principalCents = principalValidation.cents;
      }
      if (bungaValidation.value !== initialBungaPct) {
        payload.bungaPct = bungaValidation.value;
      }
      if (tenorMonths !== initialTenor) {
        payload.tenorMonths = tenorMonths;
      }
      if (startDate !== initial.startDate) payload.startDate = startDate;
      const trimmedNote = values.note.trim();
      const initialNote = initial.note.trim();
      if (trimmedNote !== initialNote) {
        payload.note = trimmedNote === "" ? null : trimmedNote;
      }

      setSubmit({ kind: "submitting" });
      try {
        await updateDebt(debtId, payload);
        setSubmit({ kind: "success" });
        window.setTimeout(() => {
          armBypass();
          router.replace("/debts");
          router.refresh();
        }, 900);
      } catch (error) {
        setSubmit({ kind: "idle" });
        if (error instanceof ApiError) {
          form.applyApiError(error);
        } else {
          form.setGeneralError(formatDebtFormApiError(error));
        }
      }
    },
    [armBypass, debtId, form, router],
  );

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submit.kind === "submitting") return;
      form.clearMessages();
      await persist(form.values);
    },
    [form, persist, submit.kind],
  );

  const handleBack = useCallback(() => {
    if (!confirmLeave()) return;
    armBypass();
    router.replace("/debts");
  }, [armBypass, confirmLeave, router]);

  const handleCancel = useCallback(() => {
    if (!confirmLeave()) return;
    armBypass();
    router.replace("/debts");
  }, [armBypass, confirmLeave, router]);

  return (
    <AppShell user={user} isLoggingOut={isLoggingOut} onLogout={handleLogout}>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-700">
            Epic 0006 · Debt Tracker
          </p>
          <h2 className="mt-1 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">
            Edit utang
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
            Perbarui nama, pokok, bunga, atau tenor. Server menolak
            perubahan lewat PATCH setelah status menjadi{" "}
            <span className="font-semibold">paid_off</span> — buka
            halaman detail cicilan untuk menambahkan pembayaran.
          </p>
        </div>
        <button
          type="button"
          className="btn-secondary !w-auto px-4"
          onClick={handleBack}
          aria-label="Kembali ke daftar utang"
          disabled={!isFormActive}
        >
          Kembali
        </button>
      </header>

      {prefetch.kind === "loading" ? (
        <section className="card mt-6" aria-busy="true">
          <DebtFormFieldsSkeleton />
        </section>
      ) : null}

      {prefetch.kind === "not_found" ? (
        <section
          className="card mt-6 border-slate-200 bg-white text-center"
          role="alert"
        >
          <h3 className="text-base font-semibold text-slate-900 sm:text-lg">
            Utang tidak ditemukan
          </h3>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Utang ini tidak ada, sudah dihapus, atau bukan milik akun kamu.
          </p>
          <Link
            href="/debts"
            className="btn-primary mt-4 !w-auto px-5"
            aria-label="Kembali ke daftar utang"
          >
            Kembali ke daftar utang
          </Link>
        </section>
      ) : null}

      {prefetch.kind === "error" ? (
        <section
          className="card mt-6 border-red-200 bg-red-50"
          role="alert"
          aria-live="assertive"
        >
          <h3 className="text-base font-semibold text-red-900">
            Gagal memuat utang
          </h3>
          <p className="mt-2 text-sm leading-6 text-red-800">{prefetch.message}</p>
          <button
            type="button"
            className="btn-primary mt-4 !w-auto px-4"
            onClick={() => void loadDebt()}
          >
            Coba lagi
          </button>
        </section>
      ) : null}

      {prefetch.kind === "ready" ? (
        <section className="card mt-6">
          {isSubmitting ? (
            <DebtSubmitSkeleton />
          ) : (
            <form className="grid gap-5" onSubmit={handleSubmit} noValidate>
              <DebtFormFields
                values={form.values}
                errors={form.errors}
                onChange={form.setValues}
                disabled={!isFormActive}
                idPrefix={`debt-edit-${debtId}`}
              />

              {form.generalError ? (
                <div
                  role="alert"
                  className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
                >
                  {form.generalError}
                </div>
              ) : null}

              {isSuccess ? (
                <div
                  role="status"
                  className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
                >
                  Utang berhasil diperbarui. Mengalihkan ke daftar utang...
                </div>
              ) : null}

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={handleCancel}
                  disabled={!isFormActive}
                >
                  Batal
                </button>
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={!isFormActive}
                  aria-disabled={!isFormActive}
                >
                  {isSubmitting ? "Menyimpan..." : "Simpan perubahan"}
                </button>
              </div>
            </form>
          )}
        </section>
      ) : null}

      <div className="mt-4 text-xs text-slate-500">
        <Link href="/debts" className="text-brand-700 underline-offset-2 hover:underline">
          Lihat daftar utang
        </Link>
      </div>
    </AppShell>
  );
}
