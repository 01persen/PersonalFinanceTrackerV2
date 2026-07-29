import type { ApiErrorBody } from "@/lib/api/client";
import type { CategoryKind } from "@/lib/api/categories";

/**
 * Mirrors `TransactionType` in `apps/api/src/app/db/models/enums.py`. The
 * full enum is exposed to the list view so a `transfer` row (created via
 * the paired-create endpoint in sub-0003-03) is rendered with the right
 * badge; the create form narrows to `income`/`expense` only.
 */
export const TRANSACTION_TYPE_VALUES = ["income", "expense", "transfer"] as const;
export type TransactionType = (typeof TRANSACTION_TYPE_VALUES)[number];

/**
 * The subset of ``TransactionType`` accepted by ``POST /transactions``.
 * Used by the create form's type toggle — anything outside this set is
 * read-only on the edit page (e.g. a ``transfer`` row that came back
 * from the paired-create endpoint).
 */
export const TRANSACTION_CREATABLE_TYPE_VALUES = ["income", "expense"] as const;
export type CreatableTransactionType =
  (typeof TRANSACTION_CREATABLE_TYPE_VALUES)[number];

/**
 * Output shape for a single transaction row, mirroring `TransactionPublic`
 * in `apps/api/src/app/api/schemas.py`.
 */
export interface Transaction {
  id: string;
  userId: string;
  accountId: string;
  categoryId: string | null;
  type: TransactionType;
  amountCents: number;
  currency: string;
  occurredOn: string;
  note: string | null;
  transferPairId: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RawTransactionPayload {
  id: unknown;
  user_id: unknown;
  account_id: unknown;
  category_id: unknown;
  type: unknown;
  amount_cents: unknown;
  currency: unknown;
  occurred_on: unknown;
  note: unknown;
  transfer_pair_id: unknown;
  deleted_at: unknown;
  created_at: unknown;
  updated_at: unknown;
}

function toFiniteInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function toIsoString(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  return fallback;
}

function isTransactionType(value: unknown): value is TransactionType {
  return (
    typeof value === "string" &&
    (TRANSACTION_TYPE_VALUES as readonly string[]).includes(value)
  );
}

/**
 * Hand-written adapter for `GET /transactions/{id}` (and the items in
 * `GET /transactions`). Returns `null` when the payload is missing or
 * malformed — the caller (e.g. the edit page) treats that as
 * "transaksi tidak ditemukan".
 */
export function adaptTransaction(raw: unknown): Transaction | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as RawTransactionPayload;
  if (
    typeof r.id !== "string" ||
    typeof r.user_id !== "string" ||
    typeof r.account_id !== "string" ||
    !isTransactionType(r.type) ||
    typeof r.currency !== "string" ||
    typeof r.occurred_on !== "string"
  ) {
    return null;
  }

  return {
    id: r.id,
    userId: r.user_id,
    accountId: r.account_id,
    categoryId: typeof r.category_id === "string" ? r.category_id : null,
    type: r.type,
    amountCents: toFiniteInt(r.amount_cents),
    currency: r.currency,
    occurredOn: r.occurred_on,
    note: typeof r.note === "string" ? r.note : null,
    transferPairId: typeof r.transfer_pair_id === "string" ? r.transfer_pair_id : null,
    deletedAt: toIsoString(r.deleted_at, ""),
    createdAt: toIsoString(r.created_at, ""),
    updatedAt: toIsoString(r.updated_at, ""),
  };
}

/**
 * Hand-written adapter for `GET /transactions` (list). Returns `[]` when
 * the payload is missing/malformed — the page treats that as the empty
 * state, not an error.
 */
export function adaptTransactions(raw: unknown): Transaction[] {
  if (!Array.isArray(raw)) return [];
  const out: Transaction[] = [];
  for (const item of raw) {
    if (item && typeof item === "object") {
      const adapted = adaptTransaction(item as RawTransactionPayload);
      if (adapted) out.push(adapted);
    }
  }
  return out;
}

/**
 * Map a ``TransactionType`` to its matching ``CategoryKind``. ``transfer``
 * has no category (it's an account-to-account move), so this helper is
 * scoped to the creatable subset — the assert keeps ``mypy --strict``
 * happy for the narrow subset callers actually use.
 */
export function transactionTypeToCategoryKind(
  type: CreatableTransactionType,
): CategoryKind {
  if (type === "income") return "income";
  return "expense";
}

export type { ApiErrorBody };