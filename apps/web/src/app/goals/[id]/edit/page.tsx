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
  ACKNOWLEDGED_GOAL_FIELDS,
  formatGoalApiError,
  useGoalFormState,
} from "@/components/goals/goal-form-state";
import {
  GoalFormFields,
  GoalFormFieldsSkeleton,
  GoalSubmitSkeleton,
  INITIAL_GOAL_FORM_VALUES,
  goalToFormValues,
  isGoalFormDirty,
  todayIsoDate,
  validateMultiplier,
  validateNonNegativeInteger,
  validatePositiveInteger,
  validateTargetAmount,
  validateTargetDateAgainstStart,
  type GoalFormValues,
} from "@/components/goals/goal-form-fields";
import { useDirtyGuard } from "@/components/accounts/use-dirty-guard";
import { fetchAccounts } from "@/lib/api/account-client";
import type { Account } from "@/lib/api/accounts";
import { ApiError } from "@/lib/api/client";
import {
  DEFAULT_EF_MULTIPLIER_FALLBACK,
  fetchGoalById,
  fetchMySettings,
  updateGoal,
  type Goal,
} from "@/lib/api/goal-client";
import { useAuth } from "@/lib/auth/auth-context";
import { AuthGuard } from "@/lib/auth/auth-guard";

const DIRTY_LEAVE_MESSAGE = "Perubahan belum disimpan. Yakin ingin keluar?";

interface PageProps {
  params: Promise<{ id: string }>;
}

type FormPrefetchState =
  | { kind: "loading" }
  | {
      kind: "ready";
      goal: Goal;
      accounts: Account[];
      defaultEfMultiplier: number;
    }
  | { kind: "not_found" }
  | { kind: "error"; message: string };

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success" };

export default function EditGoalPage({ params }: PageProps) {
  const { id } = use(params);
  return (
    <AuthGuard>
      <EditGoalContent goalId={id} />
    </AuthGuard>
  );
}

