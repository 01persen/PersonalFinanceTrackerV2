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
import { ActionIcon, NavigationIcon } from "@/components/shell/icons";
import { DebtEmptyState } from "@/components/debts/debt-empty-state";
import {
  DebtKindChips,
  DebtStatusChips,
} from "@/components/debts/debt-filter-chips";
import { DebtList } from "@/components/debts/debt-list";
import { DebtSummaryTiles } from "@/components/debts/debt-summary-tiles";
import {
  aggregateDebtTotals,
  DEBT_KIND_FILTER_VALUES,
  DEBT_KIND_LABEL,
  DEBT_KIND_VALUES,
  fetchDebts,
  fetchDebtSummary,
  formatDebtApiError,
  type Debt,
  type DebtKind,
  type DebtKindFilterValue,
  type DebtSummary,
} from "@/lib/api/debt-client";
import { ApiError } from "@/lib/api/client";
import { useAuth } from "@/lib/auth/auth-context";
import { AuthGuard } from "@/lib/auth/auth-guard";

/**
 * `/debts` — read-only debt list + ringkasan (sub-0006-04). Additive
 * over the BE `GET /debts` endpoint (sub-0006-01), the flat-interest
 * calculator (sub-0006-03), and the per-debt summary endpoint
 * (`GET /debts/{id}/summary`, sub-0006-03).
 *
 * State flow:
 *
 *   1. URL ↔ filter state — both `?status=` and `?kind=` live in the
 *      query string so the URL is shareable (same convention as
 *      sub-0005-03 goals). The kind chip is gated by an explicit
 *      `?kind=`; the page falls back to `all` when the URL has
 *      neither.
 *   2. Filter state ↔ list data — the `loadDebts` effect refetches
 *      whenever *either* filter changes; the status / kind client-side
 *      filter narrows the rendered set inside `DebtList`. The backend
 *      `GET /debts` doesn't accept these filters yet (no pagination
 *      either), so we filter in the browser to keep the URL-driven
 *      shape consistent with `GoalList`.
 *   3. Per-row summaries — a second pass fans out to
 *      `/debts/{id}/summary` for every rendered debt. The
 *      `summariesLoading` flag stays `true` until every fetched row
 *      has either a summary or a settled error so the ringkasan
 *      tiles never show "Rp 0" while summaries are in flight
 *      (sub-0006-04 AC currency / zero / large values).
 *   4. Race defense — bump a load id per fetch and capture an
 *      `AbortController` so a newer load can drop the prior response
 *      mid-flight (mirrors sub-0002-03 Cek 5 + sub-0005-03).
 *
 * UI composition:
 *
 *   - **Header** — page title + CTA stub (form lives in sub-0006-05).
 *   - **Two filter rows** — status chips + kind chips. Both are
 *     mirrored to the URL.
 *   - **Summary tiles** — `DebtSummaryTiles` (sisa saldo, total
 *     pokok, bunga terbayar, cicilan / bulan).
 *   - **List** — `DebtList` renders the rows. Each row shows the
 *     summary-backed remaining + interest-paid figures and a small
 *     pending-state skeleton while the summary fetch is in flight.
 *   - **Empty / error / skeleton states** — mirror the rest of the
 *     dashboard (sub-0003-05/06, sub-0004-04, sub-0005-03).
 *
 * Out of scope (per sub-0006-04): the create / edit form
 * (sub-0006-05) and the per-debt history table (sub-0006-06).
 */

type LoadStatus = "loading" | "ready" | "error";

interface ListState {
  status: LoadStatus;
  rows: Debt[];
  errorMessage: string | null;
}

interface SummaryState {
  status: LoadStatus;
  rows: Map<string, DebtSummary>;
  pendingIds: Set<string>;
  errorMessage: string | null;
}

type StatusFilter = "all" | "active" | "paid_off";

const STATUS_SET: ReadonlySet<string> = new Set(["all", "active", "paid_off"]);
const KIND_SET: ReadonlySet<string> = new Set(DEBT_KIND_FILTER_VALUES);

const INITIAL_LIST: ListState = {
  status: "loading",
  rows: [],
  errorMessage: null,
};

const INITIAL_SUMMARY: SummaryState = {
  status: "loading",
  rows: new Map(),
  pendingIds: new Set(),
  errorMessage: null,
};

