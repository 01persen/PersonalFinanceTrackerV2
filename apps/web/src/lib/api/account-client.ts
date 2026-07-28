import { ApiError, apiRequest, type ApiErrorBody } from "@/lib/api/client";
import {
  ACCOUNT_TYPE_VALUES,
  adaptAccount,
  adaptAccounts,
  adaptBalances,
  type Account,
  type AccountBalances,
  type AccountType,
} from "@/lib/api/accounts";

export { ACCOUNT_TYPE_VALUES, type AccountType, type Account };

/**
 * Maps backend `AccountType` values to the human-friendly labels used in the
 * IDR-only MVP. Keep this idempotent and easy to swap when we add `category`
 * per epic-0003. Source enum: `apps/api/src/app/db/models/enums.py`.
 */
export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = {
  cash: "Tunai",
  bank: "Rekening bank",
  e_wallet: "Dompet digital",
  investment: "Investasi",
  credit_card: "Kartu kredit",
  other: "Akun lain",
};

const IDR_FORMATTER = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

const IDR_SIGNED_FORMATTER = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  signDisplay: "auto",
  maximumFractionDigits: 0,
});

/**
 * The backend stores balances as `*_cents` (integer, IDR minor units —
 * 1/100 rupiah). For the MVP display IDR has no sub-rupiah coins in real
 * circulation, so we keep whole-rupiah formatting via `/100` and round to
 * the nearest integer.
 */
function centsToRupiah(cents: number): number {
  return Math.round(cents / 100);
}

/**
 * Format a cents amount as Indonesian Rupiah without decimals.
 * Negative cents → prefixed by `-` (e.g. `-Rp 100.000`). The FE mirrors the
 * signed `balance_cents` returned by sub-0002-02 — assets stay positive,
 * liabilities stay negative.
 */
export function formatIdrFromCents(cents: number): string {
  return IDR_FORMATTER.format(centsToRupiah(cents));
}

/**
 * Like `formatIdrFromCents` but lets positive amounts render with an explicit
 * `+` prefix when wanted (used in summary tiles).
 */
export function formatIdrFromCentsSigned(cents: number): string {
  return IDR_SIGNED_FORMATTER.format(centsToRupiah(cents));
}

/**
 * Format just the integer portion (no Rp prefix) for compact tiles.
 */
export function formatIdrAmountOnly(cents: number): string {
  const formatter = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 });
  return formatter.format(centsToRupiah(cents));
}

/**
 * Fetch the user's active accounts (excludes archived). Sorted by
 * backend — assets first, then name ascending — but we always re-sort on the
 * FE so display logic doesn't change silently if the API order shifts.
 *
 * Accepts an `AbortSignal` so the caller can drop in-flight requests when a
 * newer load starts (race condition guard, see sub-0002-03 defect Cek 5).
 */
export async function fetchAccounts(options: { signal?: AbortSignal } = {}): Promise<Account[]> {
  const raw = await apiRequest<unknown>("/accounts", { signal: options.signal });
  return adaptAccounts(raw);
}

/**
 * Fetch a single account by id. Returns `null` when the payload is missing
 * or the row doesn't belong to the caller (the endpoint returns 404 for both
 * cases, so the FE can't tell them apart — the edit page treats `null` as
 * "tidak ditemukan").
 */
export async function fetchAccountById(
  id: string,
  options: { signal?: AbortSignal } = {},
): Promise<Account | null> {
  const raw = await apiRequest<unknown>(`/accounts/${encodeURIComponent(id)}`, {
    signal: options.signal,
  });
  return adaptAccount(raw);
}

/**
 * Fetch the balances snapshot from `/accounts/balances`. Throws the underlying
 * `ApiError` from `apiRequest` when the response is not 2xx — the page is
 * expected to render the retry UI for that case.
 *
 * Accepts an `AbortSignal` so the caller can drop in-flight requests when a
 * newer load starts (race condition guard, see sub-0002-03 defect Cek 5).
 */
export async function fetchBalances(options: { signal?: AbortSignal } = {}): Promise<AccountBalances | null> {
  const raw = await apiRequest<unknown>("/accounts/balances", { signal: options.signal });
  return adaptBalances(raw);
}

/**
 * Payload for `POST /accounts`. Currency is locked to IDR (the MVP is
 * single-currency per PRD §10) — we never expose it as a field on the form.
 */
export interface AccountCreatePayload {
  name: string;
  type: AccountType;
  openingBalanceCents: number;
}

/**
 * Payload for `PATCH /accounts/{id}`. All fields are optional — only the
 * ones you set are sent. `archived` is set to flip the soft-delete flag.
 */
export interface AccountUpdatePayload {
  name?: string;
  type?: AccountType;
  openingBalanceCents?: number;
  archived?: boolean;
}

interface RawAccountCreatePayload {
  name: string;
  type: AccountType;
  currency: "IDR";
  opening_balance_cents: number;
}

