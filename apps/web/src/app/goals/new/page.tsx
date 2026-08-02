"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
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
  ACKNOWLEDGED_GOAL_FIELDS,
  formatGoalApiError,
  useGoalFormState,
} from "@/components/goals/goal-form-state";
import {
  GoalFormFields,
  GoalFormFieldsSkeleton,
  GoalSubmitSkeleton,
  INITIAL_GOAL_FORM_VALUES,
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
  createGoal,
  DEFAULT_EF_MULTIPLIER_FALLBACK,
  fetchMySettings,
  type Goal,
} from "@/lib/api/goal-client";
import { useAuth } from "@/lib/auth/auth-context";
import { AuthGuard } from "@/lib/auth/auth-guard";

const DIRTY_LEAVE_MESSAGE = "Perubahan belum disimpan. Yakin ingin keluar?";

type FormPrefetchState =
  | { kind: "loading" }
  | {
      kind: "ready";
      accounts: Account[];
      defaultEfMultiplier: number;
    }
  | { kind: "error"; message: string };

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; goalId: string };

export default function NewGoalPage() {
  return (
    <AuthGuard>
      <NewGoalContent />
    </AuthGuard>
  );
}

function NewGoalContent() {
  const router = useRouter();
  const { user, logout, isLoading: isLoggingOut } = useAuth();

  const [prefetch, setPrefetch] = useState<FormPrefetchState>({ kind: "loading" });
  const [settingsMultiplier, setSettingsMultiplier] = useState<number | null>(null);
  const latestLoadIdRef = useRef<number>(0);
  const settingsLoadIdRef = useRef<number>(0);

  const initialRef = useRef<GoalFormValues>({
    ...INITIAL_GOAL_FORM_VALUES,
    startDate: todayIsoDate(),
  });

  const form = useGoalFormState(initialRef.current);
  const [submit, setSubmit] = useState<SubmitState>({ kind: "idle" });

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

  const loadFormData = useCallback(async () => {
    const loadId = ++latestLoadIdRef.current;
    setPrefetch({ kind: "loading" });

    try {
      const accounts = await fetchAccounts();
      if (loadId !== latestLoadIdRef.current) return;

      const activeAccounts = accounts.filter((account) => !account.archived);
      // Resolve the multiplier from the latest settings value (or the
      // seed fallback) — never from a hardcoded `3`. Catatan CI/CD
      // defect: a hardcoded fallback here would clobber the user's
      // setting if `loadSettings` resolved first.
      const resolvedMultiplier =
        settingsMultiplier ?? DEFAULT_EF_MULTIPLIER_FALLBACK;
      setPrefetch({
        kind: "ready",
        accounts: activeAccounts,
        defaultEfMultiplier: resolvedMultiplier,
      });
    } catch (error) {
      if (loadId !== latestLoadIdRef.current) return;
      const message =
        error instanceof ApiError
          ? error.message || "Gagal memuat akun."
          : "Tidak bisa memuat formulir. Periksa koneksi lalu coba lagi.";
      setPrefetch({ kind: "error", message });
    }
  }, [settingsMultiplier]);

  const loadSettings = useCallback(async () => {
    const settingsLoadId = ++settingsLoadIdRef.current;
    try {
      const settings = await fetchMySettings();
      if (settingsLoadId !== settingsLoadIdRef.current) return;
      const next = settings?.efMultiplier ?? DEFAULT_EF_MULTIPLIER_FALLBACK;
      // Always mirror the value into `settingsMultiplier` so a late
      // `loadFormData` can read it when it transitions to ready. The
      // old implementation only updated `prefetch.defaultEfMultiplier`
      // when state was already `ready`, silently dropping the value
      // when settings arrived before accounts — the second race the
      // CI/CD review caught.
      setSettingsMultiplier(next);
      setPrefetch((current) => {
        if (current.kind !== "ready") return current;
        return { ...current, defaultEfMultiplier: next };
      });
    } catch {
      // Non-blocking — keep the seed default; the form is fully usable
      // without a per-user settings row.
    }
  }, []);

  useEffect(() => {
    void loadFormData();
  }, [loadFormData]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  // Prefill the EF multiplier with the per-user default. The gate ref
  // ensures we seed exactly once per (kind, defaultEfMultiplier) tuple
  // so clearing the field by hand doesn't trigger a re-seed, while a
  // fresh saving→EF toggle (which resets the field) — or a settings
  // row arriving after mount — does. Catatan CI/CD defect: sebelumnya
  // multiplier hanya jadi `placeholder`; submit dengan input kosong
  // selalu ditolak `Multiplier wajib diisi.`.
  const multiplierPrefillGateRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isFormActive) return;
    if (form.values.kind !== "emergency_fund") return;
    if (form.values.multiplier !== "") return;
    const gate = `emergency_fund:${defaultEfMultiplier}`;
    if (multiplierPrefillGateRef.current === gate) return;
    multiplierPrefillGateRef.current = gate;
    form.setValues({
      ...form.values,
      multiplier: String(defaultEfMultiplier),
    });
    // We intentionally don't depend on `form` — the gate ref protects
    // against re-fires and we capture the latest values via the
    // closure. The functional form isn't needed since we read
    // `form.values` directly in the dep list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.values.kind, form.values.multiplier, defaultEfMultiplier, isFormActive]);

  const handleLogout = useCallback(async () => {
    if (!confirmLeave()) return;
    armBypass();
    await logout();
    router.replace("/login");
  }, [armBypass, confirmLeave, logout, router]);

  const persist = useCallback(
    async (values: GoalFormValues): Promise<void> => {
      // Name + notes + start-date cross-field checks apply to both
      // kinds. The user-entered `targetAmount` is only relevant for
      // saving goals — the EF form computes the target snapshot from
      // its own inputs (sub-0005-02 mirror in `computeGoalPreview`).
      // Catatan QA defect (sub-0005-04 cek 1): validating
      // `values.targetAmount` before the kind branch blocked every EF
      // submit because the field is empty for EF.
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

      if (values.kind === "saving") {
        const targetValidation = validateTargetAmount(values.targetAmount);
        if (!targetValidation.ok) {
          form.setFieldError("targetAmountCents", targetValidation.reason);
          form.setGeneralError("Periksa kembali isian formulir.");
          return;
        }
        const horizonValidation = validatePositiveInteger(
          values.jangkaWaktuMonths,
          "Jangka waktu",
        );
        if (!horizonValidation.ok) {
          form.setFieldError("jangkaWaktuMonths", horizonValidation.reason);
          form.setGeneralError("Periksa kembali isian formulir.");
          return;
        }
        setSubmit({ kind: "submitting" });
        try {
          const created: Goal = await createGoal({
            kind: values.kind,
            name,
            targetAmountCents: targetValidation.cents,
            startDate,
            targetDate: values.targetDate === "" ? null : values.targetDate,
            jangkaWaktuMonths: horizonValidation.value,
            linkedAccountId:
              values.linkedAccountId === "" ? null : values.linkedAccountId,
            notes: values.notes.trim() === "" ? null : values.notes.trim(),
          });
          setSubmit({ kind: "success", goalId: created.id });
          window.setTimeout(() => {
            armBypass();
            router.replace(`/goals`);
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
        return;
      }

      // Emergency fund branch — `target_amount_cents` is required by the
      // BE schema (`gt=0`) but the FE doesn't render a targetAmount
      // input for EF. We compute it client-side from the EF formula
      // (mirror of sub-0005-02 `compute_ef_target_snapshot_cents`) so
      // the wire value matches what the server will recompute and
      // freeze into `target_amount_snapshot_cents`.
      const monthlyValidation = validateTargetAmount(values.monthlyExpense);
      if (!monthlyValidation.ok) {
        form.setFieldError("monthlyExpenseCents", monthlyValidation.reason);
        form.setGeneralError("Periksa kembali isian formulir.");
        return;
      }
      const tanggunganValidation = validateNonNegativeInteger(
        values.jumlahTanggungan,
        "Jumlah tanggungan",
      );
      if (!tanggunganValidation.ok) {
        form.setFieldError("jumlahTanggungan", tanggunganValidation.reason);
        form.setGeneralError("Periksa kembali isian formulir.");
        return;
      }
      const multiplierValidation = validateMultiplier(
        values.multiplier,
        "Multiplier",
      );
      if (!multiplierValidation.ok) {
        form.setFieldError("multiplier", multiplierValidation.reason);
        form.setGeneralError("Periksa kembali isian formulir.");
        return;
      }

      const efTargetSnapshot =
        monthlyValidation.cents * tanggunganValidation.value * multiplierValidation.value;
      if (efTargetSnapshot <= 0) {
        form.setFieldError(
          "monthlyExpenseCents",
          "Hasil kalkulasi dana darurat harus lebih dari Rp 0.",
        );
        form.setGeneralError("Periksa kembali isian formulir.");
        return;
      }

      setSubmit({ kind: "submitting" });
      try {
        const created: Goal = await createGoal({
          kind: values.kind,
          name,
          targetAmountCents: efTargetSnapshot,
          startDate,
          monthlyExpenseCents: monthlyValidation.cents,
          jumlahTanggungan: tanggunganValidation.value,
          multiplier: multiplierValidation.value,
          notes: values.notes.trim() === "" ? null : values.notes.trim(),
        });
        setSubmit({ kind: "success", goalId: created.id });
        window.setTimeout(() => {
          armBypass();
          router.replace(`/goals`);
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
            Tambah goal
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
            Pilih tipe goal (saving atau dana darurat), isi target, lalu simpan.
            Pratinjau real-time mengikuti rumus yang dipakai server.
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

      {prefetch.kind === "error" ? (
        <section
          className="card mt-6 border-red-200 bg-red-50"
          role="alert"
          aria-live="assertive"
        >
          <h3 className="text-base font-semibold text-red-900">
            Gagal memuat formulir
          </h3>
          <p className="mt-2 text-sm leading-6 text-red-800">{prefetch.message}</p>
          <button
            type="button"
            className="btn-primary mt-4 !w-auto px-4"
            onClick={() => void loadFormData()}
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
                disabled={!isFormActive}
                idPrefix="goal-new"
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
                  Goal berhasil disimpan. Mengalihkan ke daftar goal...
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
                  {isSubmitting ? "Menyimpan..." : "Simpan goal"}
                </button>
              </div>
            </form>
          )}
        </section>
      ) : null}

      <p className="mt-4 text-xs text-slate-500">
        Tip: tabungan bulanan dan snapshot dana darurat dihitung server-side
        (sub-0005-02). FE mengirim input saja; auto-calc tidak bisa di-bypass
        dari formulir ini.
      </p>

      <div className="mt-4 text-xs text-slate-500">
        <Link href="/goals" className="text-brand-700 underline-offset-2 hover:underline">
          Lihat daftar goal
        </Link>
      </div>
    </AppShell>
  );
}