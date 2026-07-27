"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AppShell } from "@/components/shell/app-shell";
import { ActionIcon, NavigationIcon } from "@/components/shell/icons";
import {
  ACCOUNT_TYPE_LABEL,
  fetchAccounts,
  fetchBalances,
  formatIdrFromCents,
  formatIdrFromCentsSigned,
} from "@/lib/api/account-client";
import type { Account, AccountBalance, AccountType } from "@/lib/api/accounts";
import { ApiError } from "@/lib/api/client";
import { useAuth } from "@/lib/auth/auth-context";
import { AuthGuard } from "@/lib/auth/auth-guard";

type LoadStatus = "loading" | "ready" | "error";

interface AccountsPageState {
  status: LoadStatus;
  rows: AccountWithBalance[];
  totalAssetsCents: number;
  totalLiabilitiesCents: number;
  networthCents: number;
  errorMessage: string | null;
  asOf: string | null;
}

const INITIAL_STATE: AccountsPageState = {
  status: "loading",
  rows: [],
  totalAssetsCents: 0,
  totalLiabilitiesCents: 0,
  networthCents: 0,
  errorMessage: null,
  asOf: null,
};

interface AccountWithBalance extends Account {
  balanceCents: number;
  balanceAsOf: string;
}

function joinAccountsWithBalances(
  accounts: Account[],
  balances: AccountBalance[],
): AccountWithBalance[] {
  const balanceById = new Map<string, AccountBalance>();
  for (const balance of balances) {
    balanceById.set(balance.accountId, balance);
  }

  return accounts.map((account) => {
    const balance = balanceById.get(account.id);
    return {
      ...account,
      balanceCents: balance?.balanceCents ?? account.openingBalanceCents,
      balanceAsOf: balance?.asOf ?? "",
    };
  });
}

function partitionRows(rows: AccountWithBalance[]): {
  assets: AccountWithBalance[];
  liabilities: AccountWithBalance[];
} {
  const assets: AccountWithBalance[] = [];
  const liabilities: AccountWithBalance[] = [];
  for (const row of rows) {
    if (row.isAsset) {
      assets.push(row);
    } else {
      liabilities.push(row);
    }
  }
  return { assets, liabilities };
}

function summarizeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return "Sesi kamu sudah berakhir. Masuk lagi untuk memuat daftar akun.";
    }
    return error.message || "Gagal memuat data akun.";
  }
  return "Tidak bisa memuat data akun. Periksa koneksi lalu coba lagi.";
}

function formatAsOf(value: string | null): string {
  if (!value) return "Baru saja";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Baru saja";
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "long",
    timeStyle: "short",
  }).format(date);
}

export default function AccountsPage() {
  return (
    <AuthGuard>
      <AccountsContent />
    </AuthGuard>
  );
}

