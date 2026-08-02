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

import { GoalFilterChips, type GoalFilterValue } from "@/components/goals/goal-filter-chips";
import { GoalList } from "@/components/goals/goal-list";
import { AppShell } from "@/components/shell/app-shell";
import { ActionIcon, NavigationIcon } from "@/components/shell/icons";
import {
  fetchAccounts,
  fetchBalances,
  formatIdrFromCents,
} from "@/lib/api/account-client";
import type { Account, AccountBalance, AccountBalances } from "@/lib/api/accounts";
import {
  EMPTY_GOAL_FILTERS,
  fetchGoals,
  formatGoalApiError,
  GOAL_KIND_LABEL,
  GOAL_KIND_VALUES,
  GOAL_PAGE_SIZE,
  type Goal,
  type GoalKind,
} from "@/lib/api/goal-client";
import { ApiError } from "@/lib/api/client";
import { useAuth } from "@/lib/auth/auth-context";
import { AuthGuard } from "@/lib/auth/auth-guard";

/**
 * `/goals` — list of saving + emergency-fund goals for the current
 * user (sub-0005-03). Additive over the BE `GET /goals` endpoint
 * (sub-0005-01) and the progress engine (sub-0005-02). The page is
 * read-only: create / edit / banner-notification sub-tasks live in
 * sub-0005-04 / sub-0005-05.
 *
 * State flow:
 *
 *   1. URL ↔ filter state — the canonical state lives in
 *      ``goalFilters`` (mirrored from ``useSearchParams()`` on mount).
 *      Every change pushes the new query string back via
 *      ``router.replace`` so the URL is shareable (same convention as
 *      sub-0003-06 transactions list).
 *   2. Filter state ↔ data — the `load()` effect triggers a fetch
 *      whenever the filter object changes, with race defense identical
 *      to the rest of the FE (sub-0003-06 / sub-0003-07 / sub-0004-04).
 *   3. Lookup data — ``accounts`` + ``balances`` are fetched once on
 *      mount so the goal-card can resolve both the linked account
 *      name and the live saldo (sub-0005-02 progress engine) without
 *      a per-row round-trip.
 *
 * UI composition:
 *
 *   - **Header** — page title + "Buat target" CTA (the actual form
 *     ships in sub-0005-04; the CTA links to ``/goals/new`` which is
 *     out-of-scope here).
 *   - **Filter chips** — "Semua" / "Tabungan" / "Dana darurat". The
 *     ``Semua`` view sorts EF top + saving below per the FE spec
 *     (EF is the priority bucket per PRD §14).
 *   - **List** — ``GoalList`` renders the cards with progress bars.
 *   - **Empty / error / skeleton states** — mirror the rest of the
 *     dashboard (sub-0003-05/06, sub-0004-04).
 *
 * Defect fix (PR #43 reviewer, CI/CD Engineer):
 *
 *   - **Blocker 1 — linked goal 0%**: ``GET /goals`` returns the
 *     persisted ``current_amount_cents`` column. For linked goals
 *     the live saldo from the linked account is the source of truth
 *     (sub-0005-02). We fetch ``/accounts/balances`` once on mount
 *     and let ``GoalCard`` resolve ``currentCents`` from that
 *     snapshot, falling back to the persisted column when the goal
 *     is unlinked.
 *   - **Blocker 2 — lookup error hides list**: the lookup error is
 *     now surfaced as a non-blocking amber banner above the goals
 *     list. The list itself still renders (cards fall back to
 *     "Akun tidak diketahui" for linked-account resolution).
 *   - **Blocker 3 — saving not sorted by ``created_at desc``**:
 *     ``sortGoalsForDisplay`` now sorts EF first (priority), then
 *     within each kind by ``createdAt`` descending (matches the
 *     issue spec verbatim). Same tiebreaker for EF so rows stay
 *     stable across renders.
 */

type LoadStatus = "loading" | "ready" | "error";

