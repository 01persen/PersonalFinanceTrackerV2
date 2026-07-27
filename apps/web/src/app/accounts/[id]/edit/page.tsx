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
import { AccountFormFields, isFormDirty, validateOpeningBalance, type AccountFormValues } from "@/components/accounts/account-form-fields";
import { ConfirmDialog } from "@/components/accounts/confirm-dialog";
import { ACKNOWLEDGED_FIELDS, useAccountFormState } from "@/components/accounts/account-form-state";
import { useAuth } from "@/lib/auth/auth-context";
import { AuthGuard } from "@/lib/auth/auth-guard";
import { fetchAccountById, updateAccount } from "@/lib/api/account-client";
import type { Account } from "@/lib/api/accounts";
import { ApiError } from "@/lib/api/client";

interface PageProps {
  params: { id: string };
}

export default function EditAccountPage({ params }: PageProps) {
  return (
    <AuthGuard>
      <EditAccountContent accountId={params.id} />
    </AuthGuard>
  );
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; account: Account }
  | { kind: "not_found" }
  | { kind: "error"; message: string };

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success" };

function EditAccountContent({ accountId }: { accountId: string }) {
  const router = useRouter();
  const { user, logout, isLoading: isLoggingOut } = useAuth();
  const form = useAccountFormState({
    name: "",
    type: "cash",
    openingBalance: "0",
    archived: false,
  });
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [submit, setSubmit] = useState<SubmitState>({ kind: "idle" });
  const [pendingArchive, setPendingArchive] = useState<boolean | null>(null);
  const [showArchiveConfirm, setShowArchiveConfirm] = useState<boolean>(false);
  const [unarchiveDialog, setUnarchiveDialog] = useState<boolean>(false);
  const initialRef = useRef<AccountFormValues | null>(null);

  const loadAccount = useCallback(async () => {
    if (!accountId) {
      setLoad({ kind: "not_found" });
      return;
    }
    setLoad({ kind: "loading" });
    try {
      const account = await fetchAccountById(accountId);
      if (!account) {
        setLoad({ kind: "not_found" });
        return;
      }
      const initial: AccountFormValues = {
        name: account.name,
        type: account.type,
        openingBalance: centsToRupiahInput(account.openingBalanceCents),
        archived: account.archived,
      };
      initialRef.current = initial;
      form.setValues(initial);
      setLoad({ kind: "ready", account });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        setLoad({ kind: "not_found" });
        return;
      }
      const message =
        error instanceof ApiError
          ? error.message || "Gagal memuat detail akun."
          : "Tidak bisa memuat detail akun. Periksa koneksi lalu coba lagi.";
      setLoad({ kind: "error", message });
    }
    // We intentionally don't depend on `form.setValues` — the form is set
    // once after load, and further edits are tracked via the form state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  useEffect(() => {
    void loadAccount();
  }, [loadAccount]);

  const handleLogout = useCallback(async () => {
    await logout();
    router.replace("/login");
  }, [logout, router]);

  const persist = useCallback(
    async (values: AccountFormValues): Promise<{ ok: true } | { ok: false }> => {
      const validation = validateOpeningBalance(values.openingBalance, values.type);
      if (!validation.ok) {
        form.setFieldError("openingBalanceCents", validation.reason);
        form.setGeneralError("Periksa kembali isian formulir.");
        return { ok: false };
      }

      const name = values.name.trim();
      if (name.length === 0) {
        form.setFieldError("name", "Nama akun wajib diisi.");
        form.setGeneralError("Periksa kembali isian formulir.");
        return { ok: false };
      }
      if (name.length > ACKNOWLEDGED_FIELDS.nameMax) {
        form.setFieldError("name", `Nama akun maksimal ${ACKNOWLEDGED_FIELDS.nameMax} karakter.`);
        form.setGeneralError("Periksa kembali isian formulir.");
        return { ok: false };
      }

      setSubmit({ kind: "submitting" });

      try {
        await updateAccount(accountId, {
          name,
          type: values.type,
          openingBalanceCents: validation.cents,
          archived: values.archived,
        });
        setSubmit({ kind: "success" });
        window.setTimeout(() => {
          router.replace("/accounts");
          router.refresh();
        }, 900);
        return { ok: true };
      } catch (error) {
        setSubmit({ kind: "idle" });
        form.applyApiError(error);
        return { ok: false };
      }
    },
    [accountId, form, router],
  );

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submit.kind === "submitting") return;
      form.clearMessages();

      // Archive toggle guard: if the user flipped the archive flag, ask
      // for confirmation before we touch the backend. We persist the
      // local checkbox state but wait for the dialog before submitting.
      if (initialRef.current && form.values.archived !== initialRef.current.archived) {
        if (form.values.archived) {
          setPendingArchive(true);
          setShowArchiveConfirm(true);
          return;
        }
        setUnarchiveDialog(true);
        return;
      }

      await persist(form.values);
    },
    [form, persist, submit.kind],
  );

  const handleArchiveConfirm = useCallback(async () => {
    setShowArchiveConfirm(false);
    if (pendingArchive === null) return;
    const next: AccountFormValues = { ...form.values, archived: pendingArchive };
    await persist(next);
    setPendingArchive(null);
  }, [form.values, pendingArchive, persist]);

  const handleArchiveCancel = useCallback(() => {
    setShowArchiveConfirm(false);
    // Revert the local checkbox back to the initial state.
    if (initialRef.current) {
      form.setValues({
        ...form.values,
        archived: initialRef.current.archived,
      });
    }
    setPendingArchive(null);
  }, [form]);

  const handleUnarchiveConfirm = useCallback(() => {
    setUnarchiveDialog(false);
    void persist({
      ...form.values,
      archived: false,
    });
  }, [form.values, persist]);

  const handleUnarchiveCancel = useCallback(() => {
    setUnarchiveDialog(false);
    if (initialRef.current) {
      form.setValues({
        ...form.values,
        archived: initialRef.current.archived,
      });
    }
  }, [form]);

  const handleCancel = useCallback(() => {
    const initial = initialRef.current;
    if (initial && isFormDirty(form.values, initial)) {
      const confirmLeave = window.confirm("Perubahan belum disimpan. Yakin ingin keluar?");
      if (!confirmLeave) return;
    }
    router.replace("/accounts");
  }, [form.values, router]);

  const wantsArchive = initialRef.current
    ? form.values.archived !== initialRef.current.archived && form.values.archived
    : false;

  return (
    <AppShell user={user} isLoggingOut={isLoggingOut} onLogout={handleLogout}>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-700">
            Epic 0002 · Multi-Account
          </p>
          <h2 className="mt-1 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">
            Edit akun
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
            Perbarui nama, tipe, saldo pembuka, atau status arsip. Saldo berjalan
            dihitung ulang di backend.
          </p>
        </div>
        <Link
          href="/accounts"
          className="btn-secondary !w-auto px-4"
          aria-label="Kembali ke daftar akun"
        >
          Kembali
        </Link>
      </header>

      {load.kind === "loading" ? (
        <section className="card mt-6" role="status" aria-live="polite">
          <div className="h-5 w-40 animate-pulse rounded bg-slate-200" />
          <div className="mt-4 h-10 w-full animate-pulse rounded bg-slate-100" />
          <div className="mt-3 h-10 w-full animate-pulse rounded bg-slate-100" />
          <div className="mt-3 h-10 w-full animate-pulse rounded bg-slate-100" />
          <span className="sr-only">Memuat detail akun...</span>
        </section>
      ) : null}

      {load.kind === "not_found" ? (
        <section className="card mt-6" role="alert">
          <h3 className="text-base font-semibold text-slate-900">Akun tidak ditemukan</h3>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Akun ini mungkin sudah dihapus atau tidak принадлежит akun kamu. Kembali ke
            daftar untuk memilih akun lain.
          </p>
          <Link href="/accounts" className="btn-primary mt-4 !w-auto px-4">
            Kembali ke daftar
          </Link>
        </section>
      ) : null}

      {load.kind === "error" ? (
        <section
          className="card mt-6 border-red-200 bg-red-50"
          role="alert"
          aria-live="assertive"
        >
          <h3 className="text-base font-semibold text-red-900">Gagal memuat akun</h3>
          <p className="mt-2 text-sm leading-6 text-red-800">{load.message}</p>
          <button
            type="button"
            className="btn-primary mt-4 !w-auto px-4"
            onClick={() => void loadAccount()}
          >
            Coba lagi
          </button>
        </section>
      ) : null}

      {load.kind === "ready" ? (
        <section className="card mt-6">
          <form className="grid gap-5" onSubmit={handleSubmit} noValidate>
            <AccountFormFields
              values={form.values}
              errors={form.errors}
              onChange={form.setValues}
              showArchived={true}
              disabled={submit.kind === "submitting" || submit.kind === "success"}
              idPrefix="account-edit"
            />

            {form.generalError ? (
              <div
                role="alert"
                className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
              >
                {form.generalError}
              </div>
            ) : null}

            {wantsArchive ? (
              <p
                className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
                role="status"
              >
                Kamu akan mengarsipkan akun ini. Klik Simpan dan konfirmasi untuk
                menyembunyikan dari daftar aktif.
              </p>
            ) : null}

            {submit.kind === "success" ? (
              <div
                role="status"
                className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
              >
                Perubahan berhasil disimpan. Mengalihkan ke daftar akun...
              </div>
            ) : null}

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                className="btn-secondary"
                onClick={handleCancel}
                disabled={submit.kind === "submitting" || submit.kind === "success"}
              >
                Batal
              </button>
              <button
                type="submit"
                className="btn-primary"
                disabled={submit.kind === "submitting" || submit.kind === "success"}
              >
                {submit.kind === "submitting" ? "Menyimpan..." : "Simpan perubahan"}
              </button>
            </div>
          </form>
        </section>
      ) : null}

      <ConfirmDialog
        open={showArchiveConfirm}
        title="Arsipkan akun ini?"
        description={
          <span>
            Akun <strong>{form.values.name || "tanpa nama"}</strong> akan disembunyikan
            dari daftar aktif. Riwayat transaksi tetap tersimpan untuk laporan dan
            kalkulator networth.
          </span>
        }
        confirmLabel="Ya, arsipkan"
        destructive={true}
        busy={submit.kind === "submitting"}
        onConfirm={() => void handleArchiveConfirm()}
        onCancel={handleArchiveCancel}
      />

      <ConfirmDialog
        open={unarchiveDialog}
        title="Aktifkan kembali akun ini?"
        description={
          <span>
            Akun <strong>{form.values.name || "tanpa nama"}</strong> akan muncul
            lagi di daftar aktif dan ikut dihitung dalam networth.
          </span>
        }
        confirmLabel="Aktifkan"
        destructive={false}
        busy={submit.kind === "submitting"}
        onConfirm={() => void handleUnarchiveConfirm()}
        onCancel={handleUnarchiveCancel}
      />
    </AppShell>
  );
}

function centsToRupiahInput(cents: number): string {
  if (!Number.isFinite(cents)) return "0";
  const rupiah = cents / 100;
  if (Number.isInteger(rupiah)) return rupiah.toString();
  return rupiah.toString();
}