function AccountsContent() {
  const router = useRouter();
  const { user, logout, isLoading } = useAuth();
  const [state, setState] = useState<AccountsPageState>(INITIAL_STATE);
  const [reloadToken, setReloadToken] = useState<number>(0);

  const load = useCallback(async () => {
    setState((current) => ({ ...current, status: "loading", errorMessage: null }));

    try {
      const [accounts, balances] = await Promise.all([fetchAccounts(), fetchBalances()]);

      if (balances === null) {
        setState({
          status: "error",
          rows: [],
          totalAssetsCents: 0,
          totalLiabilitiesCents: 0,
          networthCents: 0,
          errorMessage: "Respons saldo tidak dikenali. Coba muat ulang.",
          asOf: null,
        });
        return;
      }

      const rows = joinAccountsWithBalances(accounts, balances.accounts);

      setState({
        status: "ready",
        rows,
        totalAssetsCents: balances.totalAssetsCents,
        totalLiabilitiesCents: balances.totalLiabilitiesCents,
        networthCents: balances.networthCents,
        errorMessage: null,
        asOf: balances.accounts[0]?.asOf ?? new Date().toISOString(),
      });
    } catch (error) {
      setState({
        status: "error",
        rows: [],
        totalAssetsCents: 0,
        totalLiabilitiesCents: 0,
        networthCents: 0,
        errorMessage: summarizeError(error),
        asOf: null,
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  const handleLogout = async () => {
    await logout();
    router.replace("/login");
  };

  const handleRetry = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  return (
    <AppShell user={user} isLoggingOut={isLoading} onLogout={handleLogout}>
      <AccountsHeader />

      {state.status === "loading" ? <AccountsSkeleton /> : null}

      {state.status === "error" ? (
        <AccountsError message={state.errorMessage} onRetry={handleRetry} />
      ) : null}

      {state.status === "ready" && state.rows.length === 0 ? <AccountsEmptyState /> : null}

      {state.status === "ready" && state.rows.length > 0 ? (
        <AccountsList state={state} onRetry={handleRetry} />
      ) : null}
    </AppShell>
  );
}

function AccountsHeader() {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-700">
          Epic 0002 · Multi-Account
        </p>
        <h2 className="mt-1 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">
          Daftar akun kamu
        </h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
          Lihat kas, rekening, dompet digital, dan kartu kredit dalam satu layar. Saldo
          mengikuti rumus{" "}
          <span className="font-medium text-slate-700">
            opening + Σ(in) − Σ(out) + Σ(transfer signed)
          </span>
          .
        </p>
      </div>
      <Link
        href="/accounts/new"
        className="btn-primary !w-auto px-4"
        aria-label="Tambah akun"
      >
        Tambah akun
      </Link>
    </header>
  );
}

function AccountsSkeleton() {
  return (
    <div className="mt-6 space-y-6" role="status" aria-live="polite" aria-busy="true">
      <div className="grid gap-3 sm:grid-cols-3">
        <SkeletonTile />
        <SkeletonTile />
        <SkeletonTile />
      </div>
      <SkeletonCard rows={4} />
      <SkeletonCard rows={2} />
      <span className="sr-only">Memuat daftar akun...</span>
    </div>
  );
}

function SkeletonTile() {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="h-3 w-24 animate-pulse rounded bg-slate-200" />
      <div className="mt-3 h-7 w-32 animate-pulse rounded bg-slate-200" />
      <div className="mt-3 h-3 w-20 animate-pulse rounded bg-slate-100" />
    </div>
  );
}

function SkeletonCard({ rows }: { rows: number }) {
  return (
    <div className="card">
      <div className="h-4 w-40 animate-pulse rounded bg-slate-200" />
      <ul className="mt-4 divide-y divide-slate-100">
        {Array.from({ length: rows }).map((_, index) => (
          <li key={index} className="flex items-center gap-3 py-3">
            <div className="h-10 w-10 animate-pulse rounded-full bg-slate-200" />
            <div className="min-w-0 flex-1">
              <div className="h-4 w-40 animate-pulse rounded bg-slate-200" />
              <div className="mt-2 h-3 w-24 animate-pulse rounded bg-slate-100" />
            </div>
            <div className="h-4 w-24 animate-pulse rounded bg-slate-200" />
          </li>
        ))}
      </ul>
    </div>
  );
}

function AccountsError({
  message,
  onRetry,
}: {
  message: string | null;
  onRetry: () => void;
}) {
  const displayMessage = message ?? "Tidak bisa memuat data akun. Coba lagi beberapa saat.";

  return (
    <section
      className="card mt-6 flex flex-col items-start gap-3 border-red-200 bg-red-50"
      role="alert"
      aria-live="assertive"
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100 text-red-700">
        <ActionIcon name="close" className="h-5 w-5" />
      </div>
      <h3 className="text-base font-semibold text-red-900">Gagal memuat akun</h3>
      <p className="text-sm leading-6 text-red-800">{displayMessage}</p>
      <button type="button" className="btn-primary !w-auto px-4" onClick={onRetry}>
        Coba lagi
      </button>
    </section>
  );
}

function AccountsEmptyState() {
  return (
    <section
      className="card mt-6 flex flex-col items-center gap-4 py-10 text-center"
      aria-labelledby="accounts-empty-heading"
    >
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-50 text-brand-700">
        <NavigationIcon name="accounts" className="h-7 w-7" />
      </div>
      <div className="max-w-md">
        <h3
          id="accounts-empty-heading"
          className="text-base font-semibold text-slate-900 sm:text-lg"
        >
          Belum ada akun yang tercatat
        </h3>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Mulai dengan menambahkan akun pertama kamu — misalnya rekening bank atau dompet
          digital — untuk mulai memantau saldo.
        </p>
      </div>
      <Link
        href="/accounts/new"
        className="btn-primary !w-auto px-5"
        aria-label="Tambah akun pertama"
      >
        Tambah akun pertama
      </Link>
    </section>
  );
}

interface AccountsListProps {
  state: AccountsPageState;
  onRetry: () => void;
}

function AccountsList({ state, onRetry }: AccountsListProps) {
  const { assets, liabilities } = useMemo(() => partitionRows(state.rows), [state.rows]);

  return (
    <div className="mt-6 space-y-6">
      <NetworthSummary state={state} onRetry={onRetry} />
      <AccountGroup
        title="Aset"
        description="Kas, bank, dompet digital, investasi, dan lainnya."
        rows={assets}
      />
      <AccountGroup
        title="Liabilitas"
        description="Saldo kartu kredit yang mengurangi networth."
        rows={liabilities}
        emptyMessage="Belum ada liabilitas tercatat."
      />
    </div>
  );
}

interface NetworthSummaryProps {
  state: AccountsPageState;
  onRetry: () => void;
}

function NetworthSummary({ state, onRetry }: NetworthSummaryProps) {
  const networthIsNegative = state.networthCents < 0;
  const networthLabel = formatIdrFromCents(state.networthCents);
  const assetLabel = formatIdrFromCentsSigned(state.totalAssetsCents);
  const liabilityLabel = formatIdrFromCentsSigned(-state.totalLiabilitiesCents);
  const accountCount = state.rows.length;

  return (
    <section className="grid gap-3 sm:grid-cols-3" aria-label="Ringkasan networth">
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:col-span-1">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
          Networth
        </p>
        <p
          className={`mt-3 text-2xl font-bold tracking-tight tabular-nums ${
            networthIsNegative ? "text-rose-700" : "text-slate-950"
          }`}
        >
          {networthLabel}
        </p>
        <p className="mt-2 text-xs leading-5 text-slate-500">
          Diperbarui {formatAsOf(state.asOf)} · {accountCount} akun aktif
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 text-xs font-semibold text-brand-700 hover:text-brand-900 hover:underline focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2"
        >
          Muat ulang
        </button>
      </div>

      <div className="rounded-2xl border border-emerald-200 bg-emerald-50/70 p-5 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
          Total aset
        </p>
        <p className="mt-3 text-2xl font-bold tracking-tight tabular-nums text-emerald-900">
          {assetLabel}
        </p>
        <p className="mt-2 text-xs leading-5 text-emerald-800">
          Aset = saldo akun selain kartu kredit.
        </p>
      </div>

      <div className="rounded-2xl border border-rose-200 bg-rose-50/70 p-5 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-rose-700">
          Total liabilitas
        </p>
        <p className="mt-3 text-2xl font-bold tracking-tight tabular-nums text-rose-900">
          {liabilityLabel}
        </p>
        <p className="mt-2 text-xs leading-5 text-rose-800">
          Liabilitas = saldo kartu kredit (mengurangi networth).
        </p>
      </div>
    </section>
  );
}

interface AccountGroupProps {
  title: string;
  description: string;
  rows: AccountWithBalance[];
  emptyMessage?: string;
}

function AccountGroup({ title, description, rows, emptyMessage }: AccountGroupProps) {
  if (rows.length === 0) {
    if (!emptyMessage) return null;
    return (
      <section className="card" aria-label={`Grup ${title.toLowerCase()}`}>
        <header>
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          <p className="mt-1 text-sm leading-6 text-slate-600">{description}</p>
        </header>
        <p className="mt-4 rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
          {emptyMessage}
        </p>
      </section>
    );
  }

  return (
    <section className="card" aria-label={`Grup ${title.toLowerCase()}`}>
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          <p className="mt-1 text-sm leading-6 text-slate-600">{description}</p>
        </div>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">
          {rows.length} akun
        </span>
      </header>
      <ul className="mt-4 divide-y divide-slate-100">
        {rows.map((row) => (
          <AccountRow key={row.id} row={row} />
        ))}
      </ul>
    </section>
  );
}

function AccountRow({ row }: { row: AccountWithBalance }) {
  const isNegative = row.balanceCents < 0;
  const typeLabel = ACCOUNT_TYPE_LABEL[row.type as AccountType] ?? row.type;
  const initial = (row.name.charAt(0) || "A").toUpperCase();

  return (
    <li className="flex items-center gap-3 py-3">
      <span
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-bold ${
          row.isAsset ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"
        }`}
        aria-hidden="true"
      >
        {initial}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-slate-900" title={row.name}>
          {row.name}
        </p>
        <p className="text-xs text-slate-500">{typeLabel}</p>
      </div>
      <div className="text-right">
        <p
          className={`text-sm font-semibold tabular-nums ${
            isNegative ? "text-rose-700" : "text-slate-900"
          }`}
          aria-label={`Saldo ${row.name}: ${formatIdrFromCents(row.balanceCents)}`}
        >
          {formatIdrFromCents(row.balanceCents)}
        </p>
        <p className="text-xs text-slate-500">{row.currency || "IDR"}</p>
      </div>
    </li>
  );
}
