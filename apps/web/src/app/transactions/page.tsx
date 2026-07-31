"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { AppShell } from "@/components/shell/app-shell";
import { BottomSheet } from "@/components/shell/bottom-sheet";
import { GlobalSearchBar } from "@/components/shell/global-search-bar";
import { ActionIcon, NavigationIcon } from "@/components/shell/icons";
import { TransactionList } from "@/components/transactions/transaction-list";
import { TransactionSearchFiltersPanel } from "@/components/transactions/transaction-search-filters-panel";
import { fetchAccounts } from "@/lib/api/account-client";
import type { Account } from "@/lib/api/accounts";
import { fetchCategories } from "@/lib/api/category-client";
import type { Category } from "@/lib/api/categories";
import { ApiError } from "@/lib/api/client";
import {
  EMPTY_TRANSACTION_SEARCH_FILTERS,
  type TransactionSearchFilters,
} from "@/lib/api/transaction-client";
import {
  buildTransactionSearchQuery,
  hasActiveTransactionSearchFilters,
  parseTransactionSearchFilters,
} from "@/lib/api/transaction-search-url";
import { useAuth } from "@/lib/auth/auth-context";
import { AuthGuard } from "@/lib/auth/auth-guard";
import { useTransactionsSearch } from "@/lib/hooks/use-transactions-search";

/**
 * `/transactions` — transaction list + global search (sub-0003-06 +
 * sub-0004-05). The page is **additive** over the existing list view:
 * the legacy list endpoint (`GET /transactions`) is reused for the
 * unfiltered fallback so users without any URL filter keep the same
 * experience, while the new `GET /transactions/search` powers any
 * filtered state.
 *
 * State flow:
 *
 *   1. URL ↔ filter state — the canonical state lives in
 *      ``searchFilters`` (mirrored from ``useSearchParams()`` on mount).
 *      Every change pushes the new query string back via
 *      ``router.replace`` so the URL is shareable (AC (3)).
 *   2. Filter state ↔ data — ``useTransactionsSearch`` triggers a fetch
 *      whenever the filter object changes, with race defense identical
 *      to the rest of the FE (sub-0003-06 / sub-0003-07 / sub-0004-04).
 *   3. Lookup data — ``accounts`` and ``categories`` are fetched once
 *      on mount so the filter panel can render the dropdowns without
 *      re-fetching per filter change.
 *
 * UI composition:
 *
 *   - **Header** — global search bar (debounced 300 ms + clear).
 *     Lives inside the app shell's ``searchSlot`` so it stays pinned on
 *     scroll and is reachable on mobile (AC (1) + AC (5)).
 *   - **Filter panel** — desktop side panel (≥ lg) + mobile
 *     bottom-sheet drawer (< lg). Both share the same
 *     ``TransactionSearchFiltersPanel`` so the controls stay in sync
 *     (AC (2) + AC (5)).
 *   - **Result list** — reuses ``TransactionList`` so visual style +
 *     pagination affordances match the rest of the app. When the
 *     search returns 0 rows with an active filter we show the
 *     "tidak cocok dengan filter" empty state; with no filter the
 *     legacy "belum ada transaksi" empty state is shown.
 */

type LookupStatus = "loading" | "ready" | "error";

interface LookupState {
  status: LookupStatus;
  accounts: Account[];
  categories: Category[];
  errorMessage: string | null;
}

const INITIAL_LOOKUP: LookupState = {
  status: "loading",
  accounts: [],
  categories: [],
  errorMessage: null,
};

/**
 * Compare two `TransactionSearchFilters` for equality — used to dedupe
 * URL pushes when the parent effect reruns with the same shape it
 * already committed (e.g. an effect retriggered by an unrelated state
 * change).
 */
function sameSearchFilters(
  a: TransactionSearchFilters,
  b: TransactionSearchFilters,
): boolean {
  return (
    a.q === b.q &&
    a.dateFrom === b.dateFrom &&
    a.dateTo === b.dateTo &&
    a.accountId === b.accountId &&
    a.type === b.type &&
    a.categoryId === b.categoryId &&
    a.amountMinCents === b.amountMinCents &&
    a.amountMaxCents === b.amountMaxCents &&
    a.page === b.page &&
    a.pageSize === b.pageSize
  );
}

