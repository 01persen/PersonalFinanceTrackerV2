import { ApiError, apiRequest, type ApiErrorBody } from "@/lib/api/client";
import {
  TRANSACTION_TYPE_VALUES,
  type TransactionType,
} from "@/lib/api/transactions";

export { TRANSACTION_TYPE_VALUES, type TransactionType };

/**
 * One row of the per-category breakdown returned by `GET /transactions/summary`.
 * `categoryId` is `null` for transactions saved without a category — the
 * monthly view renders those under "Tanpa kategori" so the row stays
 * readable when the category has been deleted.
 */
export interface SummaryCategoryBreakdown {
  categoryId: string | null;
  categoryName: string | null;
  type: TransactionType;
  totalCents: number;
  transactionCount: number;
}

/**
 * One row of the per-account breakdown returned by `GET /transactions/summary`.
 * The pair `(type, accountId)` is the unique key; an account that received
 * income *and* paid expenses in the same month surfaces as two rows so the
 * FE can show net movement per account without re-aggregating client-side.
 */
export interface SummaryAccountBreakdown {
  accountId: string;
  accountName: string;
  type: TransactionType;
  totalCents: number;
  transactionCount: number;
}

/**
 * Response shape for `GET /transactions/summary`. All amounts are integer
 * cents (same convention as the rest of the API). Soft-deleted rows are
 * excluded by the backend; empty months are surfaced as zeros + empty
 * arrays (never 404) — the FE renders the empty state in that case.
 */
export interface TransactionSummary {
  year: number;
  month: number;
  currency: string;
  totalIncomeCents: number;
  totalExpenseCents: number;
  netCents: number;
  transactionCount: number;
  breakdownByCategory: SummaryCategoryBreakdown[];
  breakdownByAccount: SummaryAccountBreakdown[];
}

interface RawSummaryPayload {
  year: unknown;
  month: unknown;
  currency: unknown;
  total_income_cents: unknown;
  total_expense_cents: unknown;
  net_cents: unknown;
  transaction_count: unknown;
  breakdown_by_category: unknown;
  breakdown_by_account: unknown;
}

interface RawCategoryBreakdownPayload {
  category_id: unknown;
  category_name: unknown;
  type: unknown;
  total_cents: unknown;
  transaction_count: unknown;
}

interface RawAccountBreakdownPayload {
  account_id: unknown;
  account_name: unknown;
  type: unknown;
  total_cents: unknown;
  transaction_count: unknown;
}

function toFiniteInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function isTransactionType(value: unknown): value is TransactionType {
  return (
    typeof value === "string" &&
    (TRANSACTION_TYPE_VALUES as readonly string[]).includes(value)
  );
}

function adaptCategoryBreakdown(raw: unknown): SummaryCategoryBreakdown | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as RawCategoryBreakdownPayload;
  if (!isTransactionType(r.type)) return null;
  return {
    categoryId: typeof r.category_id === "string" ? r.category_id : null,
    categoryName: typeof r.category_name === "string" ? r.category_name : null,
    type: r.type,
    totalCents: toFiniteInt(r.total_cents),
    transactionCount: toFiniteInt(r.transaction_count),
  };
}

function adaptAccountBreakdown(raw: unknown): SummaryAccountBreakdown | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as RawAccountBreakdownPayload;
  if (typeof r.account_id !== "string" || typeof r.account_name !== "string") return null;
  if (!isTransactionType(r.type)) return null;
  return {
    accountId: r.account_id,
    accountName: r.account_name,
    type: r.type,
    totalCents: toFiniteInt(r.total_cents),
    transactionCount: toFiniteInt(r.transaction_count),
  };
}

/**
 * Hand-written adapter for `GET /transactions/summary`. Returns `null`
 * when the payload is missing or malformed — the page treats that as the
 * error-retry path (the same shape that the list view uses for
 * `adaptTransactionList`).
 */
export function adaptTransactionSummary(raw: unknown): TransactionSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as RawSummaryPayload;
  if (typeof r.year !== "number" || typeof r.month !== "number") return null;
  if (typeof r.currency !== "string") return null;
  if (!Array.isArray(r.breakdown_by_category) || !Array.isArray(r.breakdown_by_account)) return null;

  const breakdownByCategory: SummaryCategoryBreakdown[] = [];
  for (const item of r.breakdown_by_category) {
    const adapted = adaptCategoryBreakdown(item);
    if (adapted) breakdownByCategory.push(adapted);
  }

  const breakdownByAccount: SummaryAccountBreakdown[] = [];
  for (const item of r.breakdown_by_account) {
    const adapted = adaptAccountBreakdown(item);
    if (adapted) breakdownByAccount.push(adapted);
  }

  return {
    year: r.year,
    month: r.month,
    currency: r.currency,
    totalIncomeCents: toFiniteInt(r.total_income_cents),
    totalExpenseCents: toFiniteInt(r.total_expense_cents),
    netCents: toFiniteInt(r.net_cents),
    transactionCount: toFiniteInt(r.transaction_count),
    breakdownByCategory,
    breakdownByAccount,
  };
}

/**
 * Fetch the monthly summary from `GET /transactions/summary?year=&month=`.
 * The backend expects 1-indexed months (1 = January, 12 = December) and
 * returns 422 on out-of-range values — the page maps that to a friendly
 * "bulan tidak valid" message.
 *
 * Accepts an `AbortSignal` so the caller can drop in-flight requests when
 * a newer load starts (race condition guard, mirrors sub-0003-06).
 */
export async function fetchTransactionSummary(
  year: number,
  month: number,
  options: { signal?: AbortSignal } = {},
): Promise<TransactionSummary> {
  const params = new URLSearchParams();
  params.set("year", String(year));
  params.set("month", String(month));
  const raw = await apiRequest<unknown>(
    `/transactions/summary?${params.toString()}`,
    { signal: options.signal },
  );
  const adapted = adaptTransactionSummary(raw);
  if (adapted === null) {
    throw new ApiError(200, "Respons ringkasan transaksi tidak dikenali.");
  }
  return adapted;
}

export type { ApiErrorBody };
