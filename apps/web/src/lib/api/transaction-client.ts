import { ApiError, apiRequest } from "@/lib/api/client";
import {
  adaptTransaction,
  adaptTransactions,
  TRANSACTION_TYPE_VALUES,
  type Transaction,
  type TransactionType,
} from "@/lib/api/transactions";

export { TRANSACTION_TYPE_VALUES, type Transaction, type TransactionType };

/**
 * Friendly labels for the transaction type filter. Mirrors the
 * ``TransactionType`` enum in the backend.
 */
export const TRANSACTION_TYPE_LABEL: Record<TransactionType, string> = {
  income: "Pemasukan",
  expense: "Pengeluaran",
  transfer: "Transfer",
};

/** Default page size — matches the backend default for `GET /transactions`. */
export const TRANSACTION_PAGE_SIZE = 50;
/** Hard upper bound enforced by the backend (Query `le=200`). */
export const TRANSACTION_MAX_PAGE_SIZE = 200;

/**
 * Filter + pagination payload for `GET /transactions`. All fields are
 * optional — empty object returns the most recent default page (no
 * filters, default limit/offset).
 *
 * Wire field names match `TransactionListPublic` so the FE can echo
 * `total` + `limit` + `offset` back without re-deriving them.
 */
export interface TransactionListFilters {
  /** Inclusive lower bound on `occurred_on` (ISO `YYYY-MM-DD`). */
  dateFrom: string | null;
  /** Inclusive upper bound on `occurred_on` (ISO `YYYY-MM-DD`). */
  dateTo: string | null;
  /** Filter by source account. Must belong to the caller. */
  accountId: string | null;
  /** Filter by transaction type. */
  type: TransactionType | null;
  /** Filter by category id. */
  categoryId: string | null;
  /** Page size (default 50, max 200). */
  limit: number;
  /** Number of rows to skip from the start of the filtered result. */
  offset: number;
}

export const EMPTY_TRANSACTION_FILTERS: TransactionListFilters = {
  dateFrom: null,
  dateTo: null,
  accountId: null,
  type: null,
  categoryId: null,
  limit: TRANSACTION_PAGE_SIZE,
  offset: 0,
};

/**
 * Response envelope for `GET /transactions`. Mirrors
 * `TransactionListPublic` in `apps/api/src/app/api/schemas.py`.
 */
export interface TransactionListResult {
  items: Transaction[];
  total: number;
  limit: number;
  offset: number;
}

interface RawTransactionListPayload {
  items?: unknown;
  total?: unknown;
  limit?: unknown;
  offset?: unknown;
}

function toFiniteInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function adaptTransactionList(raw: unknown): TransactionListResult | null {
  if (!raw || typeof raw !== "object") return null;
  const payload = raw as RawTransactionListPayload;
  if (!Array.isArray(payload.items)) return null;

  return {
    items: adaptTransactions(payload.items),
    total: toFiniteInt(payload.total),
    limit: toFiniteInt(payload.limit),
    offset: toFiniteInt(payload.offset),
  };
}

function buildQuery(filters: TransactionListFilters): string {
  const params = new URLSearchParams();
  if (filters.dateFrom) params.set("date_from", filters.dateFrom);
  if (filters.dateTo) params.set("date_to", filters.dateTo);
  if (filters.accountId) params.set("account_id", filters.accountId);
  if (filters.type) params.set("type", filters.type);
  if (filters.categoryId) params.set("category_id", filters.categoryId);
  // Always send limit/offset so the FE can echo them back without a guess.
  params.set("limit", String(filters.limit));
  params.set("offset", String(filters.offset));
  const qs = params.toString();
  return qs.length > 0 ? `?${qs}` : "";
}

/**
 * Fetch a page of transactions from `GET /transactions`. Filters are
 * composable (AND); see `apps/api/src/app/api/v1/transactions.py` for the
 * server-side predicate list.
 *
 * Returns `null` when the response envelope is malformed (the page renders
 * the error-retry path in that case). Throws the underlying `ApiError`
 * for non-2xx responses so the caller can map the status to a friendly
 * message (401/403 → sesi berakhir, 422 → validation message, etc.).
 *
 * Accepts an `AbortSignal` so the caller can drop in-flight requests when
 * a newer load starts (race condition guard, see sub-0002-03 defect Cek 5).
 */
export async function fetchTransactions(
  filters: TransactionListFilters,
  options: { signal?: AbortSignal } = {},
): Promise<TransactionListResult> {
  const raw = await apiRequest<unknown>(`/transactions${buildQuery(filters)}`, {
    signal: options.signal,
  });
  const adapted = adaptTransactionList(raw);
  if (adapted === null) {
    throw new ApiError(200, "Respons transaksi tidak dikenali.");
  }
  return adapted;
}

/**
 * Fetch a single transaction by id. Returns `null` when the payload is
 * missing or the row doesn't belong to the caller (the endpoint returns
 * 404 for both cases, so the FE can't tell them apart — the edit page
 * treats `null` as "transaksi tidak ditemukan").
 */
export async function fetchTransactionById(
  id: string,
  options: { signal?: AbortSignal } = {},
): Promise<Transaction | null> {
  const raw = await apiRequest<unknown>(
    `/transactions/${encodeURIComponent(id)}`,
    { signal: options.signal },
  );
  return adaptTransaction(raw);
}
