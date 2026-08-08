"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { AppShell } from "@/components/shell/app-shell";
import {
  DashboardEmptyState,
  DashboardError,
  DashboardGrid,
  DashboardHeader,
  DashboardMobileSummary,
  DashboardSkeleton,
  DebtSummarySection,
  GoalProgressSection,
  IncomeExpenseChart,
  KpiCards,
  LookupWarning,
  NetworthTrendChart,
  Toast,
  TopCategoriesDonut,
  scheduleToastDismiss,
} from "@/components/dashboard";
import { ApiError } from "@/lib/api/client";
import { useAuth } from "@/lib/auth/auth-context";
import { loadDashboard } from "@/lib/dashboard/dashboard-client";
import type {
  DashboardDebtsSummary,
  DashboardGoalsProgress,
  DashboardIncomeExpenseTrend,
  DashboardNetworthTrend,
  DashboardSummary,
  DashboardTopCategories,
  DashboardTopCategory,
} from "@/lib/dashboard/types";

/**
 * Shared dashboard shell (sub-0007-02 + sub-0007-07 + sub-0007-08).
 *
 * Owns the parallel fetch of the six dashboard aggregation endpoints
 * (sub-0007-01), the loading/error/ready/empty state machine, the
 * `latestLoadIdRef` race defense (mirrors sub-0003-06/07), and the
 * responsive layout that splits between the mobile ringkas summary
 * (`<DashboardMobileSummary>`, sub-0007-07) and the desktop full
 * dashboard (the KPI row + 12-column grid + widgets + top-categories
 * placeholder — sub-0007-02/03/04/05/06).
 *
 * Why one shell for two routes:
 *
 *   - `/` (root) renders this shell with both mobile + desktop panes
 *     toggled by Tailwind's `md:hidden` / `hidden md:block` utilities.
 *   - `/dashboard/full` (sub-0007-07) renders the same shell but
 *     passes `showMobileSummary={false}` so the user — usually a
 *     mobile visitor who tapped "Lihat dashboard lengkap" — sees the
 *     desktop layout regardless of viewport width. The route also
 *     injects a back-link via `topSlot`.
 *
 * Extracting the shell out of `app/page.tsx` lets both routes share
 * the race-defense + fetch + state machinery without duplicating any
 * of it. Mirrors the same barrel-convention used by the goals /
 * transactions / debts modules.
 *
 * Empty + lookup-warning + toast wiring (sub-0007-08):
 *
 *   - `<DashboardEmptyState>` replaces the KPI/grid when the user is
 *     brand-new (no accounts, no transactions). The CTA points the
 *     user at `/accounts/new`. Triggered on both `/` and
 *     `/dashboard/full` so a brand-new user never sees a grid of
 *     zero-valued cards.
 *   - `<LookupWarning kind="categories" />` is surfaced whenever the
 *     top-categories payload contains an entry with `categoryName
 *     === null`. The donut renders the slot as "Tanpa nama"; the
 *     banner explains WHY. Non-blocking — the rest of the dashboard
 *     keeps rendering.
 *   - `<Toast>` pairs with the lookup warning for the transient
 *     side-channel notification. Auto-dismisses after 5 s; re-arms
 *     on each retry so the user sees the notification each time.
 */

const TREND_MONTHS = 12;
const TOP_CATEGORIES_LIMIT = 5;

interface DashboardState {
  status: "loading" | "ready" | "error";
  summary: DashboardSummary | null;
  networthTrend: DashboardNetworthTrend | null;
  incomeExpenseTrend: DashboardIncomeExpenseTrend | null;
  topCategories: DashboardTopCategories | null;
  goalsProgress: DashboardGoalsProgress | null;
  debtsSummary: DashboardDebtsSummary | null;
  errorMessage: string | null;
}

// Re-exported under a more explicit name so the unit test can name
// the type without going through `DashboardState` directly. The
// type itself stays local to avoid leaking the internal shell
// representation outside this module.
export type { DashboardState };