function parseStatusParam(raw: string | null): StatusFilter {
  if (!raw) return "all";
  if (STATUS_SET.has(raw)) return raw as StatusFilter;
  return "all";
}

function parseKindParam(raw: string | null): DebtKindFilterValue {
  if (!raw) return "all";
  if (KIND_SET.has(raw)) return raw as DebtKindFilterValue;
  return "all";
}

export default function DebtsPage() {
  return (
    <AuthGuard>
      <DebtsContent />
    </AuthGuard>
  );
}

function DebtsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, logout, isLoading: isLoggingOut } = useAuth();

  const initialStatus = parseStatusParam(searchParams.get("status"));
  const initialKind = parseKindParam(searchParams.get("kind"));
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(initialStatus);
  const [kindFilter, setKindFilter] = useState<DebtKindFilterValue>(initialKind);
  const [list, setList] = useState<ListState>(INITIAL_LIST);
  const [summary, setSummary] = useState<SummaryState>(INITIAL_SUMMARY);

  // Race defense — bump a load id per fetch and capture an
  // AbortController so a newer load can drop the prior response
  // mid-flight (mirrors sub-0003-06 / sub-0005-03).
  const latestListLoadIdRef = useRef<number>(0);
  const listAbortRef = useRef<AbortController | null>(null);
  const summaryAbortRef = useRef<AbortController | null>(null);
  const latestSummaryLoadIdRef = useRef<number>(0);

  const lastPushedStatusRef = useRef<StatusFilter>(initialStatus);
  const lastPushedKindRef = useRef<DebtKindFilterValue>(initialKind);

  const loadList = useCallback(async () => {
    listAbortRef.current?.abort();
    const controller = new AbortController();
    listAbortRef.current = controller;
    const loadId = ++latestListLoadIdRef.current;
    const dropStale = (): boolean =>
      loadId !== latestListLoadIdRef.current || controller.signal.aborted;

    setList((current) => ({ ...current, status: "loading", errorMessage: null }));

    try {
      const rows = await fetchDebts({ signal: controller.signal });
      if (dropStale()) return;
      setList({ status: "ready", rows, errorMessage: null });
    } catch (error) {
      if (dropStale()) return;
      if (controller.signal.aborted) return;
      setList({
        status: "error",
        rows: [],
        errorMessage: formatDebtApiError(
          error,
          "Tidak bisa memuat utang. Periksa koneksi lalu coba lagi.",
        ),
      });
    }
  }, []);

  const loadSummariesFor = useCallback((debts: Debt[]) => {
    if (debts.length === 0) {
      setSummary({
        status: "ready",
        rows: new Map(),
        pendingIds: new Set(),
        errorMessage: null,
      });
      return;
    }

    summaryAbortRef.current?.abort();
    const controller = new AbortController();
    summaryAbortRef.current = controller;
    const loadId = ++latestSummaryLoadIdRef.current;
    const dropStale = (): boolean =>
      loadId !== latestSummaryLoadIdRef.current || controller.signal.aborted;

    const pendingIds = new Set(debts.map((debt) => debt.id));
    setSummary({
      status: "loading",
      rows: new Map(),
      pendingIds,
      errorMessage: null,
    });

    let firstError: string | null = null;
    let settled = 0;

    for (const debt of debts) {
      fetchDebtSummary(debt.id, { signal: controller.signal })
        .then((result) => {
          if (dropStale()) return;
          if (result === null) {
            firstError =
              firstError ??
              "Respons ringkasan utang tidak dikenali. Coba lagi beberapa saat.";
          } else {
            setSummary((current) => {
              const next = new Map(current.rows);
              next.set(debt.id, result);
              const nextPending = new Set(current.pendingIds);
              nextPending.delete(debt.id);
              return {
                ...current,
                rows: next,
                pendingIds: nextPending,
              };
            });
          }
        })
        .catch((error: unknown) => {
          if (dropStale()) return;
          if (controller.signal.aborted) return;
          if (error instanceof ApiError && error.status === 404) {
            // The debt disappeared between the list fetch and the
            // summary fetch (e.g. deleted in another tab). Drop the
            // pending slot without surfacing an error — the list will
            // re-render without this row on the next poll.
            setSummary((current) => {
              const nextPending = new Set(current.pendingIds);
              nextPending.delete(debt.id);
              return { ...current, pendingIds: nextPending };
            });
            return;
          }
          firstError =
            firstError ??
            formatDebtApiError(
              error,
              "Tidak bisa memuat ringkasan utang.",
            );
          setSummary((current) => {
            const nextPending = new Set(current.pendingIds);
            nextPending.delete(debt.id);
            return { ...current, pendingIds: nextPending };
          });
        })
        .finally(() => {
          settled += 1;
          if (settled >= debts.length && !dropStale()) {
            setSummary((current) => ({
              ...current,
              status: current.pendingIds.size === 0 ? "ready" : "error",
              errorMessage: firstError,
            }));
          }
        });
    }
  }, []);

  // Initial list fetch + filter-driven refetch (the BE doesn't accept
  // these filters yet, but we keep the same shape so Stage 4+ can
  // swap the client-side filter for a query-string backend filter).
  useEffect(() => {
    void loadList();
    return () => {
      listAbortRef.current?.abort();
      listAbortRef.current = null;
    };
  }, [loadList]);

  useEffect(() => {
    return () => {
      summaryAbortRef.current?.abort();
      summaryAbortRef.current = null;
    };
  }, []);

  // Whenever the list settles to `ready`, fan out the per-row
  // summary fetches. Re-runs whenever the underlying `rows` change
  // (filter changes produce a new `list.rows` identity because the
  // setter above builds a fresh array).
  useEffect(() => {
    if (list.status === "ready") {
      loadSummariesFor(list.rows);
    }
  }, [list.status, list.rows, loadSummariesFor]);

  // Outbound sync: push filter state to the URL so the view is
  // shareable. Uses `router.replace` so toggling chips doesn't
  // pollute the browser history (same convention as goals page).
  useEffect(() => {
    if (
      statusFilter === lastPushedStatusRef.current &&
      kindFilter === lastPushedKindRef.current
    ) {
      return;
    }
    lastPushedStatusRef.current = statusFilter;
    lastPushedKindRef.current = kindFilter;
    const params = new URLSearchParams();
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (kindFilter !== "all") params.set("kind", kindFilter);
    const qs = params.toString();
    const target = qs.length > 0 ? `/debts?${qs}` : "/debts";
    router.replace(target, { scroll: false });
  }, [statusFilter, kindFilter, router]);

  const handleStatusChange = useCallback((next: StatusFilter) => {
    setStatusFilter((current) => (current === next ? current : next));
  }, []);

  const handleKindChange = useCallback((next: DebtKindFilterValue) => {
    setKindFilter((current) => (current === next ? current : next));
  }, []);

  const handleRetryList = useCallback(() => {
    void loadList();
  }, [loadList]);

  const handleLogout = async () => {
    await logout();
    router.replace("/login");
  };

  // Client-side status + kind filter. The backend doesn't paginate
  // yet and returns the full list; we narrow on the FE to mirror the
  // `GoalList` filter shape and keep the URL shareable. If a debt
  // moves out of the active set after the user picks "Lunas" we keep
  // it in the rendered set so the user can audit closed debts.
  const filteredDebts = useMemo<Debt[]>(() => {
    if (list.status !== "ready") return [];
    return list.rows.filter((debt) => {
      const statusMatch =
        statusFilter === "all" ? true : debt.status === statusFilter;
      const kindMatch = kindFilter === "all" ? true : debt.kind === kindFilter;
      return statusMatch && kindMatch;
    });
  }, [list, statusFilter, kindFilter]);

  // Summary map for the *filtered* set — rows the user filtered out
  // shouldn't pollute the ringkasan totals.
  const filteredSummaries = useMemo<Map<string, DebtSummary>>(() => {
    const out = new Map<string, DebtSummary>();
    for (const debt of filteredDebts) {
      const entry = summary.rows.get(debt.id);
      if (entry) out.set(debt.id, entry);
    }
    return out;
  }, [filteredDebts, summary.rows]);

  const summariesLoading =
    list.status === "ready" &&
    summary.status !== "ready" &&
    summary.pendingIds.size > 0;

  const totals = useMemo(
    () => aggregateDebtTotals({ debts: filteredDebts, summaries: filteredSummaries }),
    [filteredDebts, filteredSummaries],
  );

  // Counts surfaced inside the chip badges. We count against the
  // *unfiltered* list so the chip shows the total available for that
  // filter dimension regardless of the other chip's selection. The
  // raw row reference is wrapped in its own `useMemo` so the two
  // downstream counters don't see a new array identity every render
  // (lint rule `react-hooks/exhaustive-deps`).
  const unfilteredRows = useMemo<Debt[]>(
    () => (list.status === "ready" ? list.rows : []),
    [list.status, list.rows],
  );

  const statusCounts = useMemo<
    Partial<Record<StatusFilter, number>>
  >(() => {
    if (unfilteredRows.length === 0) return {};
    let active = 0;
    let paidOff = 0;
    for (const debt of unfilteredRows) {
      if (debt.status === "active") active += 1;
      else if (debt.status === "paid_off") paidOff += 1;
    }
    return {
      all: unfilteredRows.length,
      active,
      paid_off: paidOff,
    };
  }, [unfilteredRows]);

  const kindCounts = useMemo<Partial<Record<DebtKindFilterValue, number>>>(() => {
    if (unfilteredRows.length === 0) return {};
    const counts: Partial<Record<DebtKindFilterValue, number>> = { all: unfilteredRows.length };
    for (const value of DEBT_KIND_VALUES) {
      counts[value as DebtKind] = 0;
    }
    for (const debt of unfilteredRows) {
      counts[debt.kind] = (counts[debt.kind] ?? 0) + 1;
    }
    return counts;
  }, [unfilteredRows]);

  const filterIsActive = statusFilter !== "all" || kindFilter !== "all";

  return (
    <AppShell user={user} isLoggingOut={isLoggingOut} onLogout={handleLogout}>
      <DebtsHeader />

      <div className="mt-6">
        <DebtStatusChips
          value={statusFilter}
          onChange={handleStatusChange}
          counts={statusCounts}
        />
      </div>

      <div className="mt-3">
        <DebtKindChips
          value={kindFilter}
          onChange={handleKindChange}
          counts={kindCounts}
        />
      </div>

      {list.status === "loading" ? <DebtsSkeleton /> : null}

      {list.status === "error" ? (
        <DebtsError message={list.errorMessage} onRetry={handleRetryList} />
      ) : null}

      {list.status === "ready" ? (
        <>
          <DebtSummaryTiles
            totalRemainingCents={totals.totalRemainingCents}
            totalPrincipalCents={totals.totalPrincipalCents}
            totalInterestPaidCents={totals.totalInterestPaidCents}
            totalMonthlyPaymentCents={totals.totalMonthlyPaymentCents}
            activeCount={totals.activeCount}
            paidOffCount={totals.paidOffCount}
            tenorlessCount={totals.tenorlessCount}
            isLoadingSummaries={summariesLoading}
          />

          {summary.status === "error" && summary.errorMessage ? (
            <SummaryWarning message={summary.errorMessage} />
          ) : null}

          {filteredDebts.length === 0 ? (
            filterIsActive ? (
              <DebtsFilteredEmpty
                statusFilter={statusFilter}
                kindFilter={kindFilter}
                onClearStatus={() => handleStatusChange("all")}
                onClearKind={() => handleKindChange("all")}
              />
            ) : (
              <DebtEmptyState />
            )
          ) : (
            <DebtList
              debts={filteredDebts}
              summaries={filteredSummaries}
              summariesLoading={summariesLoading}
            />
          )}
        </>
      ) : null}
    </AppShell>
  );
}