function summarizeLookupError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return "Sesi kamu sudah berakhir. Masuk lagi untuk memuat daftar akun dan kategori.";
    }
    if (error.status >= 500) {
      return "Server sedang bermasalah. Coba lagi beberapa saat.";
    }
    return error.message || "Gagal memuat daftar akun dan kategori.";
  }
  return "Tidak bisa memuat daftar akun dan kategori. Periksa koneksi lalu coba lagi.";
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
  const searchParams = useSearchParams();
  const { user, logout, isLoading: isLoggingOut } = useAuth();

  const [searchFilters, setSearchFilters] = useState<TransactionSearchFilters>(
    () => parseTransactionSearchFilters(searchParams),
  );
  const [lookup, setLookup] = useState<LookupState>(INITIAL_LOOKUP);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);

  // Race defense for the lookup fetch (mirrors sub-0003-06).
  const latestLookupIdRef = useRef<number>(0);
  const lookupAbortRef = useRef<AbortController | null>(null);

  // Track the last URL we pushed so the inbound effect (browser
  // back/forward, or a ``router.replace`` from elsewhere) can detect a
  // change in the URL that did NOT originate from this component and
  // resync the filter state. Without this, navigating away and back
  // via the browser would leave the page in a stale-filtered state.
  const lastPushedRef = useRef<string>(searchParams.toString());

  const { state: searchState, retry } =
    useTransactionsSearch(searchFilters);

  const loadLookup = useCallback(async () => {
    lookupAbortRef.current?.abort();
    const controller = new AbortController();
    lookupAbortRef.current = controller;
    const loadId = ++latestLookupIdRef.current;
    const dropStale = (): boolean =>
      loadId !== latestLookupIdRef.current || controller.signal.aborted;

    setLookup((current) => ({ ...current, status: "loading" }));

    try {
      const [accountsResult, categoriesResult] = await Promise.allSettled([
        fetchAccounts({ signal: controller.signal }),
        fetchCategories({ signal: controller.signal, limit: 500 }),
      ]);

      if (dropStale()) return;

      if (accountsResult.status === "rejected") {
        throw accountsResult.reason;
      }
      if (categoriesResult.status === "rejected") {
        throw categoriesResult.reason;
      }

      setLookup({
        status: "ready",
        accounts: accountsResult.value,
        categories: categoriesResult.value ?? [],
        errorMessage: null,
      });
    } catch (error) {
      if (dropStale()) return;
      if (controller.signal.aborted) return;
      setLookup({
        status: "error",
        accounts: [],
        categories: [],
        errorMessage: summarizeLookupError(error),
      });
    }
  }, []);

  useEffect(() => {
    void loadLookup();
    return () => {
      lookupAbortRef.current?.abort();
      lookupAbortRef.current = null;
    };
  }, [loadLookup]);

  // Inbound sync: when ``searchParams`` changes from an external source
  // (browser back/forward, a sibling client component pushing the URL),
  // re-parse and adopt the new filter state. We dedupe by comparing
  // against the last URL we ourselves pushed so we don't loop when our
  // own ``router.replace`` finishes — the URL after our push will match
  // ``lastPushedRef`` and the early-return short-circuits.
  useEffect(() => {
    const current = searchParams.toString();
    if (current === lastPushedRef.current) return;
    lastPushedRef.current = current;
    setSearchFilters(parseTransactionSearchFilters(searchParams));
  }, [searchParams]);

  // Outbound sync: push filter state to the URL whenever it changes
  // (AC (3) — shareable link). We use ``router.replace`` (not ``push``)
  // so each keystroke / filter toggle doesn't pollute the browser
  // history; only an explicit back button leaves the page.
  useEffect(() => {
    const params = buildTransactionSearchQuery(searchFilters);
    const next = params.toString();
    if (next === lastPushedRef.current) return;
    lastPushedRef.current = next;
    const target = next.length > 0 ? `/transactions?${next}` : "/transactions";
    router.replace(target, { scroll: false });
  }, [searchFilters, router]);

  const handleSearchCommit = useCallback((nextQuery: string) => {
    setSearchFilters((current) => {
      if (current.q === nextQuery) return current;
      return { ...current, q: nextQuery, page: 1 };
    });
  }, []);

  const handleFiltersChange = useCallback(
    (nextFilters: TransactionSearchFilters) => {
      setSearchFilters((current) => {
        if (sameSearchFilters(current, nextFilters)) return current;
        // Any filter mutation resets to page 1 so the page counter in
        // the URL matches the result set the user is looking at.
        const pageReset =
          current.page !== 1 &&
          (current.q !== nextFilters.q ||
            current.dateFrom !== nextFilters.dateFrom ||
            current.dateTo !== nextFilters.dateTo ||
            current.accountId !== nextFilters.accountId ||
            current.type !== nextFilters.type ||
            current.categoryId !== nextFilters.categoryId ||
            current.amountMinCents !== nextFilters.amountMinCents ||
            current.amountMaxCents !== nextFilters.amountMaxCents);
        return pageReset ? { ...nextFilters, page: 1 } : nextFilters;
      });
    },
    [],
  );

  const handleResetFilters = useCallback(() => {
    setSearchFilters((current) => ({
      ...EMPTY_TRANSACTION_SEARCH_FILTERS,
      pageSize: current.pageSize,
    }));
  }, []);

  const handleLoadMore = useCallback(() => {
    setSearchFilters((current) => ({ ...current, page: current.page + 1 }));
  }, []);

  const handleOpenFilterSheet = useCallback(() => setFilterSheetOpen(true), []);
  const handleCloseFilterSheet = useCallback(() => setFilterSheetOpen(false), []);

  const handleRetrySearch = useCallback(() => {
    retry();
  }, [retry]);

  const handleRetryLookup = useCallback(() => {
    void loadLookup();
  }, [loadLookup]);

  const handleLogout = async () => {
    await logout();
    router.replace("/login");
  };

  const filterSummary = useMemo(
    () => summarizeActiveFilters(searchFilters),
    [searchFilters],
  );

  const activeFilterCount = filterSummary.length;

  const searchSlot = (
    <GlobalSearchBar
      value={searchFilters.q}
      placeholder="Cari catatan transaksi…"
      onCommit={handleSearchCommit}
    />
  );

  return (
    <AppShell
      user={user}
      isLoggingOut={isLoggingOut}
      onLogout={handleLogout}
      searchSlot={searchSlot}
    >
      <TransactionsHeader
        activeFilterCount={activeFilterCount}
        onOpenFilterSheet={handleOpenFilterSheet}
      />

      {lookup.status === "loading" && searchState.status === "loading" ? (
        <TransactionsSkeleton />
      ) : null}

      {lookup.status === "error" ? (
        <LookupError message={lookup.errorMessage} onRetry={handleRetryLookup} />
      ) : null}

      {lookup.status !== "error" && searchState.status === "error" ? (
        <SearchError
          message={searchState.errorMessage}
          onRetry={handleRetrySearch}
        />
      ) : null}

      {lookup.status !== "error" && searchState.status !== "error" ? (
        <div className="mt-6 grid gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
          <aside className="hidden lg:block">
            <TransactionSearchFiltersPanel
              values={searchFilters}
              accounts={lookup.accounts}
              categories={lookup.categories}
              onChange={handleFiltersChange}
              onReset={handleResetFilters}
            />
          </aside>

          <div className="min-w-0">
            <SearchSummary
              summary={filterSummary}
              total={searchState.total}
              page={searchState.page}
              pageSize={searchState.pageSize}
              loading={searchState.status === "loading"}
            />

            {searchState.rows.length === 0 ? (
              <SearchEmptyState
                loading={searchState.status === "loading"}
                hasFilters={hasActiveTransactionSearchFilters(searchFilters)}
              />
            ) : (
              <TransactionList
                rows={searchState.rows}
                accounts={lookup.accounts}
                categories={lookup.categories}
                total={searchState.total}
                hasMore={searchState.hasMore}
                isLoadingMore={false}
                onLoadMore={() => void handleLoadMore()}
              />
            )}
          </div>
        </div>
      ) : null}

      <BottomSheet
        open={filterSheetOpen}
        title="Filter pencarian"
        description={
          activeFilterCount > 0
            ? `${activeFilterCount} filter aktif`
            : "Saring transaksi berdasarkan tanggal, akun, kategori, tipe, atau nominal."
        }
        onClose={handleCloseFilterSheet}
      >
        <TransactionSearchFiltersPanel
          values={searchFilters}
          accounts={lookup.accounts}
          categories={lookup.categories}
          onChange={handleFiltersChange}
          onReset={handleResetFilters}
          variant="sheet"
          hideHeaderReset
          footer={
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                className="btn-secondary"
                onClick={handleResetFilters}
                disabled={activeFilterCount === 0}
              >
                Reset
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={handleCloseFilterSheet}
              >
                Terapkan
              </button>
            </div>
          }
        />
      </BottomSheet>
    </AppShell>
  );
}

