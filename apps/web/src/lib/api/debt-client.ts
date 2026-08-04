import { ApiError, apiRequest } from "@/lib/api/client";
import {
  adaptDebt,
  adaptDebtPaymentList,
  adaptDebtSummary,
  adaptDebts,
  DEBT_KIND_LABEL,
  DEBT_KIND_VALUES,
  DEBT_STATUS_LABEL,
  DEBT_STATUS_VALUES,
  type Debt,
  type DebtKind,
  type DebtPayment,
  type DebtPaymentPage,
  type DebtStatus,
  type DebtSummary,
} from "@/lib/api/debts";

export {
  DEBT_KIND_LABEL,
  DEBT_KIND_VALUES,
  DEBT_STATUS_LABEL,
  DEBT_STATUS_VALUES,
  type Debt,
  type DebtKind,
  type DebtPayment,
  type DebtPaymentPage,
  type DebtStatus,
  type DebtSummary,
};

/**
 * Status filter for the read-only list page (sub-0006-04). The
 * `active` chip maps to the persisted `status == active` rows, the
 * `paid_off` chip maps to `status == paid_off`, and `all` is the
 * unfiltered view. Mirrors the enum but lives here so the list page
 * can keep its import surface flat.
 */
export const DEBT_FILTER_VALUES = ["all", "active", "paid_off"] as const;
export type DebtFilterValue = (typeof DEBT_FILTER_VALUES)[number];

export const DEBT_FILTER_LABEL: Record<DebtFilterValue, string> = {
  all: "Semua",
  active: "Aktif",
  paid_off: "Lunas",
};

export const DEBT_KIND_FILTER_VALUES = ["all", ...DEBT_KIND_VALUES] as const;
export type DebtKindFilterValue = (typeof DEBT_KIND_FILTER_VALUES)[number];

export const DEBT_KIND_FILTER_LABEL: Record<DebtKindFilterValue, string> = {
  all: "Semua jenis",
  loan: "Pinjaman",
  credit_card: "Kartu kredit",
  paylater: "Paylater",
  KTA: "KTA",
  KKB: "KKB",
  KPR: "KPR",
  other: "Lainnya",
};

const IDR_FORMATTER = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

const IDR_COMPACT_FORMATTER = new Intl.NumberFormat("id-ID", {
  maximumFractionDigits: 0,
});

const PERCENT_FORMATTER = new Intl.NumberFormat("id-ID", {
  style: "decimal",
  maximumFractionDigits: 2,
});

