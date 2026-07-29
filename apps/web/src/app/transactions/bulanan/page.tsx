"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { AppShell } from "@/components/shell/app-shell";
import { ActionIcon } from "@/components/shell/icons";
import { MonthlyEmptyState } from "@/components/transactions/bulanan/monthly-empty-state";
import { MonthlyMonthPicker } from "@/components/transactions/bulanan/monthly-month-picker";
import { MonthlySkeleton } from "@/components/transactions/bulanan/monthly-skeleton";
import { MonthlySummaryHeader } from "@/components/transactions/bulanan/monthly-summary-header";
import { MonthlyTransactionsCards } from "@/components/transactions/bulanan/monthly-transactions-cards";
import { MonthlyTransactionsTable } from "@/components/transactions/bulanan/monthly-transactions-table";
import { groupTransactionsByDate } from "@/components/transactions/bulanan/monthly-grouping";
import { fetchAccounts } from "@/lib/api/account-client";
import type { Account } from "@/lib/api/accounts";
import { fetchCategories } from "@/lib/api/category-client";
import type { Category } from "@/lib/api/categories";
import { ApiError } from "@/lib/api/client";
import {
  EMPTY_TRANSACTION_FILTERS,
  TRANSACTION_PAGE_SIZE,
  fetchTransactions,
} from "@/lib/api/transaction-client";
import type { Transaction } from "@/lib/api/transactions";
import {
  fetchTransactionSummary,
  type TransactionSummary,
} from "@/lib/api/transaction-summary-client";
import { useAuth } from "@/lib/auth/auth-context";
import { AuthGuard } from "@/lib/auth/auth-guard";

type LoadStatus = "loading" | "ready" | "error";

interface MonthlyState {
  status: LoadStatus;
  summary: TransactionSummary | null;
  rows: Transaction[];
  total: number;
  errorMessage: string | null;
}

interface CurrentMonth {
  year: number;
  month: number;
}

const INITIAL_STATE: MonthlyState = {
  status: "loading",
  summary: null,
  rows: [],
  total: 0,
  errorMessage: null,
};

/**
 * Resolve the current calendar month in the runtime's local timezone. We
 * use `new Date()` (not UTC) so the landing month matches the user's
 * local clock — the spec calls for "default landing month = bulan
 * berjalan" and the user's interpretation of "bulan ini" is local.
 */
function getCurrentMonth(): CurrentMonth {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

/**
 * Compute the inclusive `[first, last]` inclusive day bounds of a
 * 1-indexed month in the runtime's local timezone. Returned as ISO
 * `YYYY-MM-DD` strings so they round-trip through the backend query
 * params without timezone drift.
 */
function getMonthBounds(year: number, month: number): { dateFrom: string; dateTo: string } {
  const first = new Date(year, month - 1, 1);
  const last = new Date(year, month, 0);
  const toIso = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };
  return { dateFrom: toIso(first), dateTo: toIso(last) };
}

function summarizeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return "Sesi kamu sudah berakhir. Masuk lagi untuk memuat ringkasan.";
    }
    if (error.status === 422) {
      return error.message || "Bulan yang diminta tidak valid.";
    }
    if (error.status >= 500) {
      return "Server sedang bermasalah. Coba lagi beberapa saat.";
    }
    return error.message || "Gagal memuat ringkasan.";
  }
  return "Tidak bisa memuat ringkasan. Periksa koneksi lalu coba lagi.";
}

export default function MonthlyTransactionsPage() {
  return (
    <AuthGuard>
      <MonthlyTransactionsContent />
    </AuthGuard>
  );
}

