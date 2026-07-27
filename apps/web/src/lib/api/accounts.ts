import type { ApiErrorBody } from "@/lib/api/client";

/**
 * Mirrors `AccountType` in `apps/api/src/app/db/models/enums.py`. The string
 * values come straight from the backend (snake_case), so we keep the same
 * literal spelling — renaming here would break the JSON contract.
 *
 * Source of truth: `apps/api/src/app/db/models/enums.py`.
 */
export const ACCOUNT_TYPE_VALUES = [
  "cash",
  "bank",
  "e_wallet",
  "investment",
  "credit_card",
  "other",
] as const;

export type AccountType = (typeof ACCOUNT_TYPE_VALUES)[number];

/** TL decision G1: derivative of `type` kept server-side in the payload. */
export const ACCOUNT_KIND_VALUES = ["asset", "liability"] as const;
export type AccountKind = (typeof ACCOUNT_KIND_VALUES)[number];

/**
 * Output shape for an account, mirroring `AccountPublic` in
 * `apps/api/src/app/api/schemas.py`.
 */
export interface Account {
  id: string;
  userId: string;
  name: string;
  type: AccountType;
  currency: string;
  openingBalanceCents: number;
  archived: boolean;
  isAsset: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Output shape for a single-account balance (sub-0002-02).
 * Mirrors `AccountBalancePublic`. `signed` is a UI hint: starting from
 * credit-card balances we always display liabilities as negative; assets
 * always display as positive.
 */
export interface AccountBalance {
  accountId: string;
  balanceCents: number;
  asOf: string;
}

/**
 * Output shape for the full balances snapshot (sub-0002-02).
 * Mirrors `AccountBalancesPublic` from `apps/api/src/app/api/schemas.py`.
 */
export interface AccountBalances {
  accounts: AccountBalance[];
  totalAssetsCents: number;
  totalLiabilitiesCents: number;
  networthCents: number;
}

/**
 * Helper to translate API snake_case payload into the FE camelCase shape.
 * Keeping the adapter explicit (and hand-written, no codegen — per SOP) so the
 * boundary is obvious when the API contract shifts.
 */
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

function isAccountType(value: unknown): value is AccountType {
  return typeof value === "string" && (ACCOUNT_TYPE_VALUES as readonly string[]).includes(value);
}

interface RawAccountPayload {
  id: unknown;
  user_id: unknown;
  name: unknown;
  type: unknown;
  currency: unknown;
  opening_balance_cents: unknown;
  archived: unknown;
  is_asset: unknown;
  created_at: unknown;
  updated_at: unknown;
}

function adaptAccountFromPayload(raw: RawAccountPayload): Account | null {
  if (
    typeof raw.id !== "string" ||
    typeof raw.user_id !== "string" ||
    typeof raw.name !== "string" ||
    !isAccountType(raw.type) ||
    typeof raw.currency !== "string"
  ) {
    return null;
  }

  return {
    id: raw.id,
    userId: raw.user_id,
    name: raw.name,
    type: raw.type,
    currency: raw.currency,
    openingBalanceCents: toFiniteInt(raw.opening_balance_cents),
    archived: raw.archived === true,
    isAsset: raw.is_asset === true,
    createdAt: toIsoString(raw.created_at, ""),
    updatedAt: toIsoString(raw.updated_at, ""),
  };
}

interface RawAccountBalancePayload {
  account_id: unknown;
  balance_cents: unknown;
  as_of: unknown;
}

function adaptBalance(raw: RawAccountBalancePayload): AccountBalance | null {
  if (typeof raw.account_id !== "string" || typeof raw.balance_cents === "undefined") {
    return null;
  }

  return {
    accountId: raw.account_id,
    balanceCents: toFiniteInt(raw.balance_cents),
    asOf: toIsoString(raw.as_of, ""),
  };
}

interface RawBalancesPayload {
  accounts: unknown;
  total_assets_cents: unknown;
  total_liabilities_cents: unknown;
  networth_cents: unknown;
}

/** Detect an error payload shape so `ApiError`'s message stays meaningful. */
export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return typeof value === "object" && value !== null && "detail" in value;
}

/**
 * Hand-written adapter for a single account object. Returns `null` when the
 * payload is missing/malformed — the caller (e.g. the edit page) treats
 * that as "akun tidak ditemukan".
 */
export function adaptAccount(raw: unknown): Account | null {
  if (!raw || typeof raw !== "object") return null;
  return adaptAccountFromPayload(raw as RawAccountPayload);
}

/**
 * Hand-written adapter for `GET /accounts`. Returns `[]` when the payload is
 * missing/malformed — the page treats that as the empty state, not an error.
 */
export function adaptAccounts(raw: unknown): Account[] {
  if (!Array.isArray(raw)) return [];
  const result: Account[] = [];
  for (const item of raw) {
    if (item && typeof item === "object") {
      const adapted = adaptAccountFromPayload(item as RawAccountPayload);
      if (adapted) result.push(adapted);
    }
  }
  return result;
}

/**
 * Hand-written adapter for `GET /accounts/balances`. Returns `null` when the
 * payload is malformed so the caller can show the error-retry path.
 */
export function adaptBalances(raw: unknown): AccountBalances | null {
  if (!raw || typeof raw !== "object") return null;
  const payload = raw as RawBalancesPayload;
  if (!Array.isArray(payload.accounts)) return null;

  const accounts: AccountBalance[] = [];
  for (const item of payload.accounts) {
    if (item && typeof item === "object") {
      const adapted = adaptBalance(item as RawAccountBalancePayload);
      if (adapted) accounts.push(adapted);
    }
  }

  return {
    accounts,
    totalAssetsCents: toFiniteInt(payload.total_assets_cents),
    totalLiabilitiesCents: toFiniteInt(payload.total_liabilities_cents),
    networthCents: toFiniteInt(payload.networth_cents),
  };
}