const DATE_FORMATTER = new Intl.DateTimeFormat("id-ID", {
  day: "2-digit",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * Cents → whole-rupiah conversion. IDR has no sub-rupiah coins in
 * circulation so we round to the nearest integer; mirrors the BE
 * helper used by the goals list (sub-0005-03).
 */
function centsToRupiah(cents: number): number {
  return Math.round(cents / 100);
}

/**
 * Format a cents amount as Indonesian Rupiah without decimals. Used
 * everywhere the debt list surfaces a money figure — `remaining`,
 * `principal`, `monthly payment`, `interest paid`.
 */
export function formatDebtIdrFromCents(cents: number): string {
  return IDR_FORMATTER.format(centsToRupiah(cents));
}

/**
 * Format just the integer portion (no `Rp` prefix) for compact tiles
 * inside the ringkasan card.
 */
export function formatDebtIdrAmountOnly(cents: number): string {
  return IDR_COMPACT_FORMATTER.format(centsToRupiah(cents));
}

/**
 * Format `bunga_pct` (annual decimal, e.g. `10.0` for 10%) as a
 * localised percentage string. Always two decimals at most so a
 * `0.075` rate still reads `0,08%` instead of `0%`.
 */
export function formatDebtBungaPct(pct: number): string {
  if (!Number.isFinite(pct)) return "0%";
  return `${PERCENT_FORMATTER.format(pct)}%`;
}

/**
 * Parse `YYYY-MM-DD` as a UTC calendar date so timezone drift doesn't
 * shift the day. Returns `null` when the input is malformed — the
 * caller decides whether to render the raw value or a placeholder.
 */
export function parseIsoDate(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

/**
 * Format an ISO `YYYY-MM-DD` string as an Indonesian long date. Falls
 * back to the raw input on parse failure so the card still renders
 * something readable instead of an empty string.
 */
export function formatDebtIsoDate(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = parseIsoDate(value);
  if (!parsed) return value;
  return DATE_FORMATTER.format(parsed);
}

/**
 * Fetch the user's full debt list from `GET /debts`. Backend sorts
 * `start_date desc, created_at desc, id asc` (sub-0006-01) so the FE
 * never has to re-sort for stability — we mirror the same order on
 * the FE only after the status / kind filter narrows the set.
 *
 * Accepts an `AbortSignal` so the caller can drop in-flight requests
 * when a newer load starts (race condition guard, sub-0002-03 Cek 5).
 */
export async function fetchDebts(options: { signal?: AbortSignal } = {}): Promise<Debt[]> {
  const raw = await apiRequest<unknown>("/debts", { signal: options.signal });
  return adaptDebts(raw);
}

/**
 * Fetch the summary for a single debt from `GET /debts/{id}/summary`
 * (sub-0006-03). Returns `null` when the payload is missing/malformed
 * so the caller can render the error/retry path per row without
 * failing the entire list.
 *
 * Accepts an `AbortSignal` so the caller can drop in-flight requests
 * when a newer load starts or the row is unmounted mid-fetch.
 */
export async function fetchDebtSummary(
  debtId: string,
  options: { signal?: AbortSignal } = {},
): Promise<DebtSummary | null> {
  const raw = await apiRequest<unknown>(
    `/debts/${encodeURIComponent(debtId)}/summary`,
    { signal: options.signal },
  );
  return adaptDebtSummary(raw);
}

/* -------------------------------------------------------------------------- *
 * sub-0006-06 — Detail page (debt by id + payment history)                   *
 * -------------------------------------------------------------------------- *
 *
 * The detail page (`apps/web/src/app/debts/[id]/page.tsx`) reads:
 *
 *   - `GET /debts/{id}` to render the debt header + meta (name, kind,
 *     principal, bunga, tenor, start_date, status badge, note).
 *   - `GET /debts/{id}/summary` for the live `remaining_principal_cents`
 *     + `total_interest_paid_cents` + `next_payment_due_date` row.
 *   - `GET /debts/{id}/payments?limit=50&offset=...` for the
 *     paginated history table (sub-0006-06 AC).
 *
 * All three are routed through this file so the page can import a
 * flat surface — the same convention used by sub-0006-04 (list
 * + per-row summary fan-out) and sub-0006-05 (form payload + per-row
 * create).
 */

/**
 * Fetch a single debt by id from `GET /debts/{id}` (sub-0006-01).
 * Returns `null` when the payload is missing/malformed or the row
 * doesn't belong to the caller (the endpoint returns 404 for both
 * cases so the FE can't tell them apart — same convention as
 * `fetchGoalById` from sub-0005-03). The page surfaces the
 * `null` return as a "Utang tidak ditemukan" panel.
 *
 * Accepts an `AbortSignal` so the caller can drop in-flight requests
 * when a newer load starts (race condition guard, sub-0002-03 Cek 5).
 */
export async function fetchDebtById(
  id: string,
  options: { signal?: AbortSignal } = {},
): Promise<Debt | null> {
  const raw = await apiRequest<unknown>(`/debts/${encodeURIComponent(id)}`, {
    signal: options.signal,
  });
  return adaptDebt(raw);
}

/**
 * Default page size for the history table. Matches the BE default
 * (`limit=50` in `apps/api/src/app/api/v1/debts.py`) and the
 * transactions list convention so the table renders a familiar
 * density on first paint.
 */
export const DEBT_HISTORY_DEFAULT_PAGE_SIZE = 50;

/**
 * Maximum page size the FE will request. Matches the BE ceiling
 * (`le=200` on the `limit` query param) so a stale `?size=` query
 * param in the URL can never trigger a 422.
 */
export const DEBT_HISTORY_MAX_PAGE_SIZE = 200;

/**
 * Options for `fetchDebtPayments`. Mirrors the `list_debt_payments`
 * query params on the BE (sub-0006-02) so the FE can drive the
 * paginated history table without a follow-up GET.
 */
export interface FetchDebtPaymentsOptions {
  /**
   * 1-based page index (the BE uses 0-based `offset`; the FE works
   * in pages to keep the URL + pagination control human-readable).
   * Defaults to `0` (first page).
   */
  page?: number;
  /**
   * Page size. Defaults to `DEBT_HISTORY_DEFAULT_PAGE_SIZE` (50) and
   * is clamped to `[1, DEBT_HISTORY_MAX_PAGE_SIZE]` so a stale
   * `?size=` URL param can never request a 422.
   */
  pageSize?: number;
  /** Optional abort signal — race defense (sub-0002-03 Cek 5). */
  signal?: AbortSignal;
}

/**
 * Fetch the paginated cicilan list for a debt from
 * `GET /debts/{id}/payments?limit=...&offset=...` (sub-0006-02).
 *
 * Returns `null` when the payload is missing/malformed or the debt
 * id doesn't belong to the caller (the BE returns 404 for both, and
 * the FE maps both to the "Utang tidak ditemukan" panel — same
 * convention as `fetchDebtById`).
 *
 * Page-size clamping prevents a stale `?size=` URL from triggering a
 * 422; the BE cap is `200` and the FE mirrors that ceiling.
 */
export async function fetchDebtPayments(
  debtId: string,
  options: FetchDebtPaymentsOptions = {},
): Promise<DebtPaymentPage | null> {
  const page = options.page !== undefined && options.page > 0 ? Math.floor(options.page) : 0;
  const requestedSize =
    options.pageSize !== undefined && options.pageSize > 0
      ? Math.floor(options.pageSize)
      : DEBT_HISTORY_DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(
    Math.max(requestedSize, 1),
    DEBT_HISTORY_MAX_PAGE_SIZE,
  );
  const offset = page * pageSize;

  const query: string[] = [];
  query.push(`limit=${pageSize}`);
  query.push(`offset=${offset}`);

  const raw = await apiRequest<unknown>(
    `/debts/${encodeURIComponent(debtId)}/payments?${query.join("&")}`,
    { signal: options.signal },
  );
  return adaptDebtPaymentList(raw);
}

/**
 * Defensive client-side sort of a payment list. The BE already sorts
 * `occurred_on DESC, created_at DESC, id ASC` (sub-0006-02), so this
 * helper is a no-op for well-formed responses. It's exported because:
 *
 *   1. The unit test pins the ordering contract without hitting the
 *      BE (mirrors the `sortDebtsForDisplay` pattern from
 *      sub-0006-04).
 *   2. A future schema migration (e.g. moving the sort server-side
 *      via cursor pagination) would let the FE keep rendering the
 *      same order without a regression hunt.
 */
export function sortPaymentsByDateDesc(payments: DebtPayment[]): DebtPayment[] {
  return [...payments].sort((left, right) => {
    const leftTime = Date.parse(left.occurredOn);
    const rightTime = Date.parse(right.occurredOn);
    const leftTs = Number.isFinite(leftTime) ? leftTime : 0;
    const rightTs = Number.isFinite(rightTime) ? rightTime : 0;
    if (leftTs !== rightTs) return rightTs - leftTs;

    const leftCreated = Date.parse(left.createdAt);
    const rightCreated = Date.parse(right.createdAt);
    const leftCreatedTs = Number.isFinite(leftCreated) ? leftCreated : 0;
    const rightCreatedTs = Number.isFinite(rightCreated) ? rightCreated : 0;
    if (leftCreatedTs !== rightCreatedTs) {
      return rightCreatedTs - leftCreatedTs;
    }

    return left.id.localeCompare(right.id);
  });
}

/**
 * Map any thrown value to a friendly Indonesian message. Mirrors the
 * `formatGoalApiError` convention so the error UI across the app
 * stays consistent: 401/403 → sesi berakhir, 404 → tidak ditemukan,
 * 5xx → server gangguan.
 */
export function formatDebtApiError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return "Sesi kamu sudah berakhir. Masuk lagi untuk memuat daftar utang.";
    }
    if (error.status === 404) {
      return "Utang tidak ditemukan atau sudah dihapus.";
    }
    if (error.status >= 500) {
      return "Server sedang bermasalah. Coba lagi beberapa saat.";
    }
    return error.message || fallback;
  }
  if (error instanceof Error && error.message.startsWith("Respons")) {
    return error.message;
  }
  return fallback;
}

