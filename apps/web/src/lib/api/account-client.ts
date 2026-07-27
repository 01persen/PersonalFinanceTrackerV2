import { apiRequest } from "@/lib/api/client";
import {
  adaptAccounts,
  adaptBalances,
  type Account,
  type AccountBalances,
  type AccountType,
} from "@/lib/api/accounts";

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
