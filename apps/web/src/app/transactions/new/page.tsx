"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { AppShell } from "@/components/shell/app-shell";
import {
  INITIAL_TRANSACTION_FORM_VALUES,
  TRANSACTION_NOTE_MAX,
  TransactionFormFields,
  TransactionFormFieldsSkeleton,
  TransactionSubmitSkeleton,
  isTransactionFormDirty,
  todayIsoDate,
  validateAmount,
  type TransactionFormValues,
} from "@/components/transactions/transaction-form-fields";
import { useTransactionFormState } from "@/components/transactions/transaction-form-state";
import { useDirtyGuard } from "@/components/accounts/use-dirty-guard";
import { fetchAccounts } from "@/lib/api/account-client";
import type { Account } from "@/lib/api/accounts";
import { fetchCategories } from "@/lib/api/category-client";
import type { Category } from "@/lib/api/categories";
import { ApiError } from "@/lib/api/client";
import { createTransaction } from "@/lib/api/transaction-client";
import { useAuth } from "@/lib/auth/auth-context";
import { AuthGuard } from "@/lib/auth/auth-guard";

const DIRTY_LEAVE_MESSAGE = "Perubahan belum disimpan. Yakin ingin keluar?";

type FormPrefetchState =
  | { kind: "loading" }
  | { kind: "ready"; accounts: Account[]; categories: Category[] }
  | { kind: "error"; message: string };

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; transactionId: string };

export default function NewTransactionPage() {
  return (
    <AuthGuard>
      <NewTransactionContent />
    </AuthGuard>
  );
}

