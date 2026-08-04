/**
 * Mirrors `DebtKind` in `apps/api/src/app/db/models/enums.py`. The
 * string values come straight from the backend (snake_case + the
 * IDR-friendly acronyms KTA / KKB / KPR), so we keep the same literal
 * spelling — renaming here would break the JSON contract.
 */
export const DEBT_KIND_VALUES = [
  "loan",
  "credit_card",
  "paylater",
  "KTA",
  "KKB",
  "KPR",
  "other",
] as const;
export type DebtKind = (typeof DEBT_KIND_VALUES)[number];

/**
 * Friendly labels for the debt `kind` (Indonesian). Mirrors the
 * `DebtKind` enum in the backend and is reused by the debt row badge
 * + the kind filter chip. KTA / KKB / KPR are kept as acronyms (they
 * are industry-standard loan types in the IDR market — Kredit Tanpa
 * Agunan, Kredit Kendaraan Bermotor, Kredit Pemilikan Rumah).
 */
export const DEBT_KIND_LABEL: Record<DebtKind, string> = {
  loan: "Pinjaman",
  credit_card: "Kartu kredit",
  paylater: "Paylater",
  KTA: "KTA",
  KKB: "KKB",
  KPR: "KPR",
  other: "Lainnya",
};

/**
 * Mirrors `DebtStatus` in `apps/api/src/app/db/models/enums.py`.
 */
export const DEBT_STATUS_VALUES = ["active", "paid_off"] as const;
export type DebtStatus = (typeof DEBT_STATUS_VALUES)[number];

/**
 * Friendly labels for the debt `status` (Indonesian). The FE surfaces
 * both states — the read-only list (sub-0006-04) keeps paid-off rows
 * visible (with a "Lunas" badge) so the user can audit their closed
 * debts without flipping a filter.
 */
export const DEBT_STATUS_LABEL: Record<DebtStatus, string> = {
  active: "Aktif",
  paid_off: "Lunas",
};

/**
 * Public debt row shape returned by `GET /debts`, `POST /debts`,
 * `PATCH /debts/{id}`, `GET /debts/{id}`. Mirrors `DebtPublic` in
 * `apps/api/src/app/api/schemas.py` (sub-0006-01).
 *
 * Money fields are integer cents (IDR minor units). `monthly_payment_cents`
 * is `null` whenever `tenor_months` is `null` — the FE surfaces that
 * pair as a "Tanpa jadwal tetap" row label so the user understands why
 * the column is empty.
 *
 * `bunga_pct` is annual (decimal) — e.g. `10.0` means 10% per year.
 * The flat calculator (sub-0006-03) consumes it the same way.
 */
export interface Debt {
  id: string;
  userId: string;
  name: string;
  kind: DebtKind;
  principalCents: number;
  bungaPct: number;
  tenorMonths: number | null;
  startDate: string;
  monthlyPaymentCents: number | null;
  note: string | null;
  status: DebtStatus;
  createdAt: string;
  updatedAt: string;
}

