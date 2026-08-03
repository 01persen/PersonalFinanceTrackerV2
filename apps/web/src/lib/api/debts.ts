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