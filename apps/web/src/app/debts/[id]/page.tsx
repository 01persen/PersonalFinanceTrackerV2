"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { AppShell } from "@/components/shell/app-shell";
import { ActionIcon, NavigationIcon } from "@/components/shell/icons";
import {
  DebtDetailSummaryCard,
  DebtHistoryTable,
} from "@/components/debts/debt-history-table";
import { DebtHistoryPagination } from "@/components/debts/debt-history-pagination";
import { fetchAccounts } from "@/lib/api/account-client";
import type { Account } from "@/lib/api/accounts";
import {
  DEBT_HISTORY_DEFAULT_PAGE_SIZE,
  fetchDebtById,
  fetchDebtPayments,
  fetchDebtSummary,
  formatDebtApiError,
  sortPaymentsByDateDesc,
  type Debt,
  type DebtPayment,
  type DebtPaymentPage,
  type DebtSummary,
} from "@/lib/api/debt-client";
import { ApiError } from "@/lib/api/client";
import { useAuth } from "@/lib/auth/auth-context";
import { AuthGuard } from "@/lib/auth/auth-guard";

interface PageProps {
  params: Promise<{ id: string }>;
}

type PrefetchState =
  | { kind: "loading" }
  | {
      kind: "ready";
      debt: Debt;
      summary: DebtSummary | null;
    }
  | { kind: "not_found" }
  | { kind: "error"; message: string };

type PaymentsState =
  | { kind: "loading" }
  | { kind: "ready"; page: DebtPaymentPage }
  | { kind: "error"; message: string };

/**
 * `/debts/{id}` — read-only debt detail page + cicilan history table
 * (sub-0006-06). Additive over:
 *
 *   - `GET /debts/{id}` (sub-0006-01) — debt header + meta.
 *   - `GET /debts/{id}/summary` (sub-0006-03) — live `remaining` +
 *     `interest_paid` figures for the summary card.
 *   - `GET /debts/{id}/payments?limit=50&offset=...` (sub-0006-02) —
 *     paginated history table (newest first, BE sort chain is
 *     `occurred_on DESC, created_at DESC, id ASC`).
 *
 * State flow:
 *
 *   1. **Prefetch** — three independent fetches in parallel (debt +
 *      summary + first payments page + accounts lookup). A 404 on
 *      the debt surfaces the "Utang tidak ditemukan" panel (the
 *      `_get_owned_debt` helper returns 404 for both "no such debt"
 *      and "owned by another user" — the FE can't tell them apart,
 *      same convention as the other detail pages).
 *   2. **Pagination** — `?page=N` lives in the URL so a back/forward
 *      navigation restores the page; the parent effect bumps the
 *      `page` state via `router.replace` so the URL stays in sync
 *      with the rendered data. The first page is `0` (matches the
 *      BE `offset` semantics).
 *   3. **Refresh after mutation** — when the user returns from
 *      `/debts/{id}/pay` (the cicilan form, sub-0006-05) the URL
 *      changes (e.g. `?refresh=1`). The effect refetches the
 *      payments + summary on every pathname/searchParams change, so
 *      the table re-renders the freshly recorded row. We also
 *      refetch on the `usePathname` / `useSearchParams` flip so a
 *      stale page doesn't outlive the user's intent.
 *   4. **Race defense** — each fetch captures an `AbortController`
 *      and a load id; a newer load drops the prior response. Mirrors
 *      sub-0003-06 / sub-0005-03.
 *
 * UI composition:
 *
 *   - **Header** — page title + breadcrumb back to `/debts` + a
 *     pair of CTAs (catat cicilan for `active` debts, edit always
 *     available). The cicilan CTA is hidden for `paid_off` debts —
 *     the BE rejects payments on a closed debt with 422 (sub-0006-02)
 *     so the UI guard is the friendlier surface for the same rule.
 *   - **Summary card** — `DebtDetailSummaryCard` (subheader, four
 *     live tiles). Renders a skeleton while the `/summary` fetch is
 *     in flight so the user never sees "Rp 0" flash (DEF-1
 *     carry-over from sub-0006-04).
 *   - **History table** — `DebtHistoryTable` for the body;
 *     `DebtHistoryPagination` for the footer. The two pieces are
 *     siblings so the page can change pages without re-rendering
 *     the summary card.
 *   - **Empty / error / not_found / skeleton** — each branch is
 *     its own section so a 5xx on one endpoint doesn't poison the
 *     others (the summary can still render even if the payments
 *     fetch 5xx's).
 *
 * Out of scope (per sub-0006-06): the create / edit / payment forms
 * (sub-0006-05).
 */