function MonthlyTransactionsContent() {
  const router = useRouter();
  const { user, logout, isLoading: isLoggingOut } = useAuth();

  const [currentMonth, setCurrentMonth] = useState<CurrentMonth>(() => getCurrentMonth());
  const [state, setState] = useState<MonthlyState>(INITIAL_STATE);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [lookupStatus, setLookupStatus] = useState<LoadStatus>("loading");

  /**
   * Race defenses (mirrors sub-0003-06):
   *   - `latestLoadIdRef` bumps per `load()` call; the catch/setState
   *     after `await` only fires when the captured id is still current.
   *   - `abortControllerRef` lets each new load cancel the prior request
   *     mid-flight so its `setState` (or error setState) never lands.
   *   - the `useEffect` cleanup aborts on unmount.
   */
  const latestLoadIdRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async (month: CurrentMonth) => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const loadId = ++latestLoadIdRef.current;

    setState((current) => ({
      ...current,
      status: "loading",
      errorMessage: null,
    }));

    const dropStale = () =>
      loadId !== latestLoadIdRef.current || controller.signal.aborted;

    try {
      const { dateFrom, dateTo } = getMonthBounds(month.year, month.month);
      const [accountsResult, categoriesResult, summaryResult, transactionsResult] =
        await Promise.allSettled([
          fetchAccounts({ signal: controller.signal }),
          fetchCategories({ signal: controller.signal }),
          fetchTransactionSummary(month.year, month.month, { signal: controller.signal }),
          fetchTransactions(
            {
              ...EMPTY_TRANSACTION_FILTERS,
              dateFrom,
              dateTo,
              limit: TRANSACTION_PAGE_SIZE,
              offset: 0,
            },
            { signal: controller.signal },
          ),
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

      if (summaryResult.status !== "fulfilled") {
        throw summaryResult.reason;
      }
      const summary = summaryResult.value;

      if (transactionsResult.status !== "fulfilled") {
        throw transactionsResult.reason;
      }
      const transactionsPage = transactionsResult.value;

      setAccounts(nextAccounts);
      setCategories(nextCategories);
      setLookupStatus("ready");

      setState({
        status: "ready",
        summary,
        rows: transactionsPage.items,
        total: transactionsPage.total,
        errorMessage: null,
      });
    } catch (error) {
      if (dropStale()) return;
      if (controller.signal.aborted) return;
      const message = summarizeError(error);
      setState({
        status: "error",
        summary: null,
        rows: [],
        total: 0,
        errorMessage: message,
      });
    }
  }, []);

  useEffect(() => {
    void load(currentMonth);
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, [load, currentMonth]);

  const handleMonthChange = useCallback((next: CurrentMonth) => {
    setCurrentMonth(next);
  }, []);

  const handleRetry = useCallback(() => {
    void load(currentMonth);
  }, [load, currentMonth]);

  const handleLogout = async () => {
    await logout();
    router.replace("/login");
  };

  const groups = groupTransactionsByDate(state.rows, accounts, categories);
  const hasNoTransactions = state.status === "ready" && state.total === 0;
  const now = getCurrentMonth();
  const isCurrentMonth =
    currentMonth.year === now.year && currentMonth.month === now.month;

  return (
    <AppShell
      user={user}
      isLoggingOut={isLoggingOut}
      onLogout={handleLogout}
    >
      <MonthlyHeader />

      <div className="mt-4">
        <MonthlyMonthPicker
          year={currentMonth.year}
          month={currentMonth.month}
          onChange={handleMonthChange}
          isCurrentMonth={isCurrentMonth}
        />
      </div>

      {state.status === "loading" || lookupStatus === "loading" ? (
        <div className="mt-6">
          <MonthlySkeleton />
        </div>
      ) : null}

      {state.status === "error" ? (
        <div className="mt-6">
          <MonthlyError
            message={state.errorMessage}
            onRetry={handleRetry}
          />
        </div>
      ) : null}

      {state.status === "ready" && state.summary ? (
        <div className="mt-6 space-y-6">
          <MonthlySummaryHeader
            summary={state.summary}
            year={currentMonth.year}
            month={currentMonth.month}
          />
          {hasNoTransactions ? (
            <MonthlyEmptyState
              year={currentMonth.year}
              month={currentMonth.month}
            />
          ) : (
            <>
              <MonthlyTransactionsTable groups={groups} />
              <MonthlyTransactionsCards groups={groups} />
              <p className="text-xs text-slate-500">
                Menampilkan {state.rows.length} dari {state.total} transaksi
                di bulan ini.
              </p>
            </>
          )}
        </div>
      ) : null}
    </AppShell>
  );
}

function MonthlyHeader() {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-700">
          Epic 0003 · Transaction Core
        </p>
        <h2 className="mt-1 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">
          Pendapatan &amp; Pengeluaran Bulanan
        </h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
          Lihat transaksi per bulan dalam tampilan mirip spreadsheet, dengan
          ringkasan total pemasukan, pengeluaran, dan selisih. Geser bulan
          untuk membandingkan periode.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href="/transactions"
          className="btn-secondary !w-auto px-4"
        >
          Lihat daftar
        </Link>
        <Link
          href="/transactions/new"
          className="btn-primary !w-auto px-4"
          aria-label="Tambah transaksi"
        >
          + Tambah transaksi
        </Link>
      </div>
    </header>
  );
}

function MonthlyError({
  message,
  onRetry,
}: {
  message: string | null;
  onRetry: () => void;
}) {
  const displayMessage =
    message ?? "Tidak bisa memuat ringkasan. Coba lagi beberapa saat.";
  return (
    <section
      className="card flex flex-col items-start gap-3 border-red-200 bg-red-50"
      role="alert"
      aria-live="assertive"
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100 text-red-700">
        <ActionIcon name="close" className="h-5 w-5" />
      </div>
      <h3 className="text-base font-semibold text-red-900">
        Gagal memuat ringkasan
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