/**
 * Aggregate the user's debt list into the four ringkasan tiles the
 * dashboard surfaces (sub-0006-04). Exported as a pure helper so the
 * page can re-derive after every filter change without a backend
 * round-trip and the unit test can pin the rounding / sorting in
 * isolation from React.
 *
 * Tile semantics:
 *
 *   - `totalRemainingCents` — sum of `summary.remaining_principal_cents`
 *     across every active debt. A paid-off row always reports
 *     `remaining_principal_cents == 0` server-side, so summing both
 *     groups is harmless; we still gate the loop so a stray summary
 *     payload for an unpaid debt can never inflate the tile.
 *   - `totalPrincipalCents` — sum of every debt's `principal_cents`,
 *     including paid-off rows. Reflects the user's total *committed*
 *     debt over time.
 *   - `totalInterestPaidCents` — sum of `summary.total_interest_paid_cents`
 *     across every debt that has a summary (active + paid-off). The
 *     paid-off interest is the loan's lifetime interest and is the
 *     interesting number on the dashboard ("how much have I paid in
 *     bunga across all debts"). Falls back to `0` when the summary
 *     hasn't loaded yet for a row.
 *   - `totalMonthlyPaymentCents` — sum of `monthly_payment_cents`
 *     across every active debt; ignores nulls (no schedule) and
 *     paid-off rows.
 *
 * `tenorlessCount` counts active debts whose `tenor_months` is
 * `null` ("Tanpa jadwal tetap") so the page can surface a small
 * explanatory line under the cicilan tile — the spec calls out this
 * exact UX in sub-0006-04 acceptance criteria.
 */
