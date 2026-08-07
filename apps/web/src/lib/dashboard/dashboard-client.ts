/**
 * Dashboard aggregation client (sub-0007-02).
 *
 * Six read-only fetch helpers covering every endpoint exposed by the
 * `apps/api/src/app/api/v1/dashboard.py` router (sub-0007-01):
 *
 * - `fetchDashboardSummary`        → `GET /dashboard/summary`
 * - `fetchNetworthTrend`           → `GET /dashboard/networth-trend?months=`
 * - `fetchIncomeExpenseTrend`      → `GET /dashboard/income-expense-trend?months=`
 * - `fetchTopCategories`           → `GET /dashboard/top-categories?month=&limit=`
 * - `fetchGoalsProgress`           → `GET /dashboard/goals-progress`
 * - `fetchDebtsSummary`            → `GET /dashboard/debts-summary`
 *
 * Conventions:
 *
 * - Every helper accepts an `AbortSignal` so the page can drop
 *   in-flight requests on rapid re-renders / unmount (mirrors the
 *   race-defense pattern from `transaction-summary-client.ts` and
 *   `transactions/bulanan/page.tsx`).
 * - The page orchestrates the race defense itself: it bumps a
 *   `latestLoadIdRef` per `load()` call and aborts the previous
 *   `AbortController` so the older fetch resolves into a discarded
 *   promise. We don't bake a ref into the client because the page
 *   already owns its own state machine (mirrors sub-0003-06/07).
 * - All adapters are defensive: a malformed payload returns `null` so
 *   the caller can fall back to the error-retry path (same convention
 *   as `adaptTransactionSummary`).
 * - Caching is intentionally NOT done at this layer — the BE owns the
 *   60-second stdlib TTL (`apps/api/src/app/services/dashboard_cache.py`).
 *   Adding a FE cache would silently bypass the invalidation hooks the
 *   write-side routers call on POST/PATCH/DELETE.
 */

import { ApiError, apiRequest } from "@/lib/api/client";
import {
  GOAL_KIND_VALUES,
  type GoalKind,
} from "@/lib/api/goals";

import type {
  DashboardDebtsSummary,
  DashboardGoalProgress,
  DashboardGoalStatus,
  DashboardGoalsProgress,
  DashboardIncomeExpenseTrend,
  DashboardIncomeExpenseTrendPoint,
  DashboardNetworthTrend,
  DashboardNetworthTrendPoint,
  DashboardSummary,
  DashboardTopCategories,
  DashboardTopCategory,
} from "@/lib/dashboard/types";

// --- shared adapters -------------------------------------------------------

function toFiniteInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function toNullableFiniteNumber(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isGoalKind(value: unknown): value is GoalKind {
  return (
    typeof value === "string" &&
    (GOAL_KIND_VALUES as readonly string[]).includes(value)
  );
}

function isGoalStatus(value: unknown): value is DashboardGoalStatus {
  return value === "active" || value === "achieved" || value === "archived";
}

function isMonthLabel(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}$/.test(value);
}

// --- /summary --------------------------------------------------------------

interface RawSummaryPayload {
  currency?: unknown;
  networth_cents?: unknown;
  total_assets_cents?: unknown;
  total_liabilities_cents?: unknown;
  income_this_month_cents?: unknown;
  expense_this_month_cents?: unknown;
  emergency_fund_avg_pct?: unknown;
}

/**
 * Adapt the wire payload for `GET /dashboard/summary`. Returns `null`
 * when the payload is missing or missing the currency sentinel — the
 * caller (page) treats that as the error-retry path. All other numeric
 * fields default to `0` so a partial payload doesn't blow up the page
 * (a successful response with `0`s still renders the zero-state card).
 */
export function adaptDashboardSummary(raw: unknown): DashboardSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as RawSummaryPayload;
  if (typeof r.currency !== "string") return null;
  return {
    currency: r.currency,
    networthCents: toFiniteInt(r.networth_cents),
    totalAssetsCents: toFiniteInt(r.total_assets_cents),
    totalLiabilitiesCents: toFiniteInt(r.total_liabilities_cents),
    incomeThisMonthCents: toFiniteInt(r.income_this_month_cents),
    expenseThisMonthCents: toFiniteInt(r.expense_this_month_cents),
    emergencyFundAvgPct: toNullableFiniteNumber(r.emergency_fund_avg_pct),
  };
}