interface RawDebtPayload {
  id?: unknown;
  user_id?: unknown;
  name?: unknown;
  kind?: unknown;
  principal_cents?: unknown;
  bunga_pct?: unknown;
  tenor_months?: unknown;
  start_date?: unknown;
  monthly_payment_cents?: unknown;
  note?: unknown;
  status?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

function isDebtKind(value: unknown): value is DebtKind {
  return (
    typeof value === "string" &&
    (DEBT_KIND_VALUES as readonly string[]).includes(value)
  );
}

function isDebtStatus(value: unknown): value is DebtStatus {
  return (
    typeof value === "string" &&
    (DEBT_STATUS_VALUES as readonly string[]).includes(value)
  );
}

function toFiniteInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function toNullableInt(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toFiniteNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function toIsoString(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  return fallback;
}

function toNullableIsoString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function adaptDebtFromPayload(raw: RawDebtPayload): Debt | null {
  if (
    typeof raw.id !== "string" ||
    typeof raw.user_id !== "string" ||
    typeof raw.name !== "string" ||
    !isDebtKind(raw.kind) ||
    !isDebtStatus(raw.status)
  ) {
    return null;
  }

  return {
    id: raw.id,
    userId: raw.user_id,
    name: raw.name,
    kind: raw.kind,
    principalCents: toFiniteInt(raw.principal_cents),
    bungaPct: toFiniteNumber(raw.bunga_pct),
    tenorMonths: toNullableInt(raw.tenor_months),
    startDate: toIsoString(raw.start_date, ""),
    monthlyPaymentCents: toNullableInt(raw.monthly_payment_cents),
    note: toNullableString(raw.note),
    status: raw.status,
    createdAt: toIsoString(raw.created_at, ""),
    updatedAt: toIsoString(raw.updated_at, ""),
  };
}

/**
 * Adapt the wire payload for a single debt into the FE camelCase
 * `Debt`. Returns `null` when the payload is missing or missing the
 * expected `id` + `user_id` + `name` + `kind` + `status` tuple —
 * callers treat that as "tidak ditemukan".
 */
export function adaptDebt(raw: unknown): Debt | null {
  if (!raw || typeof raw !== "object") return null;
  return adaptDebtFromPayload(raw as RawDebtPayload);
}

/**
 * Adapt a bare list payload into `Debt[]`. Returns `[]` when the
 * payload is missing/malformed so the caller can treat it as the
 * empty state.
 */
export function adaptDebts(raw: unknown): Debt[] {
  if (!Array.isArray(raw)) return [];
  const result: Debt[] = [];
  for (const item of raw) {
    if (item && typeof item === "object") {
      const adapted = adaptDebtFromPayload(item as RawDebtPayload);
      if (adapted) result.push(adapted);
    }
  }
  return result;
}

/**
 * Public debt summary shape returned by `GET /debts/{id}/summary`
 * (sub-0006-03). Mirrors `DebtSummaryPublic` in
 * `apps/api/src/app/api/schemas.py`.
 *
 * `remaining_principal_cents` and `total_interest_paid_cents` are
 * integer cents (always >= 0). `next_payment_due_date` is an ISO
 * `YYYY-MM-DD` string (or `null` when there is no schedule). The FE
 * stores it as `string | null` for the same reason — keeping the wire
 * shape verbatim avoids a timezone round-trip the calendar would
 * otherwise need to defend against.
 *
 * `months_remaining` is `null` when there is no schedule, `0` when
 * the debt is fully paid, otherwise `tenor_months - paid_count`.
 */
export interface DebtSummary {
  debtId: string;
  remainingPrincipalCents: number;
  totalInterestPaidCents: number;
  nextPaymentDueDate: string | null;
  monthsRemaining: number | null;
}

interface RawDebtSummaryPayload {
  debt_id?: unknown;
  remaining_principal_cents?: unknown;
  total_interest_paid_cents?: unknown;
  next_payment_due_date?: unknown;
  months_remaining?: unknown;
}

/**
 * Adapt the wire payload for `GET /debts/{id}/summary` into the FE
 * camelCase `DebtSummary`. Returns `null` when the payload is missing
 * or missing the expected `debt_id` field — callers treat that as
 * "endpoint returned nothing useful" and render the error/retry path.
 */
export function adaptDebtSummary(raw: unknown): DebtSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const payload = raw as RawDebtSummaryPayload;
  if (typeof payload.debt_id !== "string") return null;
  return {
    debtId: payload.debt_id,
    remainingPrincipalCents: toFiniteInt(payload.remaining_principal_cents),
    totalInterestPaidCents: toFiniteInt(payload.total_interest_paid_cents),
    nextPaymentDueDate: toNullableIsoString(payload.next_payment_due_date),
    monthsRemaining: toNullableInt(payload.months_remaining),
  };
}

/* -------------------------------------------------------------------------- *
 * sub-0006-06 — Payment row + paginated list (sub-0006-02 BE)                 *
 * -------------------------------------------------------------------------- *
 *
 * Mirrors `DebtPaymentPublic` + `DebtPaymentListPublic` in
 * `apps/api/src/app/api/schemas.py` (sub-0006-02). The detail page
 * (this sub-task) reads the list envelope directly so the history
 * table can render pagination controls without a follow-up GET.
 *
 * The BE sort chain is `occurred_on DESC, created_at DESC, id ASC` —
 * the FE never re-sorts; it only filters malformed rows out via the
 * adapter (mirrors the `adaptDebts` list adapter convention).
 *
 * `sourceAccountId` is `null` when the payment was made in cash (no
 * linked account). `occurredOn` is an ISO `YYYY-MM-DD` string — kept
 * as a string to avoid the timezone round-trip the calendar would
 * otherwise need to defend against (mirrors the `startDate` /
 * `nextPaymentDueDate` convention).
 *
 * `principalPortionCents` + `interestPortionCents` always equals
 * `amountCents` — the BE enforces this in a Pydantic ``model_validator``
 * so the FE can rely on the invariant.
 */
export interface DebtPayment {
  id: string;
  debtId: string;
  occurredOn: string;
  amountCents: number;
  principalPortionCents: number;
  interestPortionCents: number;
  sourceAccountId: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RawDebtPaymentPayload {
  id?: unknown;
  debt_id?: unknown;
  occurred_on?: unknown;
  amount_cents?: unknown;
  principal_portion_cents?: unknown;
  interest_portion_cents?: unknown;
  source_account_id?: unknown;
  note?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

/**
 * Adapt the wire payload for a single `debt_payments` row into the FE
 * camelCase `DebtPayment`. Returns `null` when the payload is missing
 * or missing the expected `id` + `debt_id` pair — callers treat that
 * as "endpoint returned nothing useful" and surface the error/retry
 * path.
 */
export function adaptDebtPayment(raw: unknown): DebtPayment | null {
  if (!raw || typeof raw !== "object") return null;
  const payload = raw as RawDebtPaymentPayload;
  if (typeof payload.id !== "string" || typeof payload.debt_id !== "string") {
    return null;
  }
  return {
    id: payload.id,
    debtId: payload.debt_id,
    occurredOn: toIsoString(payload.occurred_on, ""),
    amountCents: toFiniteInt(payload.amount_cents),
    principalPortionCents: toFiniteInt(payload.principal_portion_cents),
    interestPortionCents: toFiniteInt(payload.interest_portion_cents),
    sourceAccountId: toNullableString(payload.source_account_id),
    note: toNullableString(payload.note),
    createdAt: toIsoString(payload.created_at, ""),
    updatedAt: toIsoString(payload.updated_at, ""),
  };
}

/**
 * Paginated list envelope returned by `GET /debts/{id}/payments`
 * (sub-0006-02). The detail page reads this directly so the history
 * table can render pagination controls without a follow-up GET.
 *
 * `total` is the unfiltered-by-page row count for the debt so the
 * FE can compute the page count without a second request. `limit`
 * and `offset` echo the query params verbatim; the FE uses them to
 * detect "empty page past the end" (so a stale `offset > total`
 * link doesn't render a phantom empty list — see the page-level
 * state machine in `apps/web/src/app/debts/[id]/page.tsx`).
 */
export interface DebtPaymentPage {
  items: DebtPayment[];
  total: number;
  limit: number;
  offset: number;
}

interface RawDebtPaymentPagePayload {
  items?: unknown;
  total?: unknown;
  limit?: unknown;
  offset?: unknown;
}

/**
 * Adapt the wire payload for `GET /debts/{id}/payments` into the FE
 * camelCase `DebtPaymentPage`. Returns `null` when the payload is
 * missing or missing the expected `items` array + numeric
 * `total` / `limit` / `offset` triple — callers treat that as
 * "endpoint returned nothing useful" and render the error/retry
 * path. The inner payment rows go through `adaptDebtPayment` so a
 * malformed row in the middle of the page is silently dropped (the
 * BE's contract is "all rows on the page are well-formed" but the
 * adapter stays defensive).
 *
 * `total` is clamped to `>= items.length` so a malformed total
 * (e.g. `null` or `0` on a non-empty page) doesn't push the FE
 * pagination into a phantom-empty state. The clamp is a no-op for
 * well-formed BE responses (the BE always reports the full row
 * count, not the page-only count).
 */
export function adaptDebtPaymentList(raw: unknown): DebtPaymentPage | null {
  if (!raw || typeof raw !== "object") return null;
  const payload = raw as RawDebtPaymentPagePayload;
  if (!Array.isArray(payload.items)) return null;

  const items: DebtPayment[] = [];
  for (const item of payload.items) {
    if (item && typeof item === "object") {
      const adapted = adaptDebtPayment(item);
      if (adapted) items.push(adapted);
    }
  }

  const total = toFiniteInt(payload.total);
  const limit = toFiniteInt(payload.limit);
  const offset = toFiniteInt(payload.offset);

  return {
    items,
    total: Math.max(total, items.length),
    limit: limit > 0 ? limit : Math.max(items.length, 1),
    offset: offset >= 0 ? offset : 0,
  };
}