"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { ActionIcon, NavigationIcon } from "@/components/shell/icons";
import { AppShell } from "@/components/shell/app-shell";
import { TransactionFilters } from "@/components/transactions/transaction-filters";
import { TransactionList } from "@/components/transactions/transaction-list";
import { fetchAccounts } from "@/lib/api/account-client";
import type { Account } from "@/lib/api/accounts";
import { fetchCategories } from "@/lib/api/category-client";
import type { Category } from "@/lib/api/categories";
import { ApiError } from "@/lib/api/client";
import {
  EMPTY_TRANSACTION_FILTERS,
  TRANSACTION_PAGE_SIZE,
  fetchTransactions,
  type TransactionListFilters,
} from "@/lib/api/transaction-client";
import type { Transaction } from "@/lib/api/transactions";
import { useAuth } from "@/lib/auth/auth-context";
import { AuthGuard } from "@/lib/auth/auth-guard";

type LoadStatus = "loading" | "ready" | "error";
type LoadMoreStatus = "idle" | "loading" | "error";

interface TransactionsState {
  status: LoadStatus;
  rows: Transaction[];
  total: number;
  hasMore: boolean;
  errorMessage: string | null;
  loadMoreStatus: LoadMoreStatus;
  loadMoreError: string | null;
}

const INITIAL_STATE: TransactionsState = {
  status: "loading",
  rows: [],
  total: 0,
  hasMore: false,
  errorMessage: null,
  loadMoreStatus: "idle",
  loadMoreError: null,
};

const EMPTY_FILTERS: TransactionListFilters = EMPTY_TRANSACTION_FILTERS;

function summarizeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return "Sesi kamu sudah berakhir. Masuk lagi untuk memuat daftar transaksi.";
    }
    if (error.status === 422) {
      return error.message || "Filter tidak valid. Coba ubah dan muat ulang.";
    }
    if (error.status >= 500) {
      return "Server sedang bermasalah. Coba lagi beberapa saat.";
    }
    return error.message || "Gagal memuat transaksi.";
  }
  return "Tidak bisa memuat transaksi. Periksa koneksi lalu coba lagi.";
}

export default function TransactionsPage() {
  return (
    <AuthGuard>
      <TransactionsContent />
    </AuthGuard>
  );
}