/**
 * Render a short human summary of the active filters (e.g. "12 hasil
 * untuk `makan` · 2026-01-01 → 2026-01-31 · Pengeluaran"). The list
 * view has a tight row counter already; this is the place the user
 * sees what they typed, so the labels match the dropdown names from
 * the filter panel.
 */
function summarizeActiveFilters(
  filters: TransactionSearchFilters,
): string[] {
  const parts: string[] = [];
  if (filters.q.trim()) parts.push(`“${filters.q.trim()}”`);
  if (filters.dateFrom && filters.dateTo) {
    parts.push(`${filters.dateFrom} → ${filters.dateTo}`);
  } else if (filters.dateFrom) {
    parts.push(`sejak ${filters.dateFrom}`);
  } else if (filters.dateTo) {
    parts.push(`sampai ${filters.dateTo}`);
  }
  if (filters.type) {
    parts.push(
      filters.type === "income"
        ? "Pemasukan"
        : filters.type === "expense"
          ? "Pengeluaran"
          : "Transfer",
    );
  }
  if (filters.amountMinCents !== null && filters.amountMaxCents !== null) {
    parts.push(
      `Rp ${idrCompact(filters.amountMinCents)}–${idrCompact(filters.amountMaxCents)}`,
    );
  } else if (filters.amountMinCents !== null) {
    parts.push(`≥ Rp ${idrCompact(filters.amountMinCents)}`);
  } else if (filters.amountMaxCents !== null) {
    parts.push(`≤ Rp ${idrCompact(filters.amountMaxCents)}`);
  }
  return parts;
}

