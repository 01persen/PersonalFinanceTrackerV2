"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { AppShell } from "@/components/shell/app-shell";
import {
  DashboardError,
  DashboardGrid,
  DashboardHeader,
  DashboardSkeleton,
  DebtsSummaryPlaceholder,
  GoalsProgressPlaceholder,
  IncomeExpenseTrendPlaceholder,
  KpiCards,
  NetworthTrendChart,
  TopCategoriesPlaceholder,
} from "@/components/dashboard";
import { ApiError } from "@/lib/api/client";
import { useAuth } from "@/lib/auth/auth-context";
import { AuthGuard } from "@/lib/auth/auth-guard";
import { loadDashboard } from "@/lib/dashboard/dashboard-client";
import type {
  DashboardNetworthTrend,
  DashboardSummary,
} from "@/lib/dashboard/types";

const TREND_MONTHS = 12;
const TOP_CATEGORIES_LIMIT = 5;

interface DashboardState {
  status: "loading" | "ready" | "error";
  summary: DashboardSummary | null;
  networthTrend: DashboardNetworthTrend | null;
  errorMessage: string | null;
}

const INITIAL_STATE: DashboardState = {
  status: "loading",
  summary: null,
  networthTrend: null,
  errorMessage: null,
};

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

export default function DashboardPage() {
  return (
    <AuthGuard>
      <DashboardContent />
    </AuthGuard>
  );
}

function DashboardContent() {
  const router = useRouter();
  const { user, logout, isLoading: isLoggingOut } = useAuth();

  const [state, setState] = useState<DashboardState>(INITIAL_STATE);

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
        errorMessage: null,
      });
    } catch (error) {
      if (dropStale()) return;
      if (controller.signal.aborted) return;
      setState({
        status: "error",
        summary: null,
        networthTrend: null,
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
    };
  }, [load]);

  const handleRetry = useCallback(() => {
    void load();
  }, [load]);

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
      <DashboardHeader user={user} />

      <div className="mt-6 space-y-6">
        {state.status === "loading" ? <DashboardSkeleton /> : null}

        {state.status === "error" ? (
          <DashboardError
            message={state.errorMessage}
            onRetry={handleRetry}
          />
        ) : null}

        {state.status === "ready" && state.summary ? (
          <>
            <KpiCards
              networthCents={state.summary.networthCents}
              incomeThisMonthCents={state.summary.incomeThisMonthCents}
              expenseThisMonthCents={state.summary.expenseThisMonthCents}
              emergencyFundAvgPct={state.summary.emergencyFundAvgPct}
            />

            <DashboardGrid>
              <div className="md:col-span-8">
                <NetworthTrendChart data={state.networthTrend?.data ?? []} />
              </div>
              <div className="md:col-span-4">
                <IncomeExpenseTrendPlaceholder />
              </div>
              <div className="md:col-span-6">
                <GoalsProgressPlaceholder />
              </div>
              <div className="md:col-span-6">
                <DebtsSummaryPlaceholder />
              </div>
            </DashboardGrid>

            <TopCategoriesSection />
          </>
        ) : null}
      </div>
    </AppShell>
  );
}

/**
 * Standalone card for the top-categories donut chart. Kept out of the
 * 12-column grid on purpose — the donut card sits below the grid as a
 * standalone full-width row so the donut can breathe (the sub-0007-05
 * chart will replace the body without changing this layout shell).
 */
function TopCategoriesSection() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-12 md:gap-6">
      <div className="md:col-span-12">
        <TopCategoriesPlaceholder />
      </div>
    </div>
  );
}