export function aggregateDebtTotals(args: {
  debts: Debt[];
  summaries: Map<string, DebtSummary>;
}): {
  totalRemainingCents: number;
  totalPrincipalCents: number;
  totalInterestPaidCents: number;
  totalMonthlyPaymentCents: number;
  activeCount: number;
  paidOffCount: number;
  tenorlessCount: number;
} {
  let totalRemainingCents = 0;
  let totalPrincipalCents = 0;
  let totalInterestPaidCents = 0;
  let totalMonthlyPaymentCents = 0;
  let activeCount = 0;
  let paidOffCount = 0;
  let tenorlessCount = 0;

  for (const debt of args.debts) {
    totalPrincipalCents += debt.principalCents;
    const summary = args.summaries.get(debt.id);
    if (summary) {
      totalInterestPaidCents += summary.totalInterestPaidCents;
    }
    if (debt.status === "paid_off") {
      paidOffCount += 1;
    } else {
      activeCount += 1;
      if (debt.tenorMonths === null) {
        tenorlessCount += 1;
      }
      if (summary) {
        totalRemainingCents += summary.remainingPrincipalCents;
      }
      if (debt.monthlyPaymentCents !== null) {
        totalMonthlyPaymentCents += debt.monthlyPaymentCents;
      }
    }
  }

  return {
    totalRemainingCents,
    totalPrincipalCents,
    totalInterestPaidCents,
    totalMonthlyPaymentCents,
    activeCount,
    paidOffCount,
    tenorlessCount,
  };
}