const INITIAL_STATE: DashboardState = {
  status: "loading",
  summary: null,
  networthTrend: null,
  incomeExpenseTrend: null,
  topCategories: null,
  goalsProgress: null,
  debtsSummary: null,
  errorMessage: null,
};

interface DashboardContentProps {
  /**
   * Whether to mount the mobile ringkas summary (`<DashboardMobileSummary>`,
   * sub-0007-07). Default `true`. The `/dashboard/full` route passes
   * `false` so a user who taps "Lihat dashboard lengkap" from the
   * mobile summary lands on the full desktop layout regardless of
   * viewport width.
   */
  showMobileSummary?: boolean;
  /**
   * Optional element rendered above `<DashboardHeader>` — used by the
   * `/dashboard/full` route to surface a "Kembali ke beranda" back
   * link. Kept out of the desktop root so the default `/` view doesn't
   * carry a redundant back-link.
   */
  topSlot?: ReactNode;
}

/**
 * Translate a dashboard fetch failure into a user-friendly message.
 * Mirrors the language used in `<MonthlyError>` so the page reads as
 * part of the same family. 401/403 redirect to the global "sesi
 * berakhir" path; 422/500 fall back to the BE's `detail` string when
 * available, otherwise a generic Indonesian message.
 */
function summarizeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return "Sesi kamu sudah berakhir. Masuk lagi untuk memuat dashboard.";
    }
    if (error.status === 422) {
      return error.message || "Permintaan ke dashboard tidak valid.";
    }
    if (error.status >= 500) {
      return "Server sedang bermasalah. Coba lagi beberapa saat.";
    }
    return error.message || "Gagal memuat dashboard.";
  }
  return "Tidak bisa memuat dashboard. Periksa koneksi lalu coba lagi.";
}

/**
 * `true` when the dashboard payload signals a brand-new user — no
 * accounts (assets + liabilities all zero) and no transactions this
 * month. AC sub-0007-08 expects the empty-state CTA in this branch
 * so the user lands on the "Tambah akun pertama" path instead of a
 * grid of zero-valued KPI cards.
 *
 * Exported for the unit test (sub-0007-08) so the wiring predicate
 * can be pinned in isolation from React rendering.
 */
export function isBrandNewUser(
  summary: DashboardSummary | null,
  topCategories: DashboardTopCategories | null,
): boolean {
  if (summary === null) return false;
  const hasNoAccounts =
    summary.totalAssetsCents === 0 && summary.totalLiabilitiesCents === 0;
  const hasNoTransactionsThisMonth =
    summary.incomeThisMonthCents === 0 && summary.expenseThisMonthCents === 0;
  const hasNoTopCategories =
    topCategories === null || topCategories.data.length === 0;
  return hasNoAccounts && hasNoTransactionsThisMonth && hasNoTopCategories;
}

/**
 * `true` when at least one top category entry came back with a
 * `null` name — the BE surfaces uncategorised expenses that way
 * (sub-0007-01) and the donut renders the slot as "Tanpa nama"
 * (AC sub-0007-08). The shell surfaces a non-blocking
 * `<LookupWarning>` + `<Toast>` so the user notices the fallback
 * isn't intentional.
 *
 * Exported for the unit test (sub-0007-08) so the lookup-failure
 * detection can be pinned in isolation from React rendering.
 */
export function hasCategoryLookupFailure(
  topCategories: DashboardTopCategories | null,
): boolean {
  if (topCategories === null) return false;
  return topCategories.data.some(
    (point) =>
      point.categoryName === null || point.categoryName.trim().length === 0,
  );
}

/**
 * View enum for `<DashboardContent>`'s render tree. Pulled out so
 * the unit test (sub-0007-08) can pin the wiring in isolation
 * without spinning up a React renderer — the CI/CD review of
 * sub-0007-07 flagged that no test mounts the page-level wiring,
 * so a future regression that swaps "empty" for "ready" (or shows
 * the mobile pane for a brand-new user) slipped past every gate.
 */
export type DashboardView =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "empty" }
  | {
      kind: "ready";
      hasLookupFailure: boolean;
      showMobile: boolean;
      toastVisible: boolean;
    };