interface LookupAccountsState {
  status: LoadStatus;
  accounts: Account[];
  errorMessage: string | null;
}

interface LookupBalancesState {
  status: LoadStatus;
  balances: AccountBalance[];
  totals: AccountBalances | null;
  errorMessage: string | null;
}

interface GoalsState {
  status: LoadStatus;
  rows: Goal[];
  total: number;
  errorMessage: string | null;
}

const INITIAL_LOOKUP_ACCOUNTS: LookupAccountsState = {
  status: "loading",
  accounts: [],
  errorMessage: null,
};

const INITIAL_LOOKUP_BALANCES: LookupBalancesState = {
  status: "loading",
  balances: [],
  totals: null,
  errorMessage: null,
};

const INITIAL_GOALS: GoalsState = {
  status: "loading",
  rows: [],
  total: 0,
  errorMessage: null,
};

const GOAL_KIND_SET: ReadonlySet<string> = new Set(GOAL_KIND_VALUES);

function parseGoalKindParam(raw: string | null): GoalKind | null {
  if (!raw) return null;
  if (GOAL_KIND_SET.has(raw)) return raw as GoalKind;
  return null;
}

function sameGoalFilters(
  left: { kind: GoalKind | null },
  right: { kind: GoalKind | null },
): boolean {
  return left.kind === right.kind;
}

function summarizeAccountsError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return "Sesi kamu sudah berakhir. Masuk lagi untuk memuat daftar akun.";
    }
    if (error.status >= 500) {
      return "Server sedang bermasalah. Coba lagi beberapa saat.";
    }
    return error.message || "Gagal memuat daftar akun.";
  }
  return "Tidak bisa memuat daftar akun. Periksa koneksi lalu coba lagi.";
}

function summarizeBalancesError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return "Sesi kamu sudah berakhir. Saldo akun mungkin tidak akurat.";
    }
    if (error.status >= 500) {
      return "Server sedang bermasalah. Saldo akun mungkin tidak akurat.";
    }
    return error.message || "Gagal memuat saldo akun.";
  }
  return "Tidak bisa memuat saldo akun. Periksa koneksi lalu coba lagi.";
}

export default function GoalsPage() {
  return (
    <AuthGuard>
      <GoalsContent />
    </AuthGuard>
  );
}

function GoalsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, logout, isLoading: isLoggingOut } = useAuth();

  const initialKind = parseGoalKindParam(searchParams.get("kind"));
  const [kindFilter, setKindFilter] = useState<GoalKind | null>(initialKind);
  const [accounts, setAccounts] = useState<LookupAccountsState>(
    INITIAL_LOOKUP_ACCOUNTS,
  );
  const [balances, setBalances] = useState<LookupBalancesState>(
    INITIAL_LOOKUP_BALANCES,
  );
  const [goalsState, setGoalsState] = useState<GoalsState>(INITIAL_GOALS);

  // Race defense mirrors sub-0003-06: bump a load id per fetch and
  // capture an AbortController so a newer load can drop the prior
  // response mid-flight.
  const latestGoalsLoadIdRef = useRef<number>(0);
  const goalsAbortRef = useRef<AbortController | null>(null);
  const latestAccountsLoadIdRef = useRef<number>(0);
  const accountsAbortRef = useRef<AbortController | null>(null);
  const latestBalancesLoadIdRef = useRef<number>(0);
  const balancesAbortRef = useRef<AbortController | null>(null);

  const lastPushedKindRef = useRef<string | null>(
    initialKind === null ? null : initialKind,
  );

  const loadGoals = useCallback(
    async (kind: GoalKind | null) => {
      goalsAbortRef.current?.abort();
      const controller = new AbortController();
      goalsAbortRef.current = controller;
      const loadId = ++latestGoalsLoadIdRef.current;
      const dropStale = (): boolean =>
        loadId !== latestGoalsLoadIdRef.current || controller.signal.aborted;

      setGoalsState((current) => ({ ...current, status: "loading", errorMessage: null }));

      try {
        const response = await fetchGoals(
          { ...EMPTY_GOAL_FILTERS, kind },
          { signal: controller.signal },
        );
        if (dropStale()) return;
        setGoalsState({
          status: "ready",
          rows: response.items,
          total: response.total,
          errorMessage: null,
        });
      } catch (error) {
        if (dropStale()) return;
        if (controller.signal.aborted) return;
        setGoalsState({
          status: "error",
          rows: [],
          total: 0,
          errorMessage: formatGoalApiError(
            error,
            "Tidak bisa memuat target. Periksa koneksi lalu coba lagi.",
          ),
        });
      }
    },
    [],
  );

  const loadAccounts = useCallback(async () => {
    accountsAbortRef.current?.abort();
    const controller = new AbortController();
    accountsAbortRef.current = controller;
    const loadId = ++latestAccountsLoadIdRef.current;
    const dropStale = (): boolean =>
      loadId !== latestAccountsLoadIdRef.current || controller.signal.aborted;

    setAccounts((current) => ({ ...current, status: "loading" }));

    try {
      const fetched = await fetchAccounts({ signal: controller.signal });
      if (dropStale()) return;
      setAccounts({
        status: "ready",
        accounts: fetched,
        errorMessage: null,
      });
    } catch (error) {
      if (dropStale()) return;
      if (controller.signal.aborted) return;
      setAccounts({
        status: "error",
        accounts: [],
        errorMessage: summarizeAccountsError(error),
      });
    }
  }, []);

  const loadBalances = useCallback(async () => {
    balancesAbortRef.current?.abort();
    const controller = new AbortController();
    balancesAbortRef.current = controller;
    const loadId = ++latestBalancesLoadIdRef.current;
    const dropStale = (): boolean =>
      loadId !== latestBalancesLoadIdRef.current || controller.signal.aborted;

    setBalances((current) => ({ ...current, status: "loading" }));

    try {
      const fetched = await fetchBalances({ signal: controller.signal });
      if (dropStale()) return;
      if (fetched === null) {
        setBalances({
          status: "error",
          balances: [],
          totals: null,
          errorMessage: "Respons saldo tidak dikenali.",
        });
        return;
      }
      setBalances({
        status: "ready",
        balances: fetched.accounts,
        totals: fetched,
        errorMessage: null,
      });
    } catch (error) {
      if (dropStale()) return;
      if (controller.signal.aborted) return;
      setBalances({
        status: "error",
        balances: [],
        totals: null,
        errorMessage: summarizeBalancesError(error),
      });
    }
  }, []);

  // Lookups on mount only — the linked account list + balances
  // snapshot rarely change during a session, so we don't refetch on
  // filter changes.
  useEffect(() => {
    void loadAccounts();
    return () => {
      accountsAbortRef.current?.abort();
      accountsAbortRef.current = null;
    };
  }, [loadAccounts]);

  useEffect(() => {
    void loadBalances();
    return () => {
      balancesAbortRef.current?.abort();
      balancesAbortRef.current = null;
    };
  }, [loadBalances]);

  // Goals refetch whenever the kind filter changes.
  useEffect(() => {
    void loadGoals(kindFilter);
  }, [kindFilter, loadGoals]);

  useEffect(() => {
    return () => {
      goalsAbortRef.current?.abort();
      goalsAbortRef.current = null;
    };
  }, []);

  // Outbound sync: push filter state to the URL so the view is
  // shareable (AC shareable link). We use `router.replace` so each
  // chip toggle doesn't pollute the browser history.
  useEffect(() => {
    const next = kindFilter === null ? null : kindFilter;
    if (next === lastPushedKindRef.current) return;
    lastPushedKindRef.current = next;
    const target =
      next === null ? "/goals" : `/goals?kind=${encodeURIComponent(next)}`;
    router.replace(target, { scroll: false });
  }, [kindFilter, router]);

  const handleFilterChange = useCallback((next: GoalFilterValue) => {
    setKindFilter((current) => {
      const resolved = next === "all" ? null : next;
      if (sameGoalFilters({ kind: current }, { kind: resolved })) {
        return current;
      }
      return resolved;
    });
  }, []);

  const handleRetryGoals = useCallback(() => {
    void loadGoals(kindFilter);
  }, [kindFilter, loadGoals]);

  const handleRetryAccounts = useCallback(() => {
    void loadAccounts();
  }, [loadAccounts]);

  const handleRetryBalances = useCallback(() => {
    void loadBalances();
  }, [loadBalances]);

  const handleLogout = async () => {
    await logout();
    router.replace("/login");
  };

  const counts = useMemo<Partial<Record<GoalFilterValue, number>>>(() => {
    if (goalsState.status !== "ready") return {};
    const out: Partial<Record<GoalFilterValue, number>> = {
      all: goalsState.rows.length,
    };
    for (const kind of GOAL_KIND_VALUES) {
      out[kind] = goalsState.rows.filter((goal) => goal.kind === kind).length;
    }
    return out;
  }, [goalsState]);

  const activeFilterValue: GoalFilterValue = kindFilter ?? "all";
  const showAllKinds = activeFilterValue === "all";

  // The lookup errors are intentionally non-blocking for the goals
  // list itself (PR #43 reviewer blocker 2). The cards still render —
  // when the account lookup fails the linked-account section is
  // skipped, when the balance snapshot fails the card falls back to
  // the persisted `current_amount_cents`.
  const accountsErrorVisible = accounts.status === "error";
  const balancesErrorVisible = balances.status === "error";

  const networthLabel =
    balances.totals !== null
      ? formatIdrFromCents(balances.totals.networthCents)
      : null;

  return (
    <AppShell user={user} isLoggingOut={isLoggingOut} onLogout={handleLogout}>
      <GoalsHeader networthLabel={networthLabel} />

      <div className="mt-6">
        <GoalFilterChips
          value={activeFilterValue}
          onChange={handleFilterChange}
          counts={counts}
        />
      </div>

      {accountsErrorVisible ? (
        <LookupWarning
          kind="accounts"
          message={accounts.errorMessage}
          onRetry={handleRetryAccounts}
        />
      ) : null}

      {balancesErrorVisible ? (
        <LookupWarning
          kind="balances"
          message={balances.errorMessage}
          onRetry={handleRetryBalances}
        />
      ) : null}

      {goalsState.status === "loading" ? <GoalsSkeleton /> : null}

      {goalsState.status === "error" ? (
        <GoalsError
          message={goalsState.errorMessage}
          onRetry={handleRetryGoals}
        />
      ) : null}

      {goalsState.status === "ready" ? (
        goalsState.rows.length === 0 ? (
          <GoalsEmptyState kindFilter={kindFilter} />
        ) : (
          <GoalList
            goals={goalsState.rows}
            accounts={accounts.accounts}
            balances={balances.balances}
            total={goalsState.total}
            showAllKinds={showAllKinds}
          />
        )
      ) : null}

      {goalsState.status === "ready" && goalsState.total > GOAL_PAGE_SIZE ? (
        <p className="mt-4 text-xs text-slate-500">
          Menampilkan halaman pertama ({goalsState.rows.length} dari{" "}
          {goalsState.total} target). Pagination lengkap menyusul di sub-0005-06.
        </p>
      ) : null}
    </AppShell>
  );
}