/**
 * Fetch the KPI-card payload from `GET /dashboard/summary`. Throws
 * `ApiError` on non-2xx; the page maps that to the error-retry UI.
 */
export async function fetchDashboardSummary(options: {
  signal?: AbortSignal;
} = {}): Promise<DashboardSummary> {
  const raw = await apiRequest<unknown>("/dashboard/summary", {
    signal: options.signal,
  });
  const adapted = adaptDashboardSummary(raw);
  if (adapted === null) {
    throw new ApiError(200, "Respons ringkasan dashboard tidak dikenali.");
  }
  return adapted;
}

// --- /networth-trend -------------------------------------------------------

interface RawNetworthPointPayload {
  month?: unknown;
  networth_cents?: unknown;
}

interface RawNetworthTrendPayload {
  data?: unknown;
}

function adaptNetworthTrendPoint(raw: unknown): DashboardNetworthTrendPoint | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as RawNetworthPointPayload;
  if (!isMonthLabel(r.month)) return null;
  return {
    month: r.month,
    networthCents: toFiniteInt(r.networth_cents),
  };
}

export function adaptDashboardNetworthTrend(
  raw: unknown,
): DashboardNetworthTrend | null {
  if (!raw || typeof raw !== "object") return null;
  const payload = raw as RawNetworthTrendPayload;
  if (!Array.isArray(payload.data)) return null;
  const data: DashboardNetworthTrendPoint[] = [];
  for (const item of payload.data) {
    const adapted = adaptNetworthTrendPoint(item);
    if (adapted) data.push(adapted);
  }
  return { data };
}

/**
 * Fetch the per-month networth trend (sub-0007-03 chart). `months` is
 * the window size — backend default 12, max 24, min 1 (validated server
 * side).
 */
export async function fetchNetworthTrend(
  months: number,
  options: { signal?: AbortSignal } = {},
): Promise<DashboardNetworthTrend> {
  const params = new URLSearchParams();
  params.set("months", String(months));
  const raw = await apiRequest<unknown>(
    `/dashboard/networth-trend?${params.toString()}`,
    { signal: options.signal },
  );
  const adapted = adaptDashboardNetworthTrend(raw);
  if (adapted === null) {
    throw new ApiError(200, "Respons tren networth tidak dikenali.");
  }
  return adapted;
}

// --- /income-expense-trend -------------------------------------------------

interface RawIncomeExpensePointPayload {
  month?: unknown;
  income_cents?: unknown;
  expense_cents?: unknown;
}

interface RawIncomeExpenseTrendPayload {
  data?: unknown;
}

function adaptIncomeExpensePoint(
  raw: unknown,
): DashboardIncomeExpenseTrendPoint | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as RawIncomeExpensePointPayload;
  if (!isMonthLabel(r.month)) return null;
  return {
    month: r.month,
    incomeCents: toFiniteInt(r.income_cents),
    expenseCents: toFiniteInt(r.expense_cents),
  };
}

export function adaptDashboardIncomeExpenseTrend(
  raw: unknown,
): DashboardIncomeExpenseTrend | null {
  if (!raw || typeof raw !== "object") return null;
  const payload = raw as RawIncomeExpenseTrendPayload;
  if (!Array.isArray(payload.data)) return null;
  const data: DashboardIncomeExpenseTrendPoint[] = [];
  for (const item of payload.data) {
    const adapted = adaptIncomeExpensePoint(item);
    if (adapted) data.push(adapted);
  }
  return { data };
}

/**
 * Fetch the per-month income + expense trend (sub-0007-04 chart).
 * Same `months` window as the networth trend.
 */