function TransactionsContent() {
  const router = useRouter();
  const { user, logout, isLoading: isLoggingOut } = useAuth();

  const [filters, setFilters] = useState<TransactionListFilters>(EMPTY_FILTERS);
  const [state, setState] = useState<TransactionsState>(INITIAL_STATE);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [lookupStatus, setLookupStatus] = useState<LoadStatus>("loading");
  const [reloadToken, setReloadToken] = useState<number>(0);

  /**
   * Race-condition defenses (mirrors sub-0002-03 Cek 5):
   *   - `latestLoadIdRef` bumps per `load()` call; setState after `await`
   *     only runs when the captured id is still the latest.
   *   - `abortControllerRef` lets each new load cancel the prior request
   *     mid-flight so its `setState` (or setState-after-error) never fires.
   *   - the `useEffect` cleanup aborts any in-flight load on unmount to
   *     silence React 18 strict-mode warnings.
   */
  const latestLoadIdRef = useRef<number>(0);
  const latestLoadMoreIdRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (nextFilters: TransactionListFilters) => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const controller = new AbortController();
      abortControllerRef.current = controller;
      const loadId = ++latestLoadIdRef.current;
      latestLoadMoreIdRef.current = loadId;

      setState((current) => ({
        ...current,
        status: "loading",
        errorMessage: null,
        loadMoreStatus: "idle",
        loadMoreError: null,
      }));

      const dropStale = () =>
        loadId !== latestLoadIdRef.current || controller.signal.aborted;

      try {
        const [accountsResult, categoriesResult, transactionsResult] =
          await Promise.allSettled([
            fetchAccounts({ signal: controller.signal }),
            fetchCategories({ signal: controller.signal }),
            fetchTransactions(nextFilters, { signal: controller.signal }),
          ]);

        if (dropStale()) return;

        let nextAccounts: Account[] = [];
        if (accountsResult.status === "fulfilled") {
          nextAccounts = accountsResult.value;
        } else {
          throw accountsResult.reason;
        }

        let nextCategories: Category[] = [];
        if (categoriesResult.status === "fulfilled") {
          nextCategories = categoriesResult.value ?? [];
        } else {
          throw categoriesResult.reason;
        }

        if (transactionsResult.status !== "fulfilled") {
          throw transactionsResult.reason;
        }

        const page = transactionsResult.value;
        const hasMore = page.offset + page.items.length < page.total;

        setAccounts(nextAccounts);
        setCategories(nextCategories);
        setLookupStatus("ready");

        setState({
          status: "ready",
          rows: page.items,
          total: page.total,
          hasMore,
          errorMessage: null,
          loadMoreStatus: "idle",
          loadMoreError: null,
        });
      } catch (error) {
        if (dropStale()) return;
        if (controller.signal.aborted) return;
        const message = summarizeError(error);
        setState({
          status: "error",
          rows: [],
          total: 0,
          hasMore: false,
          errorMessage: message,
          loadMoreStatus: "idle",
          loadMoreError: null,
        });
      }
    },
    [],
  );

  useEffect(() => {
    void load(filters);
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, [load, filters, reloadToken]);

  const handleFiltersChange = useCallback((nextFilters: TransactionListFilters) => {
    setFilters(nextFilters);
  }, []);

  const handleResetFilters = useCallback(() => {
    setFilters(EMPTY_FILTERS);
  }, []);

  const handleReload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  const handleLoadMore = useCallback(async () => {
    if (state.status !== "ready" || !state.hasMore) return;
    if (state.loadMoreStatus === "loading") return;

    const controller = new AbortController();
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = controller;
    const loadMoreId = ++latestLoadMoreIdRef.current;
    latestLoadIdRef.current = loadMoreId;

    setState((current) => ({
      ...current,
      loadMoreStatus: "loading",
      loadMoreError: null,
    }));

    const nextFilters: TransactionListFilters = {
      ...filters,
      offset: state.rows.length,
      limit: TRANSACTION_PAGE_SIZE,
    };

    try {
      const page = await fetchTransactions(nextFilters, {
        signal: controller.signal,
      });
      if (loadMoreId !== latestLoadMoreIdRef.current) return;
      if (controller.signal.aborted) return;

      const hasMore = page.offset + page.items.length < page.total;
      setState((current) => ({
        ...current,
        rows: [...current.rows, ...page.items],
        total: page.total,
        hasMore,
        loadMoreStatus: "idle",
        loadMoreError: null,
      }));
    } catch (error) {
      if (loadMoreId !== latestLoadMoreIdRef.current) return;
      if (controller.signal.aborted) return;
      const message =
        error instanceof ApiError
          ? error.message || "Gagal memuat halaman berikutnya."
          : "Tidak bisa memuat transaksi berikutnya. Coba lagi.";
      setState((current) => ({
        ...current,
        loadMoreStatus: "error",
        loadMoreError: message,
      }));
    }
  }, [filters, state.rows.length, state.hasMore, state.loadMoreStatus, state.status]);

  const handleLogout = async () => {
    await logout();
    router.replace("/login");
  };

  return (
    <AppShell
      user={user}
      isLoggingOut={isLoggingOut}
      onLogout={handleLogout}
    >
      <TransactionsHeader />

      {lookupStatus === "loading" || state.status === "loading" ? (
        <TransactionsSkeleton />
      ) : null}

      {state.status === "error" ? (
        <TransactionsError
          message={state.errorMessage}
          onRetry={handleReload}
        />
      ) : null}

      {state.status === "ready" ? (
        <div className="mt-6 space-y-6">
          <TransactionFilters
            values={filters}
            accounts={accounts}
            categories={categories}
            onChange={handleFiltersChange}
            onReset={handleResetFilters}
          />

          {state.rows.length === 0 ? (
            <TransactionsEmptyState hasFilters={hasActiveFilters(filters)} />
          ) : (
            <TransactionList
              rows={state.rows}
              accounts={accounts}
              categories={categories}
              total={state.total}
              hasMore={state.hasMore}
              isLoadingMore={state.loadMoreStatus === "loading"}
              onLoadMore={() => void handleLoadMore()}
            />
          )}

          {state.loadMoreStatus === "error" && state.loadMoreError ? (
            <p className="text-xs text-rose-700" role="alert">
              {state.loadMoreError}
            </p>
          ) : null}
        </div>
      ) : null}
    </AppShell>
  );
}

