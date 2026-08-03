import { ApiError, apiRequest } from "@/lib/api/client";
import {
  adaptDebtSummary,
  adaptDebts,
  DEBT_KIND_LABEL,
  DEBT_KIND_VALUES,
  DEBT_STATUS_LABEL,
  DEBT_STATUS_VALUES,
  type Debt,
  type DebtKind,
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