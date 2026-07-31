import {
  EMPTY_TRANSACTION_SEARCH_FILTERS,
  TRANSACTION_SEARCH_PAGE_SIZE,
  type TransactionSearchFilters,
  type TransactionType,
} from "@/lib/api/transaction-client";

/**
 * URL → filter sync for the global search bar + filter panel
 * (sub-0004-05). The wire contract is the ``TransactionSearchListPublic``
 * query string documented for ``GET /transactions/search`` (sub-0004-03):
 *
 *   ``?q=…&type=…&account_id=…&category_id=…&date_from=…&date_to=…
 *      &amount_min_cents=…&amount_max_cents=…&page=…&page_size=…``
 *
 * Wire field names match the backend so a user can copy a URL from the
 * browser, paste it into chat, and the recipient lands on the same
 * filtered list. The FE echo the ``page`` + ``page_size`` back to the
 * API unconditionally so the BE doesn't have to re-derive them.
 *
 * Notes:
 *
 *   - ``amount_min_cents`` / ``amount_max_cents`` are sent as **cents**
 *     to avoid floating-point rounding (the create form uses the same
 *     convention, sub-0003-05).
 *   - ``q`` is the **raw** user input — the BE applies the portable
 *     escape (``%`` / ``_`` / ``\``) before building the SQL LIKE, so
 *     pre-escaping here would double-escape the user value and break
 *     exact searches.
 *   - Invalid / foreign values are ignored: a non-numeric amount is
 *     treated as "no filter", and a malformed type falls back to
 *     ``null``. A foreign ``account_id`` / ``category_id`` from a
 *     shared URL produces a 404 server-side which the FE renders as
 *     "tidak ditemukan" (sub-0004-03 notes).
 */

/** Keys that participate in the shareable URL filter state. */
export const TRANSACTION_SEARCH_URL_KEYS = [
  "q",
  "type",
  "account_id",
  "category_id",
  "date_from",
  "date_to",
  "amount_min_cents",
  "amount_max_cents",
  "page",
  "page_size",
] as const;
export type TransactionSearchUrlKey = (typeof TRANSACTION_SEARCH_URL_KEYS)[number];

/** Plain object form of `URLSearchParams` keyed by URL field name. */
export type TransactionSearchUrlState = Partial<
  Record<TransactionSearchUrlKey, string>
>;

const VALID_TRANSACTION_TYPES = new Set<string>(["income", "expense", "transfer"]);