function idrCompact(cents: number): string {
  const whole = Math.trunc(cents / 100);
  return new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 }).format(
    whole,
  );
}

function TransactionsHeader({
  activeFilterCount,
  onOpenFilterSheet,
}: {
  activeFilterCount: number;
  onOpenFilterSheet: () => void;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-700">
          Epic 0003 + 0004 · Transaksi &amp; Pencarian
        </p>
        <h2 className="mt-1 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">
          Daftar transaksi
        </h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
          Cari catatan, saring berdasarkan tanggal / akun / kategori / tipe /
          nominal — atau kombinasi semuanya. URL bisa dishare untuk membuka
          tampilan yang sama di perangkat lain.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-secondary !w-auto px-4 lg:hidden"
          onClick={onOpenFilterSheet}
          aria-label="Buka filter pencarian"
        >
          Filter{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
        </button>
        <Link
          href="/transactions/bulanan"
          className="btn-secondary !w-auto px-4"
        >
          Lihat bulanan
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

function SearchSummary({
  summary,
  total,
  page,
  pageSize,
  loading,
}: {
  summary: string[];
  total: number;
  page: number;
  pageSize: number;
  loading: boolean;
}) {
  const totalPages = pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1;
  return (
    <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2 text-xs text-slate-500">
      <p>
        {total > 0
          ? `${total} hasil · halaman ${page} dari ${totalPages}`
          : loading
            ? "Mencari…"
            : "0 hasil"}
        {summary.length > 0 ? ` · untuk ${summary.join(" · ")}` : null}
      </p>
    </div>
  );
}

function TransactionsSkeleton() {
  return (
    <div
      className="mt-6 grid gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="hidden rounded-xl border border-slate-200 bg-white p-6 shadow-sm lg:block">
        <div className="h-4 w-32 animate-pulse rounded bg-slate-200" />
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="h-12 animate-pulse rounded bg-slate-100" />
          ))}
        </div>
      </div>
      <div className="space-y-4">
        <div className="h-3 w-40 animate-pulse rounded bg-slate-200" />
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
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
      </div>
      <span className="sr-only">Memuat daftar transaksi...</span>
    </div>
  );
}

function LookupError({
  message,
  onRetry,
}: {
  message: string | null;
  onRetry: () => void;
}) {
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
        Gagal memuat daftar akun &amp; kategori
      </h3>
      <p className="text-sm leading-6 text-red-800">
        {message ?? "Tidak bisa memuat daftar akun dan kategori."}
      </p>
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

function SearchError({
  message,
  onRetry,
}: {
  message: string | null;
  onRetry: () => void;
}) {
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
        Gagal mencari transaksi
      </h3>
      <p className="text-sm leading-6 text-red-800">
        {message ?? "Tidak bisa mencari transaksi. Coba lagi beberapa saat."}
      </p>
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

function SearchEmptyState({
  loading,
  hasFilters,
}: {
  loading: boolean;
  hasFilters: boolean;
}) {
  if (loading) {
    return (
      <section
        className="card mt-2 flex items-center justify-center gap-3 py-8 text-sm text-slate-500"
        role="status"
        aria-live="polite"
      >
        <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-brand-100 border-t-brand-600" />
        Mencari transaksi…
      </section>
    );
  }

  return (
    <section
      className="card mt-2 flex flex-col items-center gap-4 py-10 text-center"
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