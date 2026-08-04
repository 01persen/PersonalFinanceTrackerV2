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
  PaymentFormFields,
  PaymentFormFieldsSkeleton,
  PaymentSubmitSkeleton,
  computeDefaultSplit,
  initialPaymentFormValuesForCreate,
  isPaymentFormDirty,
  validatePaymentAmount,
  validatePortionCents,
  validatePortionsSum,
} from "@/components/debts/payment-form-fields";
import {
  formatDebtFormApiError,
  usePaymentFormState,
} from "@/components/debts/payment-form-state";
import { useDirtyGuard } from "@/components/accounts/use-dirty-guard";
import { fetchAccounts } from "@/lib/api/account-client";
import type { Account } from "@/lib/api/accounts";
import {
  createDebtPayment,
  fetchDebtById,
  fetchDebtSummary,
  formatDebtIdrAmountOnly,
  type Debt,
  type DebtPayment,
  type DebtSummary,
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
  | {
      kind: "ready";
      debt: Debt;
      summary: DebtSummary | null;
      accounts: Account[];
    }
  | { kind: "not_found" }
  | { kind: "error"; message: string };

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; paymentId: string };

/**
 * `/debts/{id}/pay` — record a cicilan (payment) for a debt. Additive
 * over the BE `POST /debts/{debt_id}/payments` endpoint (sub-0006-02).
 *
 * State flow:
 *
 *   1. Prefetch — load the debt by id + the latest summary (so the
 *      form can show the remaining principal + overpayment guard) +
 *      the caller's active accounts (for the source-account selector).
 *      404 surfaces a "Utang tidak ditemukan" panel with a back link.
 *   2. Auto-split — when the debt has a `monthly_payment_cents` and
 *      a known `bunga_pct`, the form offers a "Bagi otomatis" button
 *      that fills in principal + interest portions to match the
 *      monthly payment. The user can still override the fields
 *      manually.
 *   3. Submit — clear messages, run validators (BE invariants:
 *      `principal + interest == amount`, `principal > 0`,
 *      `principal <= remaining`), then POST. The endpoint rejects
 *      payments on a `paid_off` debt with 422, so the form is gated
 *      at the UI layer too ("paid-off notice" + disabled inputs).
 *   4. Success — show a brief banner then `router.replace(/debts)`
 *      so the list page re-fetches and the ringkasan reflects the
 *      new payment.
 *
 * Concurrency / double-submit guard:
 *
 *   - `submit.kind === "submitting"` disables the submit button and
 *     the form fields via `isFormActive`.
 *   - The validator flow runs synchronously before the POST so the
 *     user can't submit twice while the first request is in flight
 *     (the second submit would find the form disabled and bail out
 *     with no side effect).
 *   - The overpayment guard checks against the *current* summary
 *     (loaded at mount). A new payment that brings the principal
 *     to exactly zero is allowed (the BE auto-flips the debt to
 *     `paid_off` on the next round-trip).
 *
 * Out of scope (per sub-0006-05): payment edit / delete (sub-0006-06
 * history detail) and the cicilan list (sub-0006-06).
 */

export default function NewPaymentPage({ params }: PageProps) {
  const { id } = use(params);
  return (
    <AuthGuard>
      <NewPaymentContent debtId={id} />
    </AuthGuard>
  );
}

