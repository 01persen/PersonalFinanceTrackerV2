"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState, type FormEvent } from "react";

import { AppShell } from "@/components/shell/app-shell";
import { AccountFormFields, INITIAL_ACCOUNT_FORM_VALUES, isFormDirty, validateOpeningBalance } from "@/components/accounts/account-form-fields";
import { ACKNOWLEDGED_FIELDS, useAccountFormState } from "@/components/accounts/account-form-state";
import { useAuth } from "@/lib/auth/auth-context";
import { AuthGuard } from "@/lib/auth/auth-guard";
import { createAccount } from "@/lib/api/account-client";

export default function NewAccountPage() {
  return (
    <AuthGuard>
      <NewAccountContent />
    </AuthGuard>
  );
}

function NewAccountContent() {
  const router = useRouter();
  const { user, logout, isLoading: isLoggingOut } = useAuth();
  const form = useAccountFormState(INITIAL_ACCOUNT_FORM_VALUES);
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: "idle" });

  const handleLogout = useCallback(async () => {
    await logout();
    router.replace("/login");
  }, [logout, router]);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submitState.kind === "submitting") return;

      form.clearMessages();
      const validation = validateOpeningBalance(form.values.openingBalance, form.values.type);
      if (!validation.ok) {
        form.setFieldError("openingBalanceCents", validation.reason);
        form.setGeneralError("Periksa kembali isian formulir.");
        return;
      }

      const name = form.values.name.trim();
      if (name.length === 0) {
        form.setFieldError("name", "Nama akun wajib diisi.");
        form.setGeneralError("Periksa kembali isian formulir.");
        return;
      }
      if (name.length > ACKNOWLEDGED_FIELDS.nameMax) {
        form.setFieldError("name", `Nama akun maksimal ${ACKNOWLEDGED_FIELDS.nameMax} karakter.`);
        form.setGeneralError("Periksa kembali isian formulir.");
        return;
      }

      setSubmitState({ kind: "submitting" });

      try {
        const created = await createAccount({
          name,
          type: form.values.type,
          openingBalanceCents: validation.cents,
        });
        setSubmitState({ kind: "success", accountId: created.id });
        // Small UX grace period — sub-0002-04 (g) says no optimistic UI,
        // so we show the success state briefly before redirecting.
        window.setTimeout(() => {
          router.replace("/accounts");
          router.refresh();
        }, 900);
      } catch (error) {
        setSubmitState({ kind: "idle" });
        form.applyApiError(error);
      }
    },
    [form, router, submitState.kind],
  );

  const handleCancel = useCallback(() => {
    if (isFormDirty(form.values, INITIAL_ACCOUNT_FORM_VALUES)) {
      const confirmLeave = window.confirm("Perubahan belum disimpan. Yakin ingin keluar?");
      if (!confirmLeave) return;
    }
    router.replace("/accounts");
  }, [form.values, router]);

  const isSubmitting = submitState.kind === "submitting";
  const isSuccess = submitState.kind === "success";

  return (
    <AppShell user={user} isLoggingOut={isLoggingOut} onLogout={handleLogout}>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-700">
            Epic 0002 · Multi-Account
          </p>
          <h2 className="mt-1 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">
            Tambah akun
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
            Daftarkan akun baru untuk mulai memantau saldo. Saldo pembuka mengikuti
            rumus saldo total = opening + Σ transaksi.
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

      <section className="card mt-6">
        <form className="grid gap-5" onSubmit={handleSubmit} noValidate>
          <AccountFormFields
            values={form.values}
            errors={form.errors}
            onChange={form.setValues}
            showArchived={false}
            disabled={isSubmitting || isSuccess}
            idPrefix="account-new"
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
              Akun berhasil disimpan. Mengalihkan ke daftar akun...
            </div>
          ) : null}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              className="btn-secondary"
              onClick={handleCancel}
              disabled={isSubmitting || isSuccess}
            >
              Batal
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={isSubmitting || isSuccess}
            >
              {isSubmitting ? "Menyimpan..." : "Simpan akun"}
            </button>
          </div>
        </form>
      </section>

      <p className="mt-4 text-xs text-slate-500">
        Tip: Saldo pembuka untuk kartu kredit boleh negatif (mewakili utang yang
        belum lunas). Aset lain seperti kas dan bank mengikuti aturan minimal Rp 0.
      </p>
    </AppShell>
  );
}

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; accountId: string };