export async function fetchIncomeExpenseTrend(
  months: number,
  options: { signal?: AbortSignal } = {},
): Promise<DashboardIncomeExpenseTrend> {
  const params = new URLSearchParams();
  params.set("months", String(months));
  const raw = await apiRequest<unknown>(
    `/dashboard/income-expense-trend?${params.toString()}`,
    { signal: options.signal },
  );
  const adapted = adaptDashboardIncomeExpenseTrend(raw);
  if (adapted === null) {
    throw new ApiError(200, "Respons tren pemasukan/pengeluaran tidak dikenali.");
  }
  return adapted;
}

// --- /top-categories -------------------------------------------------------

interface RawTopCategoryPayload {
  category_id?: unknown;
  category_name?: unknown;
  total_cents?: unknown;
  percentage?: unknown;
}

interface RawTopCategoriesPayload {
  data?: unknown;
}

function adaptTopCategory(raw: unknown): DashboardTopCategory | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as RawTopCategoryPayload;
  const totalCents = toFiniteInt(r.total_cents);
  const percentage =
    typeof r.percentage === "number" && Number.isFinite(r.percentage)
      ? r.percentage
      : 0;
  return {
    categoryId: toNullableString(r.category_id),
    categoryName: toNullableString(r.category_name),
    totalCents,
    percentage,
  };
}

export function adaptDashboardTopCategories(
  raw: unknown,
): DashboardTopCategories | null {
  if (!raw || typeof raw !== "object") return null;
  const payload = raw as RawTopCategoriesPayload;
  if (!Array.isArray(payload.data)) return null;
  const data: DashboardTopCategory[] = [];
  for (const item of payload.data) {
    const adapted = adaptTopCategory(item);
    if (adapted) data.push(adapted);
  }
  return { data };
}

/**
 * Fetch the top-N expense categories for the requested month
 * (sub-0007-05 chart). `month` accepts the BE's `YYYY-MM` form; the
 * server validates it (422 on malformed input). Omit `month` to fall
 * back to the BE's default (current calendar month).
 */
export async function fetchTopCategories(
  options: { limit?: number; month?: string; signal?: AbortSignal } = {},
): Promise<DashboardTopCategories> {
  const params = new URLSearchParams();
  if (options.month) params.set("month", options.month);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  const query = params.toString();
  const path = query ? `/dashboard/top-categories?${query}` : "/dashboard/top-categories";
  const raw = await apiRequest<unknown>(path, { signal: options.signal });
  const adapted = adaptDashboardTopCategories(raw);
  if (adapted === null) {
    throw new ApiError(200, "Respons kategori teratas tidak dikenali.");
  }
  return adapted;
}

// --- /goals-progress -------------------------------------------------------

interface RawGoalProgressPayload {
  goal_id?: unknown;
  name?: unknown;
  kind?: unknown;
  current_cents?: unknown;
  target_cents?: unknown;
  pct?: unknown;
  status?: unknown;
  due_date?: unknown;
}

interface RawGoalsProgressPayload {
  data?: unknown;
}

function adaptGoalProgress(raw: unknown): DashboardGoalProgress | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as RawGoalProgressPayload;
  if (typeof r.goal_id !== "string") return null;
  if (typeof r.name !== "string") return null;
  if (!isGoalKind(r.kind)) return null;
  if (!isGoalStatus(r.status)) return null;
  return {
    goalId: r.goal_id,
    name: r.name,
    kind: r.kind,
    currentCents: toFiniteInt(r.current_cents),
    targetCents: toFiniteInt(r.target_cents),
    pct:
      typeof r.pct === "number" && Number.isFinite(r.pct) ? r.pct : 0,
    status: r.status,
    dueDate: toNullableString(r.due_date),
  };
}

export function adaptDashboardGoalsProgress(
  raw: unknown,
): DashboardGoalsProgress | null {
  if (!raw || typeof raw !== "object") return null;
  const payload = raw as RawGoalsProgressPayload;
  if (!Array.isArray(payload.data)) return null;
  const data: DashboardGoalProgress[] = [];
  for (const item of payload.data) {
    const adapted = adaptGoalProgress(item);
    if (adapted) data.push(adapted);
  }
  return { data };
}

/**
 * Fetch the per-goal progress snapshot (sub-0007-06 widget). Returns
 * every non-archived goal plus a pre-resolved `status` enum so the FE
 * doesn't have to recompute the threshold-cross logic.
 */