function EditGoalContent({ goalId }: { goalId: string }) {
  const router = useRouter();
  const { user, logout, isLoading: isLoggingOut } = useAuth();

  const initialRef = useRef<GoalFormValues>(INITIAL_GOAL_FORM_VALUES);
  const [prefetch, setPrefetch] = useState<FormPrefetchState>({ kind: "loading" });
  const [submit, setSubmit] = useState<SubmitState>({ kind: "idle" });
  const settingsLoadIdRef = useRef<number>(0);

  const form = useGoalFormState(initialRef.current);

  const isSubmitting = submit.kind === "submitting";
  const isSuccess = submit.kind === "success";
  const isFormActive =
    !isSubmitting && !isSuccess && prefetch.kind === "ready";

  const defaultEfMultiplier = useMemo<number>(() => {
    if (prefetch.kind !== "ready") return DEFAULT_EF_MULTIPLIER_FALLBACK;
    return prefetch.defaultEfMultiplier;
  }, [prefetch]);

  const isDirty = useMemo<boolean>(() => {
    if (!isFormActive) return false;
    return isGoalFormDirty(form.values, initialRef.current);
  }, [form.values, isFormActive]);

  const { confirmLeave, armBypass } = useDirtyGuard({
    isDirty,
    message: DIRTY_LEAVE_MESSAGE,
    enabled: isFormActive,
  });

  const loadGoal = useCallback(async () => {
    setPrefetch({ kind: "loading" });
    try {
      const [goal, accounts] = await Promise.all([
        fetchGoalById(goalId),
        fetchAccounts(),
      ]);
      if (!goal) {
        setPrefetch({ kind: "not_found" });
        return;
      }
      const activeAccounts = accounts.filter((account) => !account.archived);
      const initial = goalToFormValues(goal);
      initialRef.current = initial;
      form.setValues(initial);
      setPrefetch({
        kind: "ready",
        goal,
        accounts: activeAccounts,
        defaultEfMultiplier:
          goal.multiplier !== null
            ? goal.multiplier
            : DEFAULT_EF_MULTIPLIER_FALLBACK,
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        setPrefetch({ kind: "not_found" });
        return;
      }
      const message =
        error instanceof ApiError
          ? error.message || "Gagal memuat detail goal."
          : "Tidak bisa memuat detail goal. Periksa koneksi lalu coba lagi.";
      setPrefetch({ kind: "error", message });
    }
    // We intentionally don't depend on `form.setValues` — the form is
    // set once after load, and further edits are tracked via the form
    // state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goalId]);

  const loadSettings = useCallback(async () => {
    const loadId = ++settingsLoadIdRef.current;
    try {
      const settings = await fetchMySettings();
      if (loadId !== settingsLoadIdRef.current) return;
      const next = settings?.efMultiplier ?? DEFAULT_EF_MULTIPLIER_FALLBACK;
      setPrefetch((current) => {
        if (current.kind !== "ready") return current;
        // Don't clobber the multiplier we already derived from the
        // persisted goal — the user typed (or accepted) that value
        // deliberately. Only fall back to the user settings when the
        // goal has no multiplier set.
        if (current.goal.multiplier !== null) return current;
        return { ...current, defaultEfMultiplier: next };
      });
    } catch {
      // Non-blocking.
    }
  }, []);

  useEffect(() => {
    void loadGoal();
  }, [loadGoal]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const handleLogout = useCallback(async () => {
    if (!confirmLeave()) return;
    armBypass();
    await logout();
    router.replace("/login");
  }, [armBypass, confirmLeave, logout, router]);

  const persist = useCallback(
    async (values: GoalFormValues): Promise<void> => {
      // `targetAmount` only matters for saving goals — the EF form
      // computes its own snapshot from monthly × tanggungan ×
      // multiplier (mirror of sub-0005-02). Catatan QA defect
      // (sub-0005-04 cek 1): validating `values.targetAmount` before
      // the kind branch blocked every EF submit.
      const name = values.name.trim();
      if (name.length === 0) {
        form.setFieldError("name", "Nama goal wajib diisi.");
        form.setGeneralError("Periksa kembali isian formulir.");
        return;
      }
      if (name.length > ACKNOWLEDGED_GOAL_FIELDS.nameMax) {
        form.setFieldError(
          "name",
          `Nama goal maksimal ${ACKNOWLEDGED_GOAL_FIELDS.nameMax} karakter.`,
        );
        form.setGeneralError("Periksa kembali isian formulir.");
        return;
      }

      const startDate = values.startDate === "" ? todayIsoDate() : values.startDate;
      const crossFieldError = validateTargetDateAgainstStart(
        values.targetDate,
        startDate,
      );
      if (crossFieldError !== null) {
        form.setFieldError("targetDate", crossFieldError);
        form.setGeneralError("Periksa kembali isian formulir.");
        return;
      }

      if (values.notes.length > ACKNOWLEDGED_GOAL_FIELDS.noteMax) {
        form.setFieldError(
          "notes",
          `Catatan maksimal ${ACKNOWLEDGED_GOAL_FIELDS.noteMax} karakter.`,
        );
        form.setGeneralError("Periksa kembali isian formulir.");
        return;
      }

      setSubmit({ kind: "submitting" });

      try {
        if (values.kind === "saving") {
          const targetValidation = validateTargetAmount(values.targetAmount);
          if (!targetValidation.ok) {
            setSubmit({ kind: "idle" });
            form.setFieldError("targetAmountCents", targetValidation.reason);
            form.setGeneralError("Periksa kembali isian formulir.");
            return;
          }
          const horizonValidation = validatePositiveInteger(
            values.jangkaWaktuMonths,
            "Jangka waktu",
          );
          if (!horizonValidation.ok) {
            setSubmit({ kind: "idle" });
            form.setFieldError("jangkaWaktuMonths", horizonValidation.reason);
            form.setGeneralError("Periksa kembali isian formulir.");
            return;
          }
          await updateGoal(goalId, {
            name,
            targetAmountCents: targetValidation.cents,
            startDate,
            targetDate: values.targetDate === "" ? null : values.targetDate,
            jangkaWaktuMonths: horizonValidation.value,
            linkedAccountId:
              values.linkedAccountId === "" ? null : values.linkedAccountId,
            notes: values.notes.trim() === "" ? null : values.notes.trim(),
          });
        } else {
          const monthlyValidation = validateTargetAmount(values.monthlyExpense);
          if (!monthlyValidation.ok) {
            setSubmit({ kind: "idle" });
            form.setFieldError("monthlyExpenseCents", monthlyValidation.reason);
            form.setGeneralError("Periksa kembali isian formulir.");
            return;
          }
          const tanggunganValidation = validateNonNegativeInteger(
            values.jumlahTanggungan,
            "Jumlah tanggungan",
          );
          if (!tanggunganValidation.ok) {
            setSubmit({ kind: "idle" });
            form.setFieldError("jumlahTanggungan", tanggunganValidation.reason);
            form.setGeneralError("Periksa kembali isian formulir.");
            return;
          }
          const multiplierValidation = validateMultiplier(
            values.multiplier,
            "Multiplier",
          );
          if (!multiplierValidation.ok) {
            setSubmit({ kind: "idle" });
            form.setFieldError("multiplier", multiplierValidation.reason);
            form.setGeneralError("Periksa kembali isian formulir.");
            return;
          }
          // EF `target_amount_cents` is required by BE schema (`gt=0`)
          // even though the BE freezes its own snapshot into
          // `target_amount_snapshot_cents` (TL decision, PRD §14).
          // We send the snapshot so the wire value matches what the
          // server recomputes — the PATCH path intentionally does NOT
          // re-derive `target_amount_snapshot_cents` so any drift
          // between FE and BE on this field would surface as a
          // visible mismatch in the persisted goal row.
          const efTargetSnapshot =
            monthlyValidation.cents * tanggunganValidation.value * multiplierValidation.value;
          if (efTargetSnapshot <= 0) {
            setSubmit({ kind: "idle" });
            form.setFieldError(
              "monthlyExpenseCents",
              "Hasil kalkulasi dana darurat harus lebih dari Rp 0.",
            );
            form.setGeneralError("Periksa kembali isian formulir.");
            return;
          }
          await updateGoal(goalId, {
            name,
            targetAmountCents: efTargetSnapshot,
            startDate,
            monthlyExpenseCents: monthlyValidation.cents,
            jumlahTanggungan: tanggunganValidation.value,
            multiplier: multiplierValidation.value,
            notes: values.notes.trim() === "" ? null : values.notes.trim(),
          });
        }

        setSubmit({ kind: "success" });
        window.setTimeout(() => {
          armBypass();
          router.replace("/goals");
          router.refresh();
        }, 900);
      } catch (error) {
        setSubmit({ kind: "idle" });
        if (error instanceof ApiError) {
          form.applyApiError(error);
        } else {
          form.setGeneralError(formatGoalApiError(error));
        }
      }
    },
    [armBypass, form, goalId, router],
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
    router.replace("/goals");
  }, [armBypass, confirmLeave, router]);

  const handleCancel = useCallback(() => {
    if (!confirmLeave()) return;
    armBypass();
    router.replace("/goals");
  }, [armBypass, confirmLeave, router]);

  return (
    <AppShell user={user} isLoggingOut={isLoggingOut} onLogout={handleLogout}>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-700">
            Epic 0005 · Goal Trackers
          </p>
          <h2 className="mt-1 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">
            Edit goal
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
            Perbarui nama, target, atau input spesifik tipe. Tipe goal dikunci
            setelah dibuat (server menolak perubahan lewat PATCH).
          </p>
        </div>
        <button
          type="button"
          className="btn-secondary !w-auto px-4"
          onClick={handleBack}
          aria-label="Kembali ke daftar goal"
          disabled={!isFormActive}
        >
          Kembali
        </button>
      </header>

      {prefetch.kind === "loading" ? (
        <section className="card mt-6" aria-busy="true">
          <GoalFormFieldsSkeleton />
        </section>
      ) : null}

      {prefetch.kind === "not_found" ? (
        <section
          className="card mt-6 border-slate-200 bg-white text-center"
          role="alert"
        >
          <h3 className="text-base font-semibold text-slate-900 sm:text-lg">
            Goal tidak ditemukan
          </h3>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Goal ini tidak ada, sudah diarsipkan, atau bukan milik akun kamu.
          </p>
          <Link
            href="/goals"
            className="btn-primary mt-4 !w-auto px-5"
            aria-label="Kembali ke daftar goal"
          >
            Kembali ke daftar goal
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
            Gagal memuat goal
          </h3>
          <p className="mt-2 text-sm leading-6 text-red-800">{prefetch.message}</p>
          <button
            type="button"
            className="btn-primary mt-4 !w-auto px-4"
            onClick={() => void loadGoal()}
          >
            Coba lagi
          </button>
        </section>
      ) : null}

      {prefetch.kind === "ready" ? (
        <section className="card mt-6">
          {isSubmitting ? (
            <GoalSubmitSkeleton />
          ) : (
            <form className="grid gap-5" onSubmit={handleSubmit} noValidate>
              <GoalFormFields
                values={form.values}
                errors={form.errors}
                onChange={form.setValues}
                accounts={prefetch.accounts}
                defaultEfMultiplier={defaultEfMultiplier}
                kindLocked
                disabled={!isFormActive}
                idPrefix={`goal-edit-${goalId}`}
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
                  Goal berhasil diperbarui. Mengalihkan ke daftar goal...
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

      <p className="mt-4 text-xs text-slate-500">
        Tip: snapshot dana darurat di-freeze saat create (PRD §14). Patch
        hanya mengubah input — FE tidak mengirim ulang snapshot.
      </p>
    </AppShell>
  );
}