function hasActiveFilters(filters: TransactionListFilters): boolean {
  return Boolean(
    filters.dateFrom ||
      filters.dateTo ||
      filters.accountId ||
      filters.type ||
      filters.categoryId,
  );
}

function TransactionsHeader() {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-700">
          Epic 0003 · Transaction Core
        </p>
        <h2 className="mt-1 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">
          Daftar transaksi
        </h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
          Lihat semua pemasukan, pengeluaran, dan transfer. Filter berdasarkan
          tanggal, akun, tipe, atau kategori — kombinasikan untuk
          mempersempit hasil.
        </p>
      </div>
      <Link
        href="/transactions/new"
        className="btn-primary !w-auto px-4"
        aria-label="Tambah transaksi"
      >
        + Tambah transaksi
      </Link>
    </header>
  );
}

function TransactionsSkeleton() {
  return (
    <div className="mt-6 space-y-6" role="status" aria-live="polite" aria-busy="true">
      <div className="card">
        <div className="h-4 w-32 animate-pulse rounded bg-slate-200" />
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="h-16 animate-pulse rounded bg-slate-100" />
          ))}
        </div>
      </div>
      <div className="card p-0">
        <div className="border-b border-slate-200 px-5 py-4">
          <div className="h-4 w-40 animate-pulse rounded bg-slate-200" />
        </div>
        <ul className="divide-y divide-slate-100">
          {Array.from({ length: 6 }).map((_, index) => (
            <li key={index} className="flex items-center gap-4 px-5 py-4">
              <div className="h-4 w-20 animate-pulse rounded bg-slate-200" />
              <div className="min-w-0 flex-1">
                <div className="h-4 w-32 animate-pulse rounded bg-slate-200" />
                <div className="mt-2 h-3 w-48 animate-pulse rounded bg-slate-100" />
              </div>
              <div className="h-4 w-24 animate-pulse rounded bg-slate-200" />
            </li>
          ))}
        </ul>
      </div>
      <span className="sr-only">Memuat daftar transaksi...</span>
    </div>
  );
}

function TransactionsError({
  message,
  onRetry,
}: {
  message: string | null;
  onRetry: () => void;
}) {
  const displayMessage =
    message ?? "Tidak bisa memuat transaksi. Coba lagi beberapa saat.";

  return (
    <section
      className="card mt-6 flex flex-col items-start gap-3 border-red-200 bg-red-50"
      role="alert"
      aria-live="assertive"
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100 text-red-700">
        <ActionIcon name="close" className="h-5 w-5" />
      </div>
      <h3 className="text-base font-semibold text-red-900">
        Gagal memuat transaksi
      </h3>
      <p className="text-sm leading-6 text-red-800">{displayMessage}</p>
      <button
        type="button"
        className="btn-primary !w-auto px-4"
        onClick={onRetry}
      >
        Coba lagi
      </button>
    </section>
  );
}

function TransactionsEmptyState({ hasFilters }: { hasFilters: boolean }) {
  return (
    <section
      className="card mt-6 flex flex-col items-center gap-4 py-10 text-center"
      aria-labelledby="transactions-empty-heading"
    >
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-50 text-brand-700">
        <NavigationIcon name="transactions" className="h-7 w-7" />
      </div>
      <div className="max-w-md">
        <h3
          id="transactions-empty-heading"
          className="text-base font-semibold text-slate-900 sm:text-lg"
        >
          {hasFilters
            ? "Tidak ada transaksi yang cocok dengan filter ini."
            : "Belum ada transaksi yang tercatat."}
        </h3>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          {hasFilters
            ? "Coba longgarkan filter (mis. hapus kategori atau rentang tanggal) untuk melihat transaksi lainnya."
            : "Mulai catat pemasukan, pengeluaran, atau transfer pertamamu untuk mulai memantau arus kas."}
        </p>
      </div>
      {hasFilters ? null : (
        <Link
          href="/transactions/new"
          className="btn-primary !w-auto px-5"
          aria-label="Tambah transaksi pertama"
        >
          Tambah transaksi pertama
        </Link>
      )}
    </section>
  );
}