function NewPaymentContent({ debtId }: { debtId: string }) {
  const router = useRouter();
  const { user, logout, isLoading: isLoggingOut } = useAuth();

  const initialRef = useRef<import("@/components/debts/payment-form-fields").PaymentFormValues>(
    initialPaymentFormValuesForCreate(),
  );
  const [prefetch, setPrefetch] = useState<FormPrefetchState>({ kind: "loading" });
  const [submit, setSubmit] = useState<SubmitState>({ kind: "idle" });

  const form = usePaymentFormState(initialRef.current);

  const isSubmitting = submit.kind === "submitting";
  const isSuccess = submit.kind === "success";
  const isFormActive =
    !isSubmitting && !isSuccess && prefetch.kind === "ready";

  const debt = prefetch.kind === "ready" ? prefetch.debt : null;
  const summary = prefetch.kind === "ready" ? prefetch.summary : null;
  const accounts = prefetch.kind === "ready" ? prefetch.accounts : [];
  const isPaidOff = debt?.status === "paid_off";

  const isDirty = useMemo<boolean>(() => {
    if (!isFormActive) return false;
    return isPaymentFormDirty(form.values, initialRef.current);
  }, [form.values, isFormActive]);

  const { confirmLeave, armBypass } = useDirtyGuard({
    isDirty,
    message: DIRTY_LEAVE_MESSAGE,
    enabled: isFormActive,
  });

  const loadFormData = useCallback(async () => {
    setPrefetch({ kind: "loading" });
    try {
      const [debtResult, accountsResult] = await Promise.all([
        fetchDebtById(debtId),
        fetchAccounts(),
      ]);
      if (!debtResult) {
        setPrefetch({ kind: "not_found" });
        return;
      }
      const summaryResult = await fetchDebtSummary(debtId);
      const activeAccounts = accountsResult.filter((account) => !account.archived);
      setPrefetch({
        kind: "ready",
        debt: debtResult,
        summary: summaryResult,
        accounts: activeAccounts,
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        setPrefetch({ kind: "not_found" });
        return;
      }
      const message =
        error instanceof ApiError
          ? error.message || "Gagal memuat utang."
          : "Tidak bisa memuat formulir. Periksa koneksi lalu coba lagi.";
      setPrefetch({ kind: "error", message });
    }
  }, [debtId]);

  useEffect(() => {
    void loadFormData();
  }, [loadFormData]);

  const handleLogout = useCallback(async () => {
    if (!confirmLeave()) return;
    armBypass();
    await logout();
    router.replace("/login");
  }, [armBypass, confirmLeave, logout, router]);

  const handleAutoSplit = useCallback(() => {
    if (!debt) return;
    const currentValues = form.values;
    const amountValidation = validatePaymentAmount(currentValues.amountCents);
    if (!amountValidation.ok) {
      form.setFieldError("amountCents", amountValidation.reason);
      form.setGeneralError("Isi nominal cicilan dulu sebelum pakai bagi otomatis.");
      return;
    }

    const defaultSplit = computeDefaultSplit({
      monthlyPaymentCents: debt.monthlyPaymentCents,
      bungaPct: debt.bungaPct,
      tenorMonths: debt.tenorMonths,
    });

    if (defaultSplit === null) {
      // No schedule — fall back to the "all principal" convention so a
      // user paying down a tenorless debt (revolving credit) still
      // gets a sensible default (every rupiah of the payment reduces
      // the principal).
      form.setValues({
        ...currentValues,
        principalPortionCents: currentValues.amountCents,
        interestPortionCents: "0",
      });
      return;
    }

    // If the user's amount differs from the debt's monthly payment,
    // re-derive the split proportionally so the principal + interest
    // still sums to the typed amount.
    const monthly = debt.monthlyPaymentCents ?? 0;
    if (monthly <= 0 || amountValidation.cents === monthly) {
      form.setValues({
        ...currentValues,
        principalPortionCents: String(Math.round(defaultSplit.principalCents / 100)),
        interestPortionCents: String(Math.round(defaultSplit.interestCents / 100)),
      });
      return;
    }
    const scale = amountValidation.cents / monthly;
    const newPrincipal = Math.round(defaultSplit.principalCents * scale);
    const newInterest = amountValidation.cents - newPrincipal;
    form.setValues({
      ...currentValues,
      principalPortionCents: String(Math.round(newPrincipal / 100)),
      interestPortionCents: String(Math.round(newInterest / 100)),
    });
  }, [debt, form]);

  const persist = useCallback(
    async (values: import("@/components/debts/payment-form-fields").PaymentFormValues): Promise<void> => {
      const amountValidation = validatePaymentAmount(values.amountCents);
      if (!amountValidation.ok) {
        form.setFieldError("amountCents", amountValidation.reason);
        form.setGeneralError("Periksa kembali isian formulir.");
        return;
      }

      const principalValidation = validatePortionCents(
        values.principalPortionCents,
        "Bagian pokok",
      );
      if (!principalValidation.ok) {
        form.setFieldError("principalPortionCents", principalValidation.reason);
        form.setGeneralError("Periksa kembali isian formulir.");
        return;
      }

      const interestValidation = validatePortionCents(
        values.interestPortionCents,
        "Bagian bunga",
      );
      if (!interestValidation.ok) {
        form.setFieldError("interestPortionCents", interestValidation.reason);
        form.setGeneralError("Periksa kembali isian formulir.");
        return;
      }

      const sumError = validatePortionsSum(
        amountValidation.cents,
        principalValidation.cents,
        interestValidation.cents,
      );
      if (sumError !== null) {
        form.setFieldError("principalPortionCents", sumError);
        form.setGeneralError("Periksa kembali isian formulir.");
        return;
      }

      // Overpayment guard — mirror `assert_no_overpayment` on the BE
      // (sub-0006-02). Brings the principal to exactly zero is allowed.
      if (summary && principalValidation.cents > summary.remainingPrincipalCents) {
        form.setFieldError(
          "principalPortionCents",
          "Bagian pokok melebihi sisa pokok saat ini.",
        );
        form.setGeneralError(
          "Cicilan ini akan dianggap overpayment — turunkan bagian pokok.",
        );
        return;
      }

      const occurredOn = values.occurredOn === "" ? initialRef.current.occurredOn : values.occurredOn;
      if (occurredOn === "") {
        form.setFieldError("occurredOn", "Tanggal cicilan wajib diisi.");
        form.setGeneralError("Periksa kembali isian formulir.");
        return;
      }

      setSubmit({ kind: "submitting" });
      try {
        const created: DebtPayment = await createDebtPayment(debtId, {
          occurredOn,
          amountCents: amountValidation.cents,
          principalPortionCents: principalValidation.cents,
          interestPortionCents: interestValidation.cents,
          sourceAccountId:
            values.sourceAccountId === "" ? null : values.sourceAccountId,
          note: values.note.trim() === "" ? null : values.note.trim(),
        });
        setSubmit({ kind: "success", paymentId: created.id });
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
    [armBypass, debtId, form, router, summary],
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
            Catat cicilan
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
            {debt ? (
              <>
                Untuk utang <span className="font-semibold">{debt.name}</span>.
                {" "}
                {summary && summary.remainingPrincipalCents > 0
                  ? "Sisa pokok saat ini "
                  : "Cicilan terakhir — "}
                {summary && (
                  <span className="font-semibold">
                    Rp {formatDebtIdrAmountOnly(summary.remainingPrincipalCents)}
                  </span>
                )}
                .
              </>
            ) : (
              "Pilih nominal cicilan, lalu isi bagian pokok + bagian bunga."
            )}
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
          <PaymentFormFieldsSkeleton />
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
            Gagal memuat formulir cicilan
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
            <PaymentSubmitSkeleton />
          ) : (
            <form className="grid gap-5" onSubmit={handleSubmit} noValidate>
              <PaymentFormFields
                values={form.values}
                errors={form.errors}
                onChange={form.setValues}
                accounts={accounts}
                onAutoSplit={isPaidOff ? undefined : handleAutoSplit}
                paidOff={isPaidOff}
                disabled={!isFormActive}
                idPrefix={`payment-new-${debtId}`}
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
                  Cicilan berhasil disimpan. Mengalihkan ke daftar utang...
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
                  disabled={!isFormActive || isPaidOff}
                  aria-disabled={!isFormActive || isPaidOff}
                >
                  {isSubmitting ? "Menyimpan..." : "Simpan cicilan"}
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
