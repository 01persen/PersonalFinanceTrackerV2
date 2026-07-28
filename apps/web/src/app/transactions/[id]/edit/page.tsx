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
  INITIAL_TRANSACTION_FORM_VALUES,
  TRANSACTION_NOTE_MAX,
  TransactionFormFields,
  isTransactionFormDirty,
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
import {
  fetchTransactionById,
  updateTransaction,
} from "@/lib/api/transaction-client";
import type {
  CreatableTransactionType,
  Transaction,
} from "@/lib/api/transactions";
import { useAuth } from "@/lib/auth/auth-context";
import { AuthGuard } from "@/lib/auth/auth-guard";

const DIRTY_LEAVE_MESSAGE = "Perubahan belum disimpan. Yakin ingin keluar?";

interface PageProps {
  params: { id: string };
}

export default function EditTransactionPage({ params }: PageProps) {
  return (
    <AuthGuard>
      <EditTransactionContent transactionId={params.id} />
    </AuthGuard>
  );
}

type FormPrefetchState =
  | { kind: "loading" }
  | { kind: "ready"; transaction: Transaction; accounts: Account[]; categories: Category[] }
  | { kind: "not_found" }
  | { kind: "error"; message: string };

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success" };

function EditTransactionContent({ transactionId }: { transactionId: string }) {
  const router = useRouter();
  const { user, logout, isLoading: isLoggingOut } = useAuth();

  const initialRef = useRef<TransactionFormValues>(INITIAL_TRANSACTION_FORM_VALUES);
  const [prefetch, setPrefetch] = useState<FormPrefetchState>({ kind: "loading" });
  const [submit, setSubmit] = useState<SubmitState>({ kind: "idle" });

  const form = useTransactionFormState(initialRef.current);

  const isSubmitting = submit.kind === "submitting";
  const isSuccess = submit.kind === "success";
  const isFormActive =
    !isSubmitting && !isSuccess && prefetch.kind === "ready";

  const isDirty = useMemo<boolean>(() => {
    if (!isFormActive) return false;
    return isTransactionFormDirty(form.values, initialRef.current);
  }, [form.values, isFormActive]);

  const { confirmLeave, armBypass } = useDirtyGuard({
    isDirty,
    message: DIRTY_LEAVE_MESSAGE,
    enabled: isFormActive,
  });

  const loadTransaction = useCallback(async () => {
    setPrefetch({ kind: "loading" });
    try {
      const [transaction, accounts, categories] = await Promise.all([
        fetchTransactionById(transactionId),
        fetchAccounts(),
        fetchCategories(),
      ]);
      if (!transaction) {
        setPrefetch({ kind: "not_found" });
        return;
      }
      const activeAccounts = accounts.filter((account) => !account.archived);
      const initial = transactionToFormValues(transaction);
      initialRef.current = initial;
      form.setValues(initial);
      setPrefetch({
        kind: "ready",
        transaction,
        accounts: activeAccounts,
        categories: categories ?? [],
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        setPrefetch({ kind: "not_found" });
        return;
      }
      const message =
        error instanceof ApiError
          ? error.message || "Gagal memuat detail transaksi."
          : "Tidak bisa memuat detail transaksi. Periksa koneksi lalu coba lagi.";
      setPrefetch({ kind: "error", message });
    }
    // We intentionally don't depend on `form.setValues` — the form is set
    // once after load, and further edits are tracked via the form state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactionId]);

  useEffect(() => {
    void loadTransaction();
  }, [loadTransaction]);

  const handleLogout = useCallback(async () => {
    if (!confirmLeave()) return;
    armBypass();
    await logout();
    router.replace("/login");
  }, [armBypass, confirmLeave, logout, router]);

  const persist = useCallback(
    async (values: TransactionFormValues): Promise<void> => {
      const amountValidation = validateAmount(values.amount);
      if (!amountValidation.ok) {
        form.setFieldError("amountCents", amountValidation.reason);
        form.setGeneralError("Periksa kembali isian formulir.");
        return;
      }

      if (!values.accountId) {
        form.setFieldError("accountId", "Pilih akun dulu.");
        form.setGeneralError("Periksa kembali isian formulir.");
        return;
      }

      if (!values.occurredOn) {
        form.setFieldError("occurredOn", "Tanggal wajib diisi.");
        form.setGeneralError("Periksa kembali isian formulir.");
        return;
      }

      if (values.note.length > TRANSACTION_NOTE_MAX) {
        form.setFieldError(
          "note",
          `Catatan maksimal ${TRANSACTION_NOTE_MAX} karakter.`,
        );
        form.setGeneralError("Periksa kembali isian formulir.");
        return;
      }

      setSubmit({ kind: "submitting" });

      try {
        await updateTransaction(transactionId, {
          accountId: values.accountId,
          categoryId: values.categoryId === "" ? null : values.categoryId,
          amountCents: amountValidation.cents,
          occurredOn: values.occurredOn,
          note: values.note.trim() === "" ? null : values.note.trim(),
        });
        setSubmit({ kind: "success" });
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
    [armBypass, form, router, transactionId],
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
    router.replace("/transactions");
  }, [armBypass, confirmLeave, router]);

  const handleCancel = useCallback(() => {
    if (!confirmLeave()) return;
    armBypass();
    router.replace("/transactions");
  }, [armBypass, confirmLeave, router]);

  const amountValidation = validateAmount(form.values.amount);
  const isValid =
    amountValidation.ok &&
    form.values.accountId !== "" &&
    form.values.occurredOn !== "" &&
    form.values.note.length <= TRANSACTION_NOTE_MAX;
  const canSubmit = isFormActive && isValid;

  return (
    <AppShell user={user} isLoggingOut={isLoggingOut} onLogout={handleLogout}>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-700">
            Epic 0003 · Transaction Core
          </p>
          <h2 className="mt-1 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">
            Edit transaksi
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
            Perbarui akun, kategori, nominal, tanggal, atau catatan. Tipe transaksi
            dan pasangan transfer tidak dapat diubah.
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
          <div role="status" aria-live="polite" aria-busy="true">
            <div className="grid grid-cols-2 gap-2 sm:flex sm:gap-3">
              <div className="h-16 animate-pulse rounded-xl bg-slate-100" />
              <div className="h-16 animate-pulse rounded-xl bg-slate-100" />
            </div>
            <div className="mt-5 h-14 animate-pulse rounded-md bg-slate-100" />
            <div className="mt-3 h-14 animate-pulse rounded-md bg-slate-100" />
            <div className="mt-3 h-14 animate-pulse rounded-md bg-slate-100" />
            <div className="mt-3 h-14 animate-pulse rounded-md bg-slate-100" />
            <div className="mt-3 h-24 animate-pulse rounded-md bg-slate-100" />
            <span className="sr-only">Memuat detail transaksi...</span>
          </div>
        </section>
      ) : null}

      {prefetch.kind === "not_found" ? (
        <section className="card mt-6" role="alert">
          <h3 className="text-base font-semibold text-slate-900">
            Transaksi tidak ditemukan
          </h3>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Transaksi ini mungkin sudah dihapus (soft delete) atau bukan milik
            akun kamu.
          </p>
          <Link
            href="/transactions"
            className="btn-primary mt-4 !w-auto px-4"
          >
            Kembali ke daftar
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
            Gagal memuat transaksi
          </h3>
          <p className="mt-2 text-sm leading-6 text-red-800">{prefetch.message}</p>
          <button
            type="button"
            className="btn-primary mt-4 !w-auto px-4"
            onClick={() => void loadTransaction()}
          >
            Coba lagi
          </button>
        </section>
      ) : null}

      {prefetch.kind === "ready" ? (
        <section className="card mt-6">
          {prefetch.transaction.type === "transfer" ? (
            <div
              role="status"
              className="mb-5 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900"
            >
              Transaksi ini bagian dari pasangan transfer. Tipe tidak dapat
              diubah dari form ini.
            </div>
          ) : null}

          <form className="grid gap-5" onSubmit={handleSubmit} noValidate>
            <TransactionFormFields
              values={form.values}
              errors={form.errors}
              onChange={form.setValues}
              accounts={prefetch.accounts}
              categories={prefetch.categories}
              disabled={!isFormActive}
              idPrefix="transaction-edit"
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
                Perubahan berhasil disimpan. Mengalihkan...
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
                {isSubmitting ? "Menyimpan..." : "Simpan perubahan"}
              </button>
            </div>
          </form>
        </section>
      ) : null}
    </AppShell>
  );
}

/**
 * Build the form values from a persisted transaction row. ``type`` is
 * narrowed to the creatable subset when possible; ``transfer`` rows
 * are coerced to ``expense`` so the toggle never shows an invalid
 * state (the toggle itself blocks the value at submit time — see the
 * banner above the form).
 */
function transactionToFormValues(transaction: Transaction): TransactionFormValues {
  const type: CreatableTransactionType =
    transaction.type === "income" || transaction.type === "expense"
      ? (transaction.type as CreatableTransactionType)
      : "expense";

  const cents = Number.isFinite(transaction.amountCents)
    ? transaction.amountCents
    : 0;
  const rupiah = Math.round(cents / 100);

  return {
    type,
    accountId: transaction.accountId,
    categoryId: transaction.categoryId ?? "",
    amount: rupiah === 0 ? "" : rupiah.toString(),
    occurredOn: transaction.occurredOn.slice(0, 10),
    note: transaction.note ?? "",
  };
}