function DebtsHeader() {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-700">
          Epic 0006 · Debt Tracker
        </p>
        <h2 className="mt-1 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">
          Daftar utang
        </h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
          Pantau saldo, cicilan, dan bunga setiap pinjaman dalam satu
          layar. Sisa pokok dan bunga terbayar mengikuti ringkasan
          per-baris dari BE.
        </p>
      </div>
      <Link
        href="/debts/new"
        className="btn-primary !w-auto px-4"
        aria-label="Catat utang baru"
      >
        + Catat utang
      </Link>
    </header>
  );
}

function DebtsSkeleton() {
  return (
    <div
      className="mt-6 space-y-4"
      role="status"
      aria-live="polite"
      aria-busy="true"
      data-testid="debts-skeleton"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={`tile-${index}`}
            className="card flex flex-col gap-1"
          >
            <div className="h-3 w-16 animate-pulse rounded bg-slate-100" />
            <div className="h-7 w-32 animate-pulse rounded bg-slate-200" />
            <div className="h-3 w-28 animate-pulse rounded bg-slate-100" />
          </div>
        ))}
      </div>
      {Array.from({ length: 3 }).map((_, index) => (
        <div
          key={`row-${index}`}
          className="card flex flex-col gap-3"
          data-testid={`debts-skeleton-row-${index}`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="h-4 w-40 animate-pulse rounded bg-slate-200" />
              <div className="mt-2 h-3 w-28 animate-pulse rounded bg-slate-100" />
            </div>
            <div className="flex gap-1.5">
              <div className="h-6 w-16 animate-pulse rounded-full bg-slate-100" />
              <div className="h-6 w-12 animate-pulse rounded-full bg-slate-100" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, inner) => (
              <div key={inner} className="flex flex-col gap-1">
                <div className="h-3 w-16 animate-pulse rounded bg-slate-100" />
                <div className="h-4 w-20 animate-pulse rounded bg-slate-200" />
              </div>
            ))}
          </div>
        </div>
      ))}
      <span className="sr-only">Memuat daftar utang...</span>
    </div>
  );
}