export async function fetchGoalsProgress(options: {
  signal?: AbortSignal;
} = {}): Promise<DashboardGoalsProgress> {
  const raw = await apiRequest<unknown>("/dashboard/goals-progress", {
    signal: options.signal,
  });
  const adapted = adaptDashboardGoalsProgress(raw);
  if (adapted === null) {
    throw new ApiError(200, "Respons progres target tidak dikenali.");
  }
  return adapted;
}

// --- /debts-summary --------------------------------------------------------

interface RawDebtsSummaryPayload {
  total_remaining_cents?: unknown;
  total_interest_paid_cents?: unknown;
  active_count?: unknown;
  paid_off_count?: unknown;
}

export function adaptDashboardDebtsSummary(
  raw: unknown,
): DashboardDebtsSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as RawDebtsSummaryPayload;
  // No sentinel field — the BE never sets one, so we validate by
  // presence of every numeric field. Default to 0 on missing values
  // (the page renders zeros fine).
  if (
    r.total_remaining_cents === undefined ||
    r.total_interest_paid_cents === undefined ||
    r.active_count === undefined ||
    r.paid_off_count === undefined
  ) {
    return null;
  }
  return {
    totalRemainingCents: toFiniteInt(r.total_remaining_cents),
    totalInterestPaidCents: toFiniteInt(r.total_interest_paid_cents),
    activeCount: toFiniteInt(r.active_count),
    paidOffCount: toFiniteInt(r.paid_off_count),
  };
}

/**
 * Fetch the per-user debt ledger aggregate (sub-0007-06 widget).
 */
export async function fetchDebtsSummary(options: {
  signal?: AbortSignal;
} = {}): Promise<DashboardDebtsSummary> {
  const raw = await apiRequest<unknown>("/dashboard/debts-summary", {
    signal: options.signal,
  });
  const adapted = adaptDashboardDebtsSummary(raw);
  if (adapted === null) {
    throw new ApiError(200, "Respons ringkasan utang tidak dikenali.");
  }
  return adapted;
}

// --- bundle helper (optional convenience) ---------------------------------

/**
 * Convenience helper for the page-level parallel load: fire all six
 * endpoints in parallel under a shared `AbortSignal`. The caller is
 * responsible for the surrounding race-defense ref — see
 * `apps/web/src/app/page.tsx` (`latestLoadIdRef` + `abortControllerRef`
 * pattern).
 */
export interface DashboardLoadResult {
  summary: DashboardSummary;
  networthTrend: DashboardNetworthTrend;
  incomeExpenseTrend: DashboardIncomeExpenseTrend;
  topCategories: DashboardTopCategories;
  goalsProgress: DashboardGoalsProgress;
  debtsSummary: DashboardDebtsSummary;
}

export interface DashboardLoadOptions {
  trendMonths: number;
  topCategoriesLimit: number;
  signal: AbortSignal;
}

/**
 * Fetch the six dashboard endpoints in parallel. Any single rejection
 * surfaces as the rejection of the whole `Promise.all` so the page
 * renders the error-retry UI for a partial failure (matches
 * `transactions/bulanan/page.tsx` semantics — fail loud, don't
 * silently mask a 5xx with stale data).
 */
export async function loadDashboard(
  options: DashboardLoadOptions,
): Promise<DashboardLoadResult> {
  const signal = options.signal;
  const [
    summary,
    networthTrend,
    incomeExpenseTrend,
    topCategories,
    goalsProgress,
    debtsSummary,
  ] = await Promise.all([
    fetchDashboardSummary({ signal }),
    fetchNetworthTrend(options.trendMonths, { signal }),
    fetchIncomeExpenseTrend(options.trendMonths, { signal }),
    fetchTopCategories({ limit: options.topCategoriesLimit, signal }),
    fetchGoalsProgress({ signal }),
    fetchDebtsSummary({ signal }),
  ]);
  return {
    summary,
    networthTrend,
    incomeExpenseTrend,
    topCategories,
    goalsProgress,
    debtsSummary,
  };
}