interface RawAccountUpdatePayload {
  name?: string;
  type?: AccountType;
  opening_balance_cents?: number;
  archived?: boolean;
}

function toCreatePayload(payload: AccountCreatePayload): RawAccountCreatePayload {
  return {
    name: payload.name,
    type: payload.type,
    currency: "IDR",
    opening_balance_cents: payload.openingBalanceCents,
  };
}

function toUpdatePayload(payload: AccountUpdatePayload): RawAccountUpdatePayload {
  const out: RawAccountUpdatePayload = {};
  if (payload.name !== undefined) out.name = payload.name;
  if (payload.type !== undefined) out.type = payload.type;
  if (payload.openingBalanceCents !== undefined) {
    out.opening_balance_cents = payload.openingBalanceCents;
  }
  if (payload.archived !== undefined) out.archived = payload.archived;
  return out;
}

/**
 * Create a new account. On success returns the persisted `Account` (with
 * derived `is_asset`). On 422 the underlying `ApiError` is thrown — the
 * form layer extracts per-field errors via `extractValidationErrors`.
 */
export async function createAccount(payload: AccountCreatePayload): Promise<Account> {
  const raw = await apiRequest<unknown>("/accounts", {
    method: "POST",
    body: toCreatePayload(payload),
  });
  const adapted = adaptAccount(raw);
  if (!adapted) {
    throw new Error("Respons akun baru tidak dikenali.");
  }
  return adapted;
}

/**
 * Patch an existing account. Only the fields present in `payload` are
 * sent (partial update). On 422 the underlying `ApiError` is thrown; the
 * form layer maps `detail[].loc` to per-field errors via
 * `extractValidationErrors`.
 */
export async function updateAccount(
  id: string,
  payload: AccountUpdatePayload,
): Promise<Account> {
  const raw = await apiRequest<unknown>(`/accounts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: toUpdatePayload(payload),
  });
  const adapted = adaptAccount(raw);
  if (!adapted) {
    throw new Error("Respons pembaruan akun tidak dikenali.");
  }
  return adapted;
}

/**
 * Soft-delete an account by setting `archived = true` (the backend DELETE
 * endpoint is also soft-delete, but PATCH /archived keeps the form flow
 * single-path). Returns void on success.
 */
export async function archiveAccount(id: string): Promise<Account> {
  return updateAccount(id, { archived: true });
}

/**
 * Field names that the form binds to. Wire-only names — these are the
 * values the rest of the form layer uses (`errors.name`, `errors.type`,
 * etc.) and the FE camelCase. The mapper below translates backend
 * snake_case (`loc: ["body", "opening_balance_cents"]`) into these.
 */
export const ACCOUNT_FORM_FIELDS = [
  "name",
  "type",
  "openingBalanceCents",
] as const;
export type AccountFormField = (typeof ACCOUNT_FORM_FIELDS)[number];

export type AccountFormErrors = Partial<Record<AccountFormField, string>> &
  Record<string, string | undefined>;

export interface ExtractedValidationError {
  /** Field-level errors keyed by FE camelCase field name. */
  fieldErrors: AccountFormErrors;
  /** Non-field errors (e.g. root-level Pydantic validators). */
  generalErrors: string[];
}

/**
 * Parse a 422 validation response from the backend into per-field errors
 * the form can render inline. Returns `null` when the error isn't a 422
 * payload (callers should fall back to the generic `ApiError.message`).
 *
 * The backend returns `detail: [{loc: ["body", "field_name"], msg, type}]`
 * for Pydantic failures. We join the `loc` segments excluding the leading
 * `"body"` and translate known snake_case names to the FE camelCase ones
 * the form binds to.
 */
export function extractValidationError(error: unknown): ExtractedValidationError | null {
  if (!(error instanceof ApiError) || error.status !== 422) {
    return null;
  }

  const fieldErrors: AccountFormErrors = {};
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
    const camelField = snakeToCamelField(snakeField);
    if (camelField) {
      const existing = fieldErrors[camelField];
      fieldErrors[camelField] = existing ? `${existing} ${msg}` : msg;
    } else {
      generalErrors.push(msg);
    }
  }

  return { fieldErrors, generalErrors };
}

function snakeToCamelField(snake: string): AccountFormField | null {
  switch (snake) {
    case "name":
      return "name";
    case "type":
      return "type";
    case "opening_balance_cents":
      return "openingBalanceCents";
    case "currency":
    case "archived":
      // Currency is locked to IDR (not a form field); archived is a
      // checkbox without backend validation. Either way, surface to the
      // general error bucket so the user still sees the message.
      return null;
    default:
      return null;
  }
}

/**
 * Re-export `ApiErrorBody` so import sites that already pull from
 * `account-client` don't have to drill into `client.ts` for the type.
 */
export type { ApiErrorBody };
