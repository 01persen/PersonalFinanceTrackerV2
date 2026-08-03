import { ApiError, apiRequest, type ApiErrorBody } from "@/lib/api/client";
import {
  adaptDebt,
  adaptDebtPayment,
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

/* -------------------------------------------------------------------------- *
 * sub-0006-05 — Form CRUD + payment form                                     *
 * -------------------------------------------------------------------------- *
 *
 * Everything below this divider was added by sub-0006-05 (the FE form
 * layer for debt + payment). The list above is shared with sub-0006-04
 * (the FE debt list page) + sub-0006-06 (the FE debt detail / history
 * page) — they collectively own `fetchDebts`, `fetchDebtSummary`,
 * `fetchDebtById`, `fetchDebtPayments`, `sortPaymentsByDateDesc`, and
 * the `aggregateDebtTotals` helper. This sub-task adds:
 *
 *   - `createDebt` / `updateDebt` — POST / PATCH against
 *     `/api/v1/debts` (sub-0006-01).
 *   - `createDebtPayment` — POST against
 *     `/api/v1/debts/{id}/payments` (sub-0006-02). Returns the
 *     persisted `DebtPayment` so the caller can show the new row in a
 *     toast without a follow-up GET.
 *   - `extractDebtValidationError` — map a 422 `ApiError` body to
 *     per-field errors the form can render inline, mirroring the
 *     `extractGoalValidationError` pattern from sub-0005-04.
 *   - `formatDebtFormApiError` — map any non-422 status to a friendly
 *     Indonesian banner above the form (401/403, 404, 409 overpayment,
 *     5xx).
 *
 * The form layers themselves live under
 * `apps/web/src/components/debts/{debt-form-fields,debt-form-state,
 * payment-form-fields,payment-form-state}` so the create/edit/pay
 * pages stay focused on orchestration.
 */

/**
 * Payload for `POST /debts`. Mirrors `DebtCreate` in
 * `apps/api/src/app/api/schemas.py` (sub-0006-01).
 *
 * `status` is server-defaulted to `active` for create — the FE never
 * sends it on POST (a debt is always born active). The field is kept
 * here only so the type matches the schema; the form layer omits it.
 *
 * `tenor_months` is `null` for tenorless debts (revolving credit,
 * KKB with open-ended schedule, etc.). The FE surfaces a checkbox
 * toggle to make the user opt-in to the field — mirroring the
 * `tenor_months = null` sentinel.
 */
export interface DebtCreatePayload {
  name: string;
  kind: DebtKind;
  principalCents: number;
  bungaPct: number;
  tenorMonths: number | null;
  startDate: string;
  note: string | null;
}

/**
 * Payload for `PATCH /debts/{id}` — every field is optional, only the
 * fields present are sent. Mirrors `DebtUpdate` (sub-0006-01).
 *
 * `kind` is intentionally editable here (the schema allows it) so a
 * user can re-categorize a debt after creation (e.g. switch a
 * paylater that graduated to a regular loan). The BE schema rejects
 * unknown fields with `extra="forbid"`, so the form layer must omit
 * fields the user didn't touch.
 */
export interface DebtUpdatePayload {
  name?: string;
  kind?: DebtKind;
  principalCents?: number;
  bungaPct?: number;
  tenorMonths?: number | null;
  startDate?: string;
  note?: string | null;
  status?: DebtStatus;
}

interface RawDebtCreatePayload {
  name: string;
  kind: DebtKind;
  principal_cents: number;
  bunga_pct: number;
  tenor_months: number | null;
  start_date: string;
  note: string | null;
  status: DebtStatus;
}

interface RawDebtUpdatePayload {
  name?: string;
  kind?: DebtKind;
  principal_cents?: number;
  bunga_pct?: number;
  tenor_months?: number | null;
  start_date?: string;
  note?: string | null;
  status?: DebtStatus;
}

function toCreatePayload(payload: DebtCreatePayload): RawDebtCreatePayload {
  return {
    name: payload.name,
    kind: payload.kind,
    principal_cents: payload.principalCents,
    bunga_pct: payload.bungaPct,
    tenor_months: payload.tenorMonths,
    start_date: payload.startDate,
    note: payload.note,
    // Hardcoded to active — the FE never creates a paid-off debt
    // (status flips after the last cicilan, see sub-0006-02).
    status: "active" as DebtStatus,
  };
}

function toUpdatePayload(payload: DebtUpdatePayload): RawDebtUpdatePayload {
  const out: RawDebtUpdatePayload = {};
  if (payload.name !== undefined) out.name = payload.name;
  if (payload.kind !== undefined) out.kind = payload.kind;
  if (payload.principalCents !== undefined) out.principal_cents = payload.principalCents;
  if (payload.bungaPct !== undefined) out.bunga_pct = payload.bungaPct;
  if (payload.tenorMonths !== undefined) out.tenor_months = payload.tenorMonths;
  if (payload.startDate !== undefined) out.start_date = payload.startDate;
  if (payload.note !== undefined) out.note = payload.note;
  if (payload.status !== undefined) out.status = payload.status;
  return out;
}

/**
 * Create a new debt. On success returns the persisted `Debt`. On 422
 * the underlying `ApiError` is thrown; the form layer extracts
 * per-field errors via `extractDebtValidationError`.
 */
export async function createDebt(payload: DebtCreatePayload): Promise<Debt> {
  const raw = await apiRequest<unknown>("/debts", {
    method: "POST",
    body: toCreatePayload(payload),
  });
  const adapted = adaptDebt(raw);
  if (!adapted) {
    throw new Error("Respons utang baru tidak dikenali.");
  }
  return adapted;
}

/**
 * Patch an existing debt. Only the fields present in `payload` are
 * sent (partial update). On 422 the underlying `ApiError` is thrown;
 * the form layer maps `detail[].loc` to per-field errors via
 * `extractDebtValidationError`.
 */
export async function updateDebt(
  id: string,
  payload: DebtUpdatePayload,
): Promise<Debt> {
  const raw = await apiRequest<unknown>(`/debts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: toUpdatePayload(payload),
  });
  const adapted = adaptDebt(raw);
  if (!adapted) {
    throw new Error("Respons pembaruan utang tidak dikenali.");
  }
  return adapted;
}

/* -------------------------------------------------------------------------- *
 * Payment payload (sub-0006-02)                                              *
 * -------------------------------------------------------------------------- *
 *
 * The cicilan form posts to `POST /debts/{debt_id}/payments`. The BE
 * contract (`DebtPaymentCreate` in `apps/api/src/app/api/schemas.py`)
 * requires `principal_portion_cents + interest_portion_cents ==
 * amount_cents` (Pydantic model validator → 422). The FE mirrors this
 * rule in `validatePaymentPortions` so the user gets the same error
 * message before the round-trip.
 *
 * `source_account_id` is optional (nullable FK to `accounts`). When
 * the user pays in cash the field is `null`.
 */

export interface DebtPaymentCreatePayload {
  occurredOn: string;
  amountCents: number;
  principalPortionCents: number;
  interestPortionCents: number;
  sourceAccountId: string | null;
  note: string | null;
}

interface RawDebtPaymentCreatePayload {
  occurred_on: string;
  amount_cents: number;
  principal_portion_cents: number;
  interest_portion_cents: number;
  source_account_id: string | null;
  note: string | null;
}

function toPaymentCreatePayload(
  payload: DebtPaymentCreatePayload,
): RawDebtPaymentCreatePayload {
  return {
    occurred_on: payload.occurredOn,
    amount_cents: payload.amountCents,
    principal_portion_cents: payload.principalPortionCents,
    interest_portion_cents: payload.interestPortionCents,
    source_account_id: payload.sourceAccountId,
    note: payload.note,
  };
}

/**
 * Create a new cicilan for a debt. On success returns the persisted
 * `DebtPayment`. On 422 the underlying `ApiError` is thrown; the form
 * layer extracts per-field errors via
 * `extractDebtValidationError`.
 *
 * The endpoint also rejects overpayment (422) at the route layer
 * (`OverpaymentError` from `app.services.debt_payments`) — the FE
 * mirrors the guard in `validatePaymentAgainstRemaining` so the user
 * gets the same error before submitting.
 */
export async function createDebtPayment(
  debtId: string,
  payload: DebtPaymentCreatePayload,
): Promise<DebtPayment> {
  const raw = await apiRequest<unknown>(
    `/debts/${encodeURIComponent(debtId)}/payments`,
    {
      method: "POST",
      body: toPaymentCreatePayload(payload),
    },
  );
  const adapted = adaptDebtPayment(raw);
  if (!adapted) {
    throw new Error("Respons cicilan baru tidak dikenali.");
  }
  return adapted;
}

/* -------------------------------------------------------------------------- *
 * Validation error mapping                                                   *
 * -------------------------------------------------------------------------- *
 *
 * Mirrors the pattern used by `goal-client.ts` (sub-0005-04) and
 * `account-client.ts` / `transaction-client.ts`: parse a 422 response
 * into per-field errors the form can render inline, falling back to
 * the generic `ApiError.message` for non-422 errors.
 *
 * Field names below mirror the FE camelCase convention used by the
 * form layers. The mapping (`snakeToDebtField`) is the inverse of the
 * `toCreatePayload` / `toUpdatePayload` / `toPaymentCreatePayload`
 * keys above, kept in sync so BE-side Pydantic messages render under
 * the right input.
 */

export const DEBT_FORM_FIELDS = [
  "name",
  "kind",
  "principalCents",
  "bungaPct",
  "tenorMonths",
  "startDate",
  "note",
  "status",
] as const;
export type DebtFormField = (typeof DEBT_FORM_FIELDS)[number];

export const DEBT_PAYMENT_FORM_FIELDS = [
  "occurredOn",
  "amountCents",
  "principalPortionCents",
  "interestPortionCents",
  "sourceAccountId",
  "note",
] as const;
export type DebtPaymentFormField = (typeof DEBT_PAYMENT_FORM_FIELDS)[number];

export type DebtFormErrors = Partial<Record<DebtFormField, string>> &
  Record<string, string | undefined>;

export type DebtPaymentFormErrors = Partial<Record<DebtPaymentFormField, string>> &
  Record<string, string | undefined>;

export interface ExtractedDebtValidationError {
  /** Field-level errors keyed by FE camelCase field name. */
  fieldErrors: DebtFormErrors;
  /** Non-field errors (e.g. root-level Pydantic validators). */
  generalErrors: string[];
}

export function extractDebtValidationError(
  error: unknown,
): ExtractedDebtValidationError | null {
  if (!(error instanceof ApiError) || error.status !== 422) {
    return null;
  }

  const fieldErrors: DebtFormErrors = {};
  const generalErrors: string[] = [];

  const body = error.body;
  const detail =
    body && typeof body === "object" ? (body as { detail?: unknown }).detail : null;
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
    const camelField = snakeToDebtField(snakeField);
    if (camelField) {
      const existing = fieldErrors[camelField];
      fieldErrors[camelField] = existing ? `${existing} ${msg}` : msg;
    } else {
      generalErrors.push(msg);
    }
  }

  return { fieldErrors, generalErrors };
}

function snakeToDebtField(snake: string): DebtFormField | DebtPaymentFormField | null {
  switch (snake) {
    case "name":
      return "name";
    case "kind":
      return "kind";
    case "principal_cents":
      return "principalCents";
    case "bunga_pct":
      return "bungaPct";
    case "tenor_months":
      return "tenorMonths";
    case "start_date":
      return "startDate";
    case "note":
    case "notes":
      return "note";
    case "status":
      return "status";
    case "occurred_on":
      return "occurredOn";
    case "amount_cents":
      return "amountCents";
    case "principal_portion_cents":
      return "principalPortionCents";
    case "interest_portion_cents":
      return "interestPortionCents";
    case "source_account_id":
      return "sourceAccountId";
    default:
      // Server-only fields (e.g. `monthly_payment_cents` is computed
      // server-side and never sent on the wire) — surface the message
      // via the general-error bucket so the user still sees the text.
      return null;
  }
}

/**
 * Format an API error for the general-error banner above the debt /
 * payment form. Per-field errors are surfaced separately via
 * `extractDebtValidationError`.
 *
 * Status mapping:
 *   - 401/403 → sesi berakhir
 *   - 404 → utang tidak ditemukan
 *   - 422 → fall through to the generic message (handled by
 *           `extractDebtValidationError` at the call site)
 *   - 409 → duplicate payment or other conflict (the BE returns 422
 *           for overpayment at the `assert_no_overpayment` guard, but
 *           keep the 409 branch for forward-compat in case the BE
 *           promotes it).
 *   - 5xx → server gangguan
 */
export function formatDebtFormApiError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return "Sesi kamu sudah berakhir. Masuk lagi untuk melanjutkan.";
    }
    if (error.status === 404) {
      return "Utang tidak ditemukan.";
    }
    if (error.status === 422) {
      return error.message || "Validasi gagal.";
    }
    if (error.status === 409) {
      return error.message || " Cicilan ini tidak bisa disimpan.";
    }
    if (error.status >= 500) {
      return "Server sedang bermasalah. Coba lagi beberapa saat.";
    }
    return error.message || "Permintaan gagal.";
  }
  if (error instanceof Error && error.message.startsWith("Respons")) {
    return error.message;
  }
  return "Tidak bisa menghubungi server. Periksa koneksi lalu coba lagi.";
}

/**
 * Re-export `ApiErrorBody` so import sites that already pull from
 * `debt-client` don't have to drill into `client.ts` for the type.
 */
export type { ApiErrorBody };