/**
 * Pure view-selection predicate that the `<DashboardContent>` JSX
 * consults once per render. The JSX is a thin switch over the
 * returned enum; the unit test pins every (state × flag) combination
 * the shell can land in.
 *
 * Branches:
 *
 *   - `state.status === "loading"`         → `loading`
 *   - `state.status === "error"`           → `error` (with message)
 *   - `state.status === "ready"` + brand-new → `empty` (replaces
 *     KPI/grid AND mobile pane per TL decision sub-0007-08)
 *   - `state.status === "ready"` + non-brand-new → `ready`
 *     (`showMobile` carries the `showMobileSummary` prop so the
 *     `/dashboard/full` route can suppress the mobile pane)
 *
 * `toastVisible` is gated by `categoryLookupFailed && !toastDismissed`
 * so the test can verify the auto-dismiss wiring without spinning
 * up timers.
 */
export function selectDashboardView(
  state: DashboardState,
  flags: {
    isBrandNew: boolean;
    categoryLookupFailed: boolean;
    showMobileSummary: boolean;
    toastDismissed: boolean;
  },
): DashboardView {
  if (state.status === "loading") return { kind: "loading" };
  if (state.status === "error") {
    return {
      kind: "error",
      message: state.errorMessage ?? "Tidak bisa memuat dashboard.",
    };
  }
  if (state.status === "ready") {
    if (flags.isBrandNew) return { kind: "empty" };
    return {
      kind: "ready",
      hasLookupFailure: flags.categoryLookupFailed,
      showMobile: flags.showMobileSummary,
      toastVisible: flags.categoryLookupFailed && !flags.toastDismissed,
    };
  }
  // Should be unreachable; treat as loading so the user sees the
  // skeleton instead of a blank shell.
  return { kind: "loading" };
}