function GoalsHeader({ networthLabel }: { networthLabel: string | null }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-700">
          Epic 0005 · Goal Trackers
        </p>
        <h2 className="mt-1 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">
          Target keuangan
        </h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
          Pantau tabungan dan dana darurat dalam satu layar. Pilih jenis
          target lewat chip di atas, atau buka detail dengan mengetuk kartu.
        </p>
        {networthLabel !== null ? (
          <p className="mt-2 text-xs text-slate-500" aria-live="polite">
            Networth saat ini:{" "}
            <span className="font-semibold text-slate-700 tabular-nums">
              {networthLabel}
            </span>
            {" "}
            · saldo live dipakai untuk target yang ditautkan ke akun.
          </p>
        ) : null}
      </div>
      <Link
        href="/goals/new"
        className="btn-primary !w-auto px-4"
        aria-label="Buat target baru"
      >
        + Buat target
      </Link>
    </header>
  );
}

function GoalsSkeleton() {
  return (
    <div
      className="mt-6 space-y-4"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      {Array.from({ length: 3 }).map((_, index) => (
        <div
          key={index}
          className="card flex flex-col gap-3"
          data-testid={`goals-skeleton-${index}`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="h-4 w-40 animate-pulse rounded bg-slate-200" />
              <div className="mt-2 h-3 w-28 animate-pulse rounded bg-slate-100" />
            </div>
            <div className="h-6 w-20 animate-pulse rounded-full bg-slate-100" />
          </div>
          <div className="h-2 w-full animate-pulse rounded-full bg-slate-200" />
          <div className="flex items-baseline justify-between gap-2">
            <div className="h-3 w-32 animate-pulse rounded bg-slate-100" />
            <div className="h-3 w-12 animate-pulse rounded bg-slate-100" />
          </div>
        </div>
      ))}
      <span className="sr-only">Memuat daftar target...</span>
    </div>
  );
}

function GoalsError({
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
        Gagal memuat target
      </h3>
      <p className="text-sm leading-6 text-red-800">
        {message ?? "Tidak bisa memuat target. Coba lagi beberapa saat."}
      </p>
      <button type="button" className="btn-primary !w-auto px-4" onClick={onRetry}>
        Coba lagi
      </button>
    </section>
  );
}

function LookupWarning({
  kind,
  message,
  onRetry,
}: {
  kind: "accounts" | "balances";
  message: string | null;
  onRetry: () => void;
}) {
  const heading =
    kind === "accounts"
      ? "Daftar akun tidak dapat dimuat"
      : "Saldo akun tidak dapat dimuat";
  const description =
    kind === "accounts"
      ? "Target tetap tampil. Nama akun tertaut akan kosong sampai daftar akun berhasil dimuat."
      : "Target tetap tampil. Progress target tertaut akan memakai nilai terakhir yang tersimpan sampai saldo berhasil dimuat.";
  return (
    <section
      className="card mt-4 flex flex-col items-start gap-3 border-amber-200 bg-amber-50"
      role="status"
      aria-live="polite"
      data-warning-kind={kind}
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-100 text-amber-700">
        <ActionIcon name="close" className="h-5 w-5" />
      </div>
      <h3 className="text-base font-semibold text-amber-900">{heading}</h3>
      <p className="text-sm leading-6 text-amber-800">
        {message ?? description}
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

function GoalsEmptyState({ kindFilter }: { kindFilter: GoalKind | null }) {
  const filterLabel =
    kindFilter === null
      ? null
      : GOAL_KIND_LABEL[kindFilter] ?? null;
  return (
    <section
      className="card mt-6 flex flex-col items-center gap-4 py-10 text-center"
      aria-labelledby="goals-empty-heading"
    >
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-50 text-brand-700">
        <NavigationIcon name="goals" className="h-7 w-7" />
      </div>
      <div className="max-w-md">
        <h3
          id="goals-empty-heading"
          className="text-base font-semibold text-slate-900 sm:text-lg"
        >
          {filterLabel
            ? `Belum ada target ${filterLabel.toLowerCase()}.`
            : "Belum ada target yang tercatat."}
        </h3>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Buat target tabungan atau dana darurat pertama kamu agar
          progresnya bisa dipantau dari dasbor.
        </p>
      </div>
      <Link
        href="/goals/new"
        className="btn-primary !w-auto px-5"
        aria-label="Buat target pertama"
      >
        Buat target pertama
      </Link>
    </section>
  );
}