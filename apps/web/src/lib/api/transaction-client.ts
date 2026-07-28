import { ApiError, apiRequest, type ApiErrorBody } from "@/lib/api/client";
import {
  adaptTransaction,
  adaptTransactions,
  TRANSACTION_CREATABLE_TYPE_VALUES,
  TRANSACTION_TYPE_VALUES,
  type CreatableTransactionType,
  type Transaction,
  type TransactionType,
} from "@/lib/api/transactions";

export {
  TRANSACTION_CREATABLE_TYPE_VALUES,
  TRANSACTION_TYPE_VALUES,
  type CreatableTransactionType,
  type Transaction,
  type TransactionType,
};

/**
 * Friendly labels for the transaction type. Mirrors the
 * ``TransactionType`` enum in the backend and is used by both the
 * filter dropdown (sub-0003-06) and the type toggle on the create form
 * (sub-0003-05).
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
 * Payload for `POST /transactions`. `type` is locked to
 * ``"income"`` / ``"expense"`` — ``"transfer"`` is rejected by the
 * backend schema before any DB write.
 */
export interface TransactionCreatePayload {
  type: CreatableTransactionType;
  accountId: string;
  categoryId: string | null;
  amountCents: number;
  occurredOn: string;
  note: string | null;
}

/**
 * Payload for `PATCH /transactions/{id}` — every field is optional,
 * only the fields you set are sent. `type` is intentionally not
 * editable here; the backend schema rejects it with 422.
 */
export interface TransactionUpdatePayload {
  accountId?: string;
  categoryId?: string | null;
  amountCents?: number;
  occurredOn?: string;
  note?: string | null;
}

interface RawTransactionCreatePayload {
  type: CreatableTransactionType;
  account_id: string;
  category_id: string | null;
  amount_cents: number;
  currency: "IDR";
  occurred_on: string;
  note: string | null;
}

interface RawTransactionUpdatePayload {
  account_id?: string;
  category_id?: string | null;
  amount_cents?: number;
  currency?: "IDR";
  occurred_on?: string;
  note?: string | null;
}

function toCreatePayload(payload: TransactionCreatePayload): RawTransactionCreatePayload {
  return {
    type: payload.type,
    account_id: payload.accountId,
    category_id: payload.categoryId,
    amount_cents: payload.amountCents,
    currency: "IDR",
    occurred_on: payload.occurredOn,
    note: payload.note,
  };
}

function toUpdatePayload(payload: TransactionUpdatePayload): RawTransactionUpdatePayload {
  const out: RawTransactionUpdatePayload = {};
  if (payload.accountId !== undefined) out.account_id = payload.accountId;
  if (payload.categoryId !== undefined) out.category_id = payload.categoryId;
  if (payload.amountCents !== undefined) {
    out.amount_cents = payload.amountCents;
    out.currency = "IDR";
  }
  if (payload.occurredOn !== undefined) out.occurred_on = payload.occurredOn;
  if (payload.note !== undefined) out.note = payload.note;
  return out;
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
  const raw = await apiRequest<unknown>(`/transactions/${encodeURIComponent(id)}`, {
    signal: options.signal,
  });
  return adaptTransaction(raw);
}

/**
 * Create a new transaction. On success returns the persisted row. On
 * 422 the underlying `ApiError` is thrown; the form layer extracts
 * per-field errors via `extractTransactionValidationError`.
 */
export async function createTransaction(
  payload: TransactionCreatePayload,
): Promise<Transaction> {
  if (!TRANSACTION_CREATABLE_TYPE_VALUES.includes(payload.type)) {
    throw new Error("Tipe transaksi tidak valid untuk form ini.");
  }
  const raw = await apiRequest<unknown>("/transactions", {
    method: "POST",
    body: toCreatePayload(payload),
  });
  const adapted = adaptTransaction(raw);
  if (!adapted) {
    throw new Error("Respons transaksi baru tidak dikenali.");
  }
  return adapted;
}