export default function DebtDetailPage({ params }: PageProps) {
  const { id } = use(params);
  return (
    <AuthGuard>
      <DebtDetailContent debtId={id} />
    </AuthGuard>
  );
}

function DebtDetailContent({ debtId }: { debtId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { user, logout, isLoading: isLoggingOut } = useAuth();

  const [prefetch, setPrefetch] = useState<PrefetchState>({ kind: "loading" });
  const [payments, setPayments] = useState<PaymentsState>({ kind: "loading" });
  const [accountsById, setAccountsById] = useState<Map<string, Account>>(
    () => new Map(),
  );
  const [page, setPage] = useState<number>(() => parsePageParam(searchParams.get("page")));

  // Race defense — bump a load id per fetch and capture an
  // AbortController so a newer load can drop the prior response
  // mid-flight (mirrors sub-0003-06 / sub-0005-03).
  const prefetchAbortRef = useRef<AbortController | null>(null);
  const paymentsAbortRef = useRef<AbortController | null>(null);
  const accountsAbortRef = useRef<AbortController | null>(null);
  const latestPrefetchLoadIdRef = useRef<number>(0);
  const latestPaymentsLoadIdRef = useRef<number>(0);
  const latestAccountsLoadIdRef = useRef<number>(0);

  // URL sync — push the current `page` into the query string so the
  // view is shareable. Uses `router.replace` so the back button
  // skips pagination churn (same convention as the debt list page).
  const lastPushedPageRef = useRef<number>(page);
  useEffect(() => {
    if (lastPushedPageRef.current === page) return;
    lastPushedPageRef.current = page;
    const params = new URLSearchParams();
    if (page > 0) params.set("page", String(page));
    const qs = params.toString();
    const target = qs.length > 0 ? `${pathname}?${qs}` : pathname;
    router.replace(target, { scroll: false });
  }, [page, pathname, router]);

  // Re-hydrate the page from the URL when the user navigates with
  // the back / forward button (e.g. a fresh `?page=` query).
  useEffect(() => {
    const fromUrl = parsePageParam(searchParams.get("page"));
    setPage((current) => (current === fromUrl ? current : fromUrl));
    // `searchParams` is the only authoritative source here; the page
    // state is the rendered mirror.
     
  }, [searchParams]);

  const loadPrefetch = useCallback(async () => {
    prefetchAbortRef.current?.abort();
    const controller = new AbortController();
    prefetchAbortRef.current = controller;
    const loadId = ++latestPrefetchLoadIdRef.current;
    const dropStale = (): boolean =>
      loadId !== latestPrefetchLoadIdRef.current || controller.signal.aborted;

    setPrefetch({ kind: "loading" });

    try {
      const [debtResult, summaryResult] = await Promise.all([
        fetchDebtById(debtId, { signal: controller.signal }),
        fetchDebtSummary(debtId, { signal: controller.signal }),
      ]);
      if (dropStale()) return;
      if (!debtResult) {
        // 404 — either "no such debt" or "owned by another user".
        // The BE can't tell us which; the FE surfaces a single
        // "Utang tidak ditemukan" panel.
        setPrefetch({ kind: "not_found" });
        return;
      }
      setPrefetch({
        kind: "ready",
        debt: debtResult,
        summary: summaryResult,
      });
    } catch (error) {
      if (dropStale()) return;
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 404) {
        setPrefetch({ kind: "not_found" });
        return;
      }
      setPrefetch({
        kind: "error",
        message: formatDebtApiError(
          error,
          "Tidak bisa memuat utang. Periksa koneksi lalu coba lagi.",
        ),
      });
    }
  }, [debtId]);

  const loadPayments = useCallback(
    async (targetPage: number) => {
      paymentsAbortRef.current?.abort();
      const controller = new AbortController();
      paymentsAbortRef.current = controller;
      const loadId = ++latestPaymentsLoadIdRef.current;
      const dropStale = (): boolean =>
        loadId !== latestPaymentsLoadIdRef.current || controller.signal.aborted;

      setPayments({ kind: "loading" });

      try {
        const result = await fetchDebtPayments(debtId, {
          page: targetPage,
          pageSize: DEBT_HISTORY_DEFAULT_PAGE_SIZE,
          signal: controller.signal,
        });
        if (dropStale()) return;
        if (!result) {
          setPayments({
            kind: "error",
            message: "Respons history cicilan tidak dikenali. Coba lagi beberapa saat.",
          });
          return;
        }
        setPayments({ kind: "ready", page: result });
      } catch (error) {
        if (dropStale()) return;
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 404) {
          // The debt disappeared between the prefetch and the
          // payments fetch (e.g. deleted in another tab). Drop the
          // pending slot without surfacing an error — the parent
          // /debts list will refresh on the next navigation.
          setPayments({ kind: "loading" });
          return;
        }
        setPayments({
          kind: "error",
          message: formatDebtApiError(
            error,
            "Tidak bisa memuat history cicilan. Coba lagi beberapa saat.",
          ),
        });
      }
    },
    [debtId],
  );

  const loadAccounts = useCallback(async () => {
    accountsAbortRef.current?.abort();
    const controller = new AbortController();
    accountsAbortRef.current = controller;
    const loadId = ++latestAccountsLoadIdRef.current;
    const dropStale = (): boolean =>
      loadId !== latestAccountsLoadIdRef.current || controller.signal.aborted;

    try {
      const rows = await fetchAccounts({ signal: controller.signal });
      if (dropStale()) return;
      const map = new Map<string, Account>();
      for (const account of rows) {
        map.set(account.id, account);
      }
      setAccountsById(map);
    } catch {
      // Defensive: a failed accounts lookup shouldn't block the
      // detail page. The source-account column falls back to
      // "Akun tidak ditemukan" via the row component (see
      // `DebtHistoryTable`).
      if (dropStale()) return;
      setAccountsById(new Map());
    }
  }, []);

  // Initial prefetch + payments + accounts fetch (parallel).
  // Re-runs whenever `debtId` changes (i.e. the user navigates
  // between two debt detail pages via the in-app router).
  useEffect(() => {
    void loadPrefetch();
    void loadPayments(page);
    void loadAccounts();
    return () => {
      prefetchAbortRef.current?.abort();
      prefetchAbortRef.current = null;
      paymentsAbortRef.current?.abort();
      paymentsAbortRef.current = null;
      accountsAbortRef.current?.abort();
      accountsAbortRef.current = null;
    };
    // The page state is intentionally not in the dep list — the
    // `page` change effect below refetches the payments when needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debtId, loadPrefetch, loadAccounts]);

  // Refetch payments whenever the user flips pages.
  useEffect(() => {
    void loadPayments(page);
  }, [page, loadPayments]);

  // Refresh after mutation: when the user returns from
  // `/debts/{id}/pay`, the page mounts a fresh instance. To also
  // cover the "back from a child route" case, the search-params
  // flip drives a fresh fetch of the prefetch + payments + summary
  // (the prefetch stays in `ready` so the layout doesn't flash).
  useEffect(() => {
    void loadPrefetch();
    void loadPayments(page);
    // `loadPrefetch` is a stable callback bound to `debtId`; the
    // searchParams flip is the only signal we care about here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const debt = prefetch.kind === "ready" ? prefetch.debt : null;
  const isPaidOff = debt?.status === "paid_off";

  const orderedPayments = useMemo<DebtPayment[]>(() => {
    if (payments.kind !== "ready") return [];
    // Defensive re-sort — the BE already returns newest-first
    // (sub-0006-02), but the helper pins the contract for the unit
    // test and protects the FE if a future migration changes the
    // server-side order.
    return sortPaymentsByDateDesc(payments.page.items);
  }, [payments]);

  const totalPayments =
    payments.kind === "ready" ? payments.page.total : 0;
  const currentPageSize =
    payments.kind === "ready"
      ? payments.page.limit
      : DEBT_HISTORY_DEFAULT_PAGE_SIZE;

  const handlePageChange = useCallback((nextPage: number) => {
    setPage((current) => (current === nextPage ? current : nextPage));
  }, []);

  const handleRetryPrefetch = useCallback(() => {
    void loadPrefetch();
  }, [loadPrefetch]);

  const handleRetryPayments = useCallback(() => {
    void loadPayments(page);
  }, [loadPayments, page]);

  const handleLogout = useCallback(async () => {
    await logout();
    router.replace("/login");
  }, [logout, router]);

  const handleBack = useCallback(() => {
    router.replace("/debts");
  }, [router]);

  return (
    <AppShell user={user} isLoggingOut={isLoggingOut} onLogout={handleLogout}>
      <DebtDetailHeader
        debt={debt}
        onBack={handleBack}
        isLoading={prefetch.kind === "loading"}
      />

      {prefetch.kind === "not_found" ? <DebtNotFound onBack={handleBack} /> : null}

      {prefetch.kind === "error" ? (
        <PrefetchError
          message={prefetch.message}
          onRetry={handleRetryPrefetch}
        />
      ) : null}

      {prefetch.kind === "ready" ? (
        <>
          <DebtDetailSummaryCard
            debt={prefetch.debt}
            summary={prefetch.summary}
            isLoadingSummary={prefetch.summary === null}
            paymentCount={totalPayments}
          />

          <DebtHistorySection
            debt={prefetch.debt}
            payments={orderedPayments}
            paymentsState={payments}
            accountsById={accountsById}
            page={page}
            pageSize={currentPageSize}
            total={totalPayments}
            onPageChange={handlePageChange}
            onRetry={handleRetryPayments}
            isPaidOff={isPaidOff}
          />
        </>
      ) : null}

      {prefetch.kind === "loading" ? <DetailSkeleton /> : null}
    </AppShell>
  );
}

function DebtDetailHeader({
  debt,
  onBack,
  isLoading,
}: {
  debt: Debt | null;
  onBack: () => void;
  isLoading: boolean;
}) {
  const isPaidOff = debt?.status === "paid_off";
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-700">
          Epic 0006 · Debt Tracker
        </p>
        <h2
          className="mt-1 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl"
          data-testid="debt-detail-title"
        >
          {debt ? debt.name : "Detail utang"}
        </h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
          Pantau ringkasan saldo, status lunas, dan history cicilan
          per-baris untuk utang ini. Cicilan diurutkan dari yang
          terbaru.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-secondary !w-auto px-4"
          onClick={onBack}
          aria-label="Kembali ke daftar utang"
        >
          Kembali
        </button>
        {debt && !isPaidOff && !isLoading ? (
          <Link
            href={`/debts/${encodeURIComponent(debt.id)}/pay`}
            className="btn-primary !w-auto px-4"
            aria-label="Catat cicilan baru"
            data-testid="debt-detail-cta-pay"
          >
            + Catat cicilan
          </Link>
        ) : null}
        {debt && !isLoading ? (
          <Link
            href={`/debts/${encodeURIComponent(debt.id)}/edit`}
            className="btn-secondary !w-auto px-4"
            aria-label="Edit utang"
            data-testid="debt-detail-cta-edit"
          >
            Edit
          </Link>
        ) : null}
      </div>
    </header>
  );
}

function DebtNotFound({ onBack }: { onBack: () => void }) {
  return (
    <section
      className="card mt-6 border-slate-200 bg-white text-center"
      role="alert"
      data-testid="debt-detail-not-found"
    >
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-brand-50 text-brand-700">
        <NavigationIcon name="debts" className="h-7 w-7" />
      </div>
      <h3 className="mt-3 text-base font-semibold text-slate-900 sm:text-lg">
        Utang tidak ditemukan
      </h3>
      <p className="mt-2 text-sm leading-6 text-slate-600">
        Utang ini tidak ada, sudah dihapus, atau bukan milik akun kamu.
        Buka daftar utang untuk cek pinjaman yang masih aktif.
      </p>
      <button
        type="button"
        className="btn-primary mt-4 !w-auto px-5"
        onClick={onBack}
        aria-label="Kembali ke daftar utang"
      >
        Kembali ke daftar utang
      </button>
    </section>
  );
}

function PrefetchError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <section
      className="card mt-6 flex flex-col items-start gap-3 border-red-200 bg-red-50"
      role="alert"
      aria-live="assertive"
      data-testid="debt-detail-error"
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100 text-red-700">
        <ActionIcon name="close" className="h-5 w-5" />
      </div>
      <h3 className="text-base font-semibold text-red-900">
        Gagal memuat utang
      </h3>
      <p className="text-sm leading-6 text-red-800">{message}</p>
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

interface DebtHistorySectionProps {
  debt: Debt;
  payments: DebtPayment[];
  paymentsState: PaymentsState;
  accountsById: Map<string, Account>;
  page: number;
  pageSize: number;
  total: number;
  isPaidOff: boolean;
  onPageChange: (nextPage: number) => void;
  onRetry: () => void;
}

/**
 * History section — table + pagination + a non-blocking warning
 * banner for partial failures. Lives in its own component so the
 * page can render the summary card even if the payments fetch 5xx's
 * (the user still sees the debt meta + a retry button on the
 * history side).
 */
function DebtHistorySection({
  debt,
  payments,
  paymentsState,
  accountsById,
  page,
  pageSize,
  total,
  isPaidOff,
  onPageChange,
  onRetry,
}: DebtHistorySectionProps) {
  const isLoading = paymentsState.kind === "loading";
  const isError = paymentsState.kind === "error";
  const errorMessage = paymentsState.kind === "error" ? paymentsState.message : null;

  return (
    <section className="mt-6" data-testid="debt-history-section-wrapper">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold text-slate-900 sm:text-lg">
            History cicilan
          </h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Diurutkan dari cicilan terbaru. {isPaidOff
              ? "Utang ini sudah lunas — history di bawah ini bersifat read-only."
              : "Klik 'Catat cicilan' di pojok kanan atas untuk menambah entri baru."}
          </p>
        </div>
      </header>

      {isError ? (
        <HistoryError message={errorMessage ?? "Gagal memuat history cicilan."} onRetry={onRetry} />
      ) : (
        <DebtHistoryTable
          debt={debt}
          payments={payments}
          isLoading={isLoading}
          accountsById={accountsById}
        />
      )}

      <DebtHistoryPagination
        page={page}
        pageSize={pageSize}
        total={total}
        isLoading={isLoading}
        onPageChange={onPageChange}
      />
    </section>
  );
}

function HistoryError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <section
      className="card mt-4 flex flex-col items-start gap-3 border-red-200 bg-red-50"
      role="alert"
      aria-live="assertive"
      data-testid="debt-history-error"
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100 text-red-700">
        <ActionIcon name="close" className="h-5 w-5" />
      </div>
      <h3 className="text-base font-semibold text-red-900">
        Gagal memuat history cicilan
      </h3>
      <p className="text-sm leading-6 text-red-800">{message}</p>
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

function DetailSkeleton() {
  return (
    <div
      className="mt-6 space-y-4"
      role="status"
      aria-live="polite"
      aria-busy="true"
      data-testid="debt-detail-skeleton"
    >
      <div className="card flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="h-5 w-48 animate-pulse rounded bg-slate-200" />
            <div className="mt-2 h-3 w-32 animate-pulse rounded bg-slate-100" />
          </div>
          <div className="flex gap-1.5">
            <div className="h-6 w-16 animate-pulse rounded-full bg-slate-100" />
            <div className="h-6 w-12 animate-pulse rounded-full bg-slate-100" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="flex flex-col gap-1">
              <div className="h-3 w-16 animate-pulse rounded bg-slate-100" />
              <div className="h-4 w-20 animate-pulse rounded bg-slate-200" />
            </div>
          ))}
        </div>
      </div>
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="h-10 bg-slate-50" />
        {Array.from({ length: 5 }).map((_, index) => (
          <div
            key={index}
            className="flex items-center gap-3 border-t border-slate-100 px-3 py-3"
          >
            <div className="h-3 w-24 animate-pulse rounded bg-slate-200" />
            <div className="ml-auto h-3 w-20 animate-pulse rounded bg-slate-200" />
            <div className="h-3 w-16 animate-pulse rounded bg-slate-100" />
            <div className="h-3 w-16 animate-pulse rounded bg-slate-100" />
            <div className="h-3 w-24 animate-pulse rounded bg-slate-100" />
            <div className="h-3 w-32 animate-pulse rounded bg-slate-100" />
          </div>
        ))}
      </div>
      <span className="sr-only">Memuat detail utang...</span>
    </div>
  );
}

/**
 * Parse the `?page=` query param into a 0-based page index. Bad
 * input (negative / non-integer / out-of-range) falls back to `0` so
 * the URL can never drive the page into a stuck state.
 */
function parsePageParam(raw: string | null): number {
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}