export function DashboardContent({
  showMobileSummary = true,
  topSlot,
}: DashboardContentProps) {
  const router = useRouter();
  const { user, logout, isLoading: isLoggingOut } = useAuth();

  const [state, setState] = useState<DashboardState>(INITIAL_STATE);
  const [toastDismissed, setToastDismissed] = useState(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Race defenses (mirrors sub-0003-06 / sub-0003-07):
   *   - `latestLoadIdRef` bumps per `load()` call so the catch/setState
   *     after `await` only fires when the captured id is still current.
   *   - `abortControllerRef` lets each new load cancel the prior
   *     request mid-flight so its resolved value (success or error)
   *     never lands in component state.
   *   - The `useEffect` cleanup aborts on unmount, so navigating away
   *     doesn't leave a dangling fetch that re-enters setState after
   *     teardown.
   */
  const latestLoadIdRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
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
    setToastDismissed(false);

    const dropStale = () =>
      loadId !== latestLoadIdRef.current || controller.signal.aborted;

    try {
      const payload = await loadDashboard({
        trendMonths: TREND_MONTHS,
        topCategoriesLimit: TOP_CATEGORIES_LIMIT,
        signal: controller.signal,
      });

      if (dropStale()) return;

      setState({
        status: "ready",
        summary: payload.summary,
        networthTrend: payload.networthTrend,
        incomeExpenseTrend: payload.incomeExpenseTrend,
        topCategories: payload.topCategories,
        goalsProgress: payload.goalsProgress,
        debtsSummary: payload.debtsSummary,
        errorMessage: null,
      });
    } catch (error) {
      if (dropStale()) return;
      if (controller.signal.aborted) return;
      setState({
        status: "error",
        summary: null,
        networthTrend: null,
        incomeExpenseTrend: null,
        topCategories: null,
        goalsProgress: null,
        debtsSummary: null,
        errorMessage: summarizeError(error),
      });
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
    };
  }, [load]);

  const handleRetry = useCallback(() => {
    void load();
  }, [load]);

  const handleToastDismiss = useCallback(() => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setToastDismissed(true);
  }, []);

  const handleLogout = async () => {
    await logout();
    router.replace("/login");
  };

  const categoryLookupFailed = useMemo(
    () => hasCategoryLookupFailure(state.topCategories),
    [state.topCategories],
  );

  const isBrandNew = useMemo(
    () => isBrandNewUser(state.summary, state.topCategories),
    [state.summary, state.topCategories],
  );

  // Auto-dismiss the lookup-warning toast after 5 s. Re-armed
  // whenever the lookup failure surfaces again (e.g. after a retry
  // that didn't help) so the user sees the notification each time.
  useEffect(() => {
    if (!categoryLookupFailed || toastDismissed) return;
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = scheduleToastDismiss(() => {
      setToastDismissed(true);
      toastTimerRef.current = null;
    }, 5000);
    return () => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
    };
  }, [categoryLookupFailed, toastDismissed, state.status]);

  /**
   * View-selection per the TL decision (sub-0007-08 #c630d63d):
   * `isBrandNew` short-circuits the whole tree (no mobile pane, no
   * desktop pane, no lookup warning). For non-new users the
   * `showMobileSummary` prop still gates the mobile pane so the
   * `/dashboard/full` route suppresses it.
   */
  const view = selectDashboardView(state, {
    isBrandNew,
    categoryLookupFailed,
    showMobileSummary,
    toastDismissed,
  });

  const emptyTrend: DashboardNetworthTrend = { data: [] };

  return (
    <AppShell
      user={user}
      isLoggingOut={isLoggingOut}
      onLogout={handleLogout}
    >
      {topSlot}

      <DashboardHeader user={user} />

      <div className="mt-6 space-y-6">
        {view.kind === "loading" ? <DashboardSkeleton /> : null}

        {view.kind === "error" ? (
          <DashboardError
            message={view.message}
            onRetry={handleRetry}
          />
        ) : null}

        {view.kind === "empty" ? <DashboardEmptyState /> : null}

        {view.kind === "ready" && state.summary ? (
          <>
            {view.hasLookupFailure ? (
              <LookupWarning
                kind="categories"
                onRetry={handleRetry}
              />
            ) : null}

            <div
              className="hidden space-y-6 md:block"
              data-testid="dashboard-desktop-pane"
            >
              <KpiCards
                networthCents={state.summary.networthCents}
                incomeThisMonthCents={state.summary.incomeThisMonthCents}
                expenseThisMonthCents={state.summary.expenseThisMonthCents}
                emergencyFundAvgPct={state.summary.emergencyFundAvgPct}
              />

              <DashboardGrid>
                <div className="md:col-span-8">
                  <NetworthTrendChart
                    data={state.networthTrend?.data ?? []}
                  />
                </div>
                <div className="md:col-span-4">
                  <IncomeExpenseChart
                    data={state.incomeExpenseTrend?.data ?? []}
                  />
                </div>
                <div className="md:col-span-6">
                  <GoalProgressSection
                    goals={state.goalsProgress?.data ?? null}
                  />
                </div>
                <div className="md:col-span-6">
                  <DebtSummarySection
                    summary={state.debtsSummary ?? null}
                  />
                </div>
              </DashboardGrid>

              <TopCategoriesSection data={state.topCategories?.data ?? []} />
            </div>

            {view.showMobile ? (
              <DashboardMobileSummary
                summary={state.summary}
                networthTrend={state.networthTrend ?? emptyTrend}
              />
            ) : null}
          </>
        ) : null}
      </div>

      {view.kind === "ready" && view.toastVisible ? (
        <Toast
          message="Beberapa kategori tidak dapat dimuat. Label diganti 'Tanpa nama' sementara."
          onDismiss={handleToastDismiss}
        />
      ) : null}
    </AppShell>
  );
}

/**
 * Standalone card for the top-categories donut chart. Kept out of the
 * 12-column grid on purpose — the donut card sits below the grid as a
 * standalone full-width row so the donut can breathe (the sub-0007-05
 * chart will replace the body without changing this layout shell).
 */
function TopCategoriesSection({
  data,
}: {
  data: DashboardTopCategory[];
}) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-12 md:gap-6">
      <div className="md:col-span-12">
        <TopCategoriesDonut data={data} />
      </div>
    </div>
  );
}