function parseIsoDate(value: string | null): string | null {
  if (!value) return null;
  // `YYYY-MM-DD` (the canonical ``occurred_on`` storage shape). Anything
  // else is silently dropped so the URL can never crash the page.
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  const probe = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    probe.getUTCFullYear() !== Number(year) ||
    probe.getUTCMonth() !== Number(month) - 1 ||
    probe.getUTCDate() !== Number(day)
  ) {
    return null;
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function parseAmountCents(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function parsePage(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return parsed;
}

function parsePageSize(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  if (parsed > 200) return 200;
  return parsed;
}

function parseType(value: string | null): TransactionType | null {
  if (!value) return null;
  if (!VALID_TRANSACTION_TYPES.has(value)) return null;
  return value as TransactionType;
}

/**
 * Convert a URL search params snapshot into the typed
 * `TransactionSearchFilters` payload. Anything missing / invalid falls
 * back to the default (no filter). Returns a fresh object every call so
 * the caller can use it as state without worrying about reference
 * equality.
 */
export function parseTransactionSearchFilters(
  source:
    | URLSearchParams
    | ReadonlyURLSearchParamsLike
    | Record<string, string | string[] | undefined>
    | null
    | undefined,
): TransactionSearchFilters {
  const get = (key: string): string | null => readUrlParam(source, key);
  const q = (get("q") ?? "").trim();
  const type = parseType(get("type"));
  const accountId = sanitizeUuid(get("account_id"));
  const categoryId = sanitizeUuid(get("category_id"));
  const dateFrom = parseIsoDate(get("date_from"));
  const dateTo = parseIsoDate(get("date_to"));
  const amountMinCents = parseAmountCents(get("amount_min_cents"));
  const amountMaxCents = parseAmountCents(get("amount_max_cents"));
  const page = parsePage(get("page"), 1);
  const pageSize = parsePageSize(
    get("page_size"),
    TRANSACTION_SEARCH_PAGE_SIZE,
  );

  return {
    q,
    dateFrom,
    dateTo,
    accountId,
    type,
    categoryId,
    amountMinCents,
    amountMaxCents,
    page,
    pageSize,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sanitizeUuid(value: string | null): string | null {
  if (!value) return null;
  return UUID_RE.test(value) ? value : null;
}

/**
 * Read a single param out of any of the URLSearchParams-shaped inputs we
 * accept. Centralized so the same parsing rules apply to ``useSearchParams``
 * (which yields a readonly proxy), a hand-rolled ``URLSearchParams``, or a
 * Next.js page props ``searchParams``.
 */
function readUrlParam(
  source:
    | URLSearchParams
    | ReadonlyURLSearchParamsLike
    | Record<string, string | string[] | undefined>
    | null
    | undefined,
  key: string,
): string | null {
  if (!source) return null;
  if (typeof (source as URLSearchParams).get === "function") {
    const value = (source as URLSearchParams).get(key);
    return value && value.length > 0 ? value : null;
  }
  const raw = (source as Record<string, string | string[] | undefined>)[key];
  if (Array.isArray(raw)) {
    const first = raw[0];
    return first && first.length > 0 ? first : null;
  }
  return raw && raw.length > 0 ? raw : null;
}

/** Loose typing for the readonly proxy returned by `useSearchParams`. */
interface ReadonlyURLSearchParamsLike {
  get(key: string): string | null;
}

/**
 * Build a `URLSearchParams` snapshot from the typed filter state.
 *
 * Only non-default values are emitted so a "no filter" URL is a clean
 * ``/transactions`` path with no query string. The BE treats
 * ``amount_min_cents`` / ``amount_max_cents`` as **cents**, so the FE
 * converts IDR → cents before the round-trip (the search panel input
 * shows IDR but the wire value is cents — same convention as the
 * create form, sub-0003-05).
 */
export function buildTransactionSearchQuery(
  filters: TransactionSearchFilters,
): URLSearchParams {
  const params = new URLSearchParams();
  const trimmed = filters.q.trim();
  if (trimmed.length > 0) params.set("q", trimmed);
  if (filters.dateFrom) params.set("date_from", filters.dateFrom);
  if (filters.dateTo) params.set("date_to", filters.dateTo);
  if (filters.accountId) params.set("account_id", filters.accountId);
  if (filters.type) params.set("type", filters.type);
  if (filters.categoryId) params.set("category_id", filters.categoryId);
  if (filters.amountMinCents !== null && filters.amountMinCents >= 0) {
    params.set("amount_min_cents", String(Math.trunc(filters.amountMinCents)));
  }
  if (filters.amountMaxCents !== null && filters.amountMaxCents >= 0) {
    params.set("amount_max_cents", String(Math.trunc(filters.amountMaxCents)));
  }
  if (filters.page > 1) params.set("page", String(Math.trunc(filters.page)));
  if (filters.pageSize !== TRANSACTION_SEARCH_PAGE_SIZE) {
    params.set("page_size", String(Math.trunc(filters.pageSize)));
  }
  return params;
}

/**
 * `true` when the filter state carries anything that would change the
 * search result — used by the empty state copy ("cocok dengan filter ini"
 * vs "belum ada transaksi"). Also drives the "Reset semua filter"
 * button enable state on the panel.
 */
export function hasActiveTransactionSearchFilters(
  filters: TransactionSearchFilters,
): boolean {
  return Boolean(
    filters.q.trim() ||
      filters.dateFrom ||
      filters.dateTo ||
      filters.accountId ||
      filters.type ||
      filters.categoryId ||
      filters.amountMinCents !== null ||
      filters.amountMaxCents !== null,
  );
}

/**
 * Reset helper used by the filter panel "Reset semua filter" button.
 * Keeps the page size sticky so a user who bumped it to 100 doesn't get
 * snapped back to the default mid-investigation.
 */
export function resetTransactionSearchFilters(
  filters: TransactionSearchFilters,
): TransactionSearchFilters {
  return {
    ...EMPTY_TRANSACTION_SEARCH_FILTERS,
    pageSize: filters.pageSize,
  };
}