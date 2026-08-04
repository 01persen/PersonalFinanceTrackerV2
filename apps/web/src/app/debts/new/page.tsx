"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { AppShell } from "@/components/shell/app-shell";
import {
  DebtFormFields,
  DebtSubmitSkeleton,
  INITIAL_DEBT_FORM_VALUES,
  isDebtFormDirty,
  todayIsoDate,
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
  createDebt,
  type Debt,
} from "@/lib/api/debt-client";
import { ApiError } from "@/lib/api/client";
import { useAuth } from "@/lib/auth/auth-context";
import { AuthGuard } from "@/lib/auth/auth-guard";

const DIRTY_LEAVE_MESSAGE = "Perubahan belum disimpan. Yakin ingin keluar?";

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; debtId: string };

/**
 * `/debts/new` — create a new debt. Additive over the BE
 * `POST /debts` endpoint (sub-0006-01).
 *
 * State flow:
 *
 *   1. Initial mount — seed the form with today's date and the
 *      `loan` kind (the most common default; user can switch from
 *      the kind dropdown).
 *   2. Submit — clear messages, run the same validators as the
 *      BE schema (`principal_cents > 0`, `bunga_pct >= 0`,
 *      `tenor_months > 0` or `null`), then POST.
 *   3. Success — show a brief "Utang berhasil disimpan" banner,
 *      then `router.replace(/debts)` so the list page re-fetches
 *      with the new row.
 *   4. Error — render the per-field 422 map (via `applyApiError`)
 *      or the general-error banner for non-422 statuses.
 *
 * Out of scope (per sub-0006-05): the payment form (deferred
 * until sub-0006-02 lands) and the history detail (sub-0006-06).
 */

export default function NewDebtPage() {
  return (
    <AuthGuard>
      <NewDebtContent />
    </AuthGuard>
  );
}

function NewDebtContent() {
  const router = useRouter();
  const { user, logout, isLoading: isLoggingOut } = useAuth();

  const initialRef = useRef({
    ...INITIAL_DEBT_FORM_VALUES,
    startDate: todayIsoDate(),
  });

  const form = useDebtFormState(initialRef.current);
  const [submit, setSubmit] = useState<SubmitState>({ kind: "idle" });

  const isSubmitting = submit.kind === "submitting";
  const isSuccess = submit.kind === "success";
  const isFormActive = !isSubmitting && !isSuccess;

  const isDirty = useMemo<boolean>(() => {
    if (!isFormActive) return false;
    return isDebtFormDirty(form.values, initialRef.current);
  }, [form.values, isFormActive]);

  const { confirmLeave, armBypass } = useDirtyGuard({
    isDirty,
    message: DIRTY_LEAVE_MESSAGE,
    enabled: isFormActive,
  });

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

      const startDate = values.startDate === "" ? todayIsoDate() : values.startDate;

      setSubmit({ kind: "submitting" });
      try {
        const created: Debt = await createDebt({
          name,
          kind: values.kind,
          principalCents: principalValidation.cents,
          bungaPct: bungaValidation.value,
          tenorMonths,
          startDate,
          note: values.note.trim() === "" ? null : values.note.trim(),
        });
        setSubmit({ kind: "success", debtId: created.id });
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
    [armBypass, form, router],
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
            Catat utang baru
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
            Isi pokok awal, bunga, dan tenor. Cicilan / bulan dihitung
            otomatis dengan rumus flat-interest yang dipakai BE.
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
              idPrefix="debt-new"
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
                Utang berhasil disimpan. Mengalihkan ke daftar utang...
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
                {isSubmitting ? "Menyimpan..." : "Simpan utang"}
              </button>
            </div>
          </form>
        )}
      </section>

      <p className="mt-4 text-xs text-slate-500">
        Tip: cicilan bulanan dan total bunga dihitung server-side
        (sub-0006-01 + sub-0006-03). FE mengirim input saja — auto-calc
        tidak bisa di-bypass dari formulir ini.
      </p>

      <div className="mt-4 text-xs text-slate-500">
        <Link href="/debts" className="text-brand-700 underline-offset-2 hover:underline">
          Lihat daftar utang
        </Link>
      </div>
    </AppShell>
  );
}