function NewTransactionContent() {
  const router = useRouter();
  const { user, logout, isLoading: isLoggingOut } = useAuth();

  const [prefetch, setPrefetch] = useState<FormPrefetchState>({ kind: "loading" });
  const latestLoadIdRef = useRef<number>(0);

  const initialRef = useRef<TransactionFormValues>({
    ...INITIAL_TRANSACTION_FORM_VALUES,
    occurredOn: todayIsoDate(),
  });

  const form = useTransactionFormState(initialRef.current);
  const [submit, setSubmit] = useState<SubmitState>({ kind: "idle" });

  const isSubmitting = submit.kind === "submitting";
  const isSuccess = submit.kind === "success";
  const isFormActive = !isSubmitting && !isSuccess && prefetch.kind === "ready";

  const amountValidation = validateAmount(form.values.amount);
  const isValid =
    amountValidation.ok &&
    form.values.accountId !== "" &&
    form.values.occurredOn !== "" &&
    form.values.note.length <= TRANSACTION_NOTE_MAX;
  const canSubmit = isFormActive && isValid;

  const isDirty = isFormActive && isTransactionFormDirty(form.values, initialRef.current);

  const { confirmLeave, armBypass } = useDirtyGuard({
    isDirty,
    message: DIRTY_LEAVE_MESSAGE,
    enabled: isFormActive,
  });

  const loadFormData = useCallback(async () => {
    const loadId = ++latestLoadIdRef.current;
    setPrefetch({ kind: "loading" });

    try {
      const [accounts, categories] = await Promise.all([
        fetchAccounts(),
        fetchCategories(),
      ]);
      if (loadId !== latestLoadIdRef.current) return;

      const activeAccounts = accounts.filter((account) => !account.archived);
      setPrefetch({
        kind: "ready",
        accounts: activeAccounts,
        categories: categories ?? [],
      });
    } catch (error) {
      if (loadId !== latestLoadIdRef.current) return;
      const message =
        error instanceof ApiError
          ? error.message || "Gagal memuat akun atau kategori."
          : "Tidak bisa memuat formulir. Periksa koneksi lalu coba lagi.";
      setPrefetch({ kind: "error", message });
    }
  }, []);

  useEffect(() => {
    void loadFormData();
  }, [loadFormData]);

  const handleLogout = useCallback(async () => {
    if (!confirmLeave()) return;
    armBypass();
    await logout();
    router.replace("/login");
  }, [armBypass, confirmLeave, logout, router]);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submit.kind === "submitting") return;
      form.clearMessages();

      const amountValidation = validateAmount(form.values.amount);
      if (!amountValidation.ok) {
        form.setFieldError("amountCents", amountValidation.reason);
        form.setGeneralError("Periksa kembali isian formulir.");
        return;
      }

      const accountId = form.values.accountId;
      if (!accountId) {
        form.setFieldError("accountId", "Pilih akun dulu.");
        form.setGeneralError("Periksa kembali isian formulir.");
        return;
      }

      if (!form.values.occurredOn) {
        form.setFieldError("occurredOn", "Tanggal wajib diisi.");
        form.setGeneralError("Periksa kembali isian formulir.");
        return;
      }

      if (form.values.note.length > TRANSACTION_NOTE_MAX) {
        form.setFieldError(
          "note",
          `Catatan maksimal ${TRANSACTION_NOTE_MAX} karakter.`,
        );
        form.setGeneralError("Periksa kembali isian formulir.");
        return;
      }

      setSubmit({ kind: "submitting" });

      try {
        const created = await createTransaction({
          type: form.values.type,
          accountId,
          categoryId: form.values.categoryId === "" ? null : form.values.categoryId,
          amountCents: amountValidation.cents,
          occurredOn: form.values.occurredOn,
          note: form.values.note.trim() === "" ? null : form.values.note.trim(),
        });
        setSubmit({ kind: "success", transactionId: created.id });
        window.setTimeout(() => {
          armBypass();
          router.replace("/transactions");
          router.refresh();
        }, 900);
      } catch (error) {
        setSubmit({ kind: "idle" });
        form.applyApiError(error);
      }
    },
    [armBypass, form, router, submit.kind],
  );

  const handleBack = useCallback(() => {
    if (!confirmLeave()) return;
    armBypass();
    router.replace("/transactions");
  }, [armBypass, confirmLeave, router]);

  const handleCancel = useCallback(() => {
    if (!confirmLeave()) return;
    armBypass();
    router.replace("/transactions");
  }, [armBypass, confirmLeave, router]);

  const hasReadyAccounts =
    prefetch.kind === "ready" && prefetch.accounts.length > 0;

  return (
    <AppShell user={user} isLoggingOut={isLoggingOut} onLogout={handleLogout}>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-700">
            Epic 0003 · Transaction Core
          </p>
          <h2 className="mt-1 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">
            Tambah transaksi
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
            Catat pemasukan atau pengeluaran baru. Nominal lebih dari Rp 0, tanggal
            wajib, dan akun harus milik kamu.
          </p>
        </div>
        <button
          type="button"
          className="btn-secondary !w-auto px-4"
          onClick={handleBack}
          aria-label="Kembali ke daftar transaksi"
          disabled={!isFormActive}
        >
          Kembali
        </button>
      </header>

      {prefetch.kind === "loading" ? (
        <section className="card mt-6" aria-busy="true">
          <TransactionFormFieldsSkeleton />
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
          <p className="mt-2 text-sm leading-6 text-red-800">
            {prefetch.message}
          </p>
          <button
            type="button"
            className="btn-primary mt-4 !w-auto px-4"
            onClick={() => void loadFormData()}
          >
            Coba lagi
          </button>
        </section>
      ) : null}

      {prefetch.kind === "ready" && !hasReadyAccounts ? (
        <section
          className="card mt-6 flex flex-col items-center gap-4 py-10 text-center"
          aria-labelledby="tx-no-account-heading"
        >
          <h3
            id="tx-no-account-heading"
            className="text-base font-semibold text-slate-900 sm:text-lg"
          >
            Belum ada akun aktif
          </h3>
          <p className="max-w-md text-sm leading-6 text-slate-600">
            Transaksi harus dicatat ke akun yang sudah didaftarkan. Tambahkan akun
            dulu, baru kembali ke sini untuk mencatat transaksi.
          </p>
          <Link
            href="/accounts/new"
            className="btn-primary !w-auto px-5"
            aria-label="Tambah akun dulu"
          >
            Tambah akun dulu
          </Link>
        </section>
      ) : null}

      {prefetch.kind === "ready" && hasReadyAccounts ? (
        <section className="card mt-6">
          {isSubmitting ? (
            <TransactionSubmitSkeleton />
          ) : (
            <form className="grid gap-5" onSubmit={handleSubmit} noValidate>
              <TransactionFormFields
                values={form.values}
                errors={form.errors}
                onChange={form.setValues}
                accounts={prefetch.accounts}
                categories={prefetch.categories}
                disabled={!isFormActive}
                idPrefix="transaction-new"
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
                  Transaksi berhasil disimpan. Mengalihkan...
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
                  disabled={!canSubmit}
                  aria-disabled={!canSubmit}
                >
                  {isSubmitting ? "Menyimpan..." : "Simpan transaksi"}
                </button>
              </div>
            </form>
          )}
        </section>
      ) : null}

      <p className="mt-4 text-xs text-slate-500">
        Tip: target ≤ 10 detik untuk catat transaksi baru dari HP — ketuk tipe,
        isi nominal, pilih akun, simpan.
      </p>
    </AppShell>
  );
}