function DebtsError({
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
      data-testid="debts-error"
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100 text-red-700">
        <ActionIcon name="close" className="h-5 w-5" />
      </div>
      <h3 className="text-base font-semibold text-red-900">
        Gagal memuat utang
      </h3>
      <p className="text-sm leading-6 text-red-800">
        {message ?? "Tidak bisa memuat utang. Coba lagi beberapa saat."}
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

function SummaryWarning({ message }: { message: string }) {
  return (
    <section
      className="card mt-4 flex flex-col items-start gap-3 border-amber-200 bg-amber-50"
      role="status"
      aria-live="polite"
      data-testid="debts-summary-warning"
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-100 text-amber-700">
        <ActionIcon name="close" className="h-5 w-5" />
      </div>
      <h3 className="text-base font-semibold text-amber-900">
        Ringkasan per-baris tidak dapat dimuat
      </h3>
      <p className="text-sm leading-6 text-amber-800">
        Daftar utang tetap tampil. Sisa pokok dan bunga terbayar akan
        mengikuti nilai terakhir yang tersimpan sampai ringkasan
        berhasil dimuat: {message}
      </p>
    </section>
  );
}

function DebtsFilteredEmpty({
  statusFilter,
  kindFilter,
  onClearStatus,
  onClearKind,
}: {
  statusFilter: StatusFilter;
  kindFilter: DebtKindFilterValue;
  onClearStatus: () => void;
  onClearKind: () => void;
}) {
  const statusLabel =
    statusFilter === "all"
      ? null
      : statusFilter === "active"
        ? "Aktif"
        : "Lunas";
  const kindLabel =
    kindFilter === "all" ? null : DEBT_KIND_LABEL[kindFilter as DebtKind];

  return (
    <section
      className="card mt-6 flex flex-col items-center gap-4 py-10 text-center"
      aria-labelledby="debts-filtered-empty-heading"
      data-testid="debts-filtered-empty"
    >
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-50 text-brand-700">
        <NavigationIcon name="debts" className="h-7 w-7" />
      </div>
      <div className="max-w-md">
        <h3
          id="debts-filtered-empty-heading"
          className="text-base font-semibold text-slate-900 sm:text-lg"
        >
          Tidak ada utang yang cocok dengan filter.
        </h3>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Coba longgarkan filter di atas, atau hapus salah satu chip
          untuk melihat semua utang.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {statusLabel ? (
          <button
            type="button"
            className="btn-secondary !w-auto px-4"
            onClick={onClearStatus}
          >
            Hapus filter status: {statusLabel}
          </button>
        ) : null}
        {kindLabel ? (
          <button
            type="button"
            className="btn-secondary !w-auto px-4"
            onClick={onClearKind}
          >
            Hapus filter jenis: {kindLabel}
          </button>
        ) : null}
      </div>
    </section>
  );
}