/**
 * Patch an existing transaction. Only the fields present in `payload`
 * are sent (partial update). On 422 the underlying `ApiError` is
 * thrown; the form layer maps `detail[].loc` to per-field errors via
 * `extractTransactionValidationError`.
 */
export async function updateTransaction(
  id: string,
  payload: TransactionUpdatePayload,
): Promise<Transaction> {
  const raw = await apiRequest<unknown>(`/transactions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: toUpdatePayload(payload),
  });
  const adapted = adaptTransaction(raw);
  if (!adapted) {
    throw new Error("Respons pembaruan transaksi tidak dikenali.");
  }
  return adapted;
}

/**
 * Field names that the form binds to. Wire-only names — these are the
 * values the rest of the form layer uses (`errors.accountId`,
 * `errors.amountCents`, etc.) and the FE camelCase. The mapper below
 * translates backend snake_case (`loc: ["body", "amount_cents"]`) into
 * these.
 */
export const TRANSACTION_FORM_FIELDS = [
  "type",
  "accountId",
  "categoryId",
  "amountCents",
  "occurredOn",
  "note",
] as const;
export type TransactionFormField = (typeof TRANSACTION_FORM_FIELDS)[number];

export type TransactionFormErrors = Partial<Record<TransactionFormField, string>> &
  Record<string, string | undefined>;

export interface ExtractedTransactionValidationError {
  /** Field-level errors keyed by FE camelCase field name. */
  fieldErrors: TransactionFormErrors;
  /** Non-field errors (e.g. root-level Pydantic validators). */
  generalErrors: string[];
}

/**
 * Parse a 422 validation response from the backend into per-field
 * errors the form can render inline. Returns `null` when the error
 * isn't a 422 payload (callers should fall back to the generic
 * `ApiError.message`).
 *
 * The backend returns `detail: [{loc: ["body", "field_name"], msg, type}]`
 * for Pydantic failures. We join the `loc` segments excluding the
 * leading `"body"` and translate known snake_case names to the FE
 * camelCase ones the form binds to.
 */
export function extractTransactionValidationError(
  error: unknown,
): ExtractedTransactionValidationError | null {
  if (!(error instanceof ApiError) || error.status !== 422) {
    return null;
  }

  const fieldErrors: TransactionFormErrors = {};
  const generalErrors: string[] = [];

  const body = error.body;
  const detail = body && typeof body === "object" ? (body as { detail?: unknown }).detail : null;
  const list = Array.isArray(detail) ? detail : null;

  if (!list) {
    return null;
  }

  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const msg = typeof (entry as { msg?: unknown }).msg === "string"
      ? (entry as { msg: string }).msg
      : null;
    if (!msg) continue;

    const loc = Array.isArray((entry as { loc?: unknown }).loc)
      ? (entry as { loc: unknown[] }).loc
      : [];
    const fieldSegments = loc.filter(
      (segment): segment is string => typeof segment === "string" && segment !== "body",
    );

    if (fieldSegments.length === 0) {
      generalErrors.push(msg);
      continue;
    }

    const snakeField = fieldSegments[fieldSegments.length - 1];
    const camelField = snakeToTransactionField(snakeField);
    if (camelField) {
      const existing = fieldErrors[camelField];
      fieldErrors[camelField] = existing ? `${existing} ${msg}` : msg;
    } else {
      generalErrors.push(msg);
    }
  }

  return { fieldErrors, generalErrors };
}

function snakeToTransactionField(snake: string): TransactionFormField | null {
  switch (snake) {
    case "type":
      return "type";
    case "account_id":
      return "accountId";
    case "category_id":
      return "categoryId";
    case "amount_cents":
      return "amountCents";
    case "occurred_on":
      return "occurredOn";
    case "note":
      return "note";
    case "currency":
      // Currency is locked to IDR (not a form field). Surface to the
      // general error bucket so the user still sees the message.
      return null;
    default:
      return null;
  }
}

export type { ApiErrorBody };