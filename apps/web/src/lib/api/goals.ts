import type { ApiErrorBody } from "@/lib/api/client";

/**
 * Mirrors `GoalKind` in `apps/api/src/app/db/models/enums.py`. The string
 * values come straight from the backend (snake_case), so we keep the same
 * literal spelling — renaming here would break the JSON contract.
 */
export const GOAL_KIND_VALUES = ["saving", "emergency_fund"] as const;
export type GoalKind = (typeof GOAL_KIND_VALUES)[number];

export interface Goal {
  id: string;
  userId: string;
  kind: GoalKind;
  name: string;
  targetAmountCents: number;
  currentAmountCents: number | null;
  linkedAccountId: string | null;
  startDate: string;
  targetDate: string | null;
  jangkaWaktuMonths: number | null;
  tabunganBulananCents: number | null;
  monthlyExpenseCents: number | null;
  jumlahTanggungan: number | null;
  multiplier: number | null;
  lamaMengumpulkanBulan: number | null;
  targetAmountSnapshotCents: number | null;
  notes: string | null;
  archived: boolean;
  archivedAt: string | null;
  achievedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RawGoalPayload {
  id?: unknown;
  user_id?: unknown;
  kind?: unknown;
  name?: unknown;
  target_amount_cents?: unknown;
  current_amount_cents?: unknown;
  linked_account_id?: unknown;
  start_date?: unknown;
  target_date?: unknown;
  jangka_waktu_months?: unknown;
  tabungan_bulanan_cents?: unknown;
  monthly_expense_cents?: unknown;
  jumlah_tanggungan?: unknown;
  multiplier?: unknown;
  lama_mengumpulkan_bulan?: unknown;
  target_amount_snapshot_cents?: unknown;
  notes?: unknown;
  archived?: unknown;
  archived_at?: unknown;
  achieved_at?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

function isGoalKind(value: unknown): value is GoalKind {
  return (
    typeof value === "string" &&
    (GOAL_KIND_VALUES as readonly string[]).includes(value)
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

function toIsoString(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  return fallback;
}

function toNullableIsoString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
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

function adaptGoalFromPayload(raw: RawGoalPayload): Goal | null {
  if (
    typeof raw.id !== "string" ||
    typeof raw.user_id !== "string" ||
    !isGoalKind(raw.kind) ||
    typeof raw.name !== "string"
  ) {
    return null;
  }

  return {
    id: raw.id,
    userId: raw.user_id,
    kind: raw.kind,
    name: raw.name,
    targetAmountCents: toFiniteInt(raw.target_amount_cents),
    currentAmountCents: toNullableInt(raw.current_amount_cents),
    linkedAccountId:
      typeof raw.linked_account_id === "string" ? raw.linked_account_id : null,
    startDate: toIsoString(raw.start_date, ""),
    targetDate: toNullableIsoString(raw.target_date),
    jangkaWaktuMonths: toNullableInt(raw.jangka_waktu_months),
    tabunganBulananCents: toNullableInt(raw.tabungan_bulanan_cents),
    monthlyExpenseCents: toNullableInt(raw.monthly_expense_cents),
    jumlahTanggungan: toNullableInt(raw.jumlah_tanggungan),
    multiplier: toNullableInt(raw.multiplier),
    lamaMengumpulkanBulan: toNullableInt(raw.lama_mengumpulkan_bulan),
    targetAmountSnapshotCents: toNullableInt(raw.target_amount_snapshot_cents),
    notes: typeof raw.notes === "string" ? raw.notes : null,
    archived: raw.archived === true,
    archivedAt: toNullableIsoString(raw.archived_at),
    achievedAt: toNullableIsoString(raw.achieved_at),
    createdAt: toIsoString(raw.created_at, ""),
    updatedAt: toIsoString(raw.updated_at, ""),
  };
}

/**
 * Adapt the wire payload for a single goal into the FE camelCase `Goal`.
 * Returns `null` when the payload is missing or missing the expected
 * `id` + `user_id` + `kind` + `name` tuple — callers (e.g. the edit page
 * landing in sub-0005-04) treat that as "tidak ditemukan".
 */
export function adaptGoal(raw: unknown): Goal | null {
  if (!raw || typeof raw !== "object") return null;
  return adaptGoalFromPayload(raw as RawGoalPayload);
}

/**
 * Adapt a bare list payload into `Goal[]`. Returns `[]` when the payload
 * is missing/malformed so the caller can treat it as the empty state.
 */
export function adaptGoals(raw: unknown): Goal[] {
  if (!Array.isArray(raw)) return [];
  const result: Goal[] = [];
  for (const item of raw) {
    if (item && typeof item === "object") {
      const adapted = adaptGoalFromPayload(item as RawGoalPayload);
      if (adapted) result.push(adapted);
    }
  }
  return result;
}

/**
 * Response envelope for `GET /goals`. Mirrors `GoalListPublic` in
 * `apps/api/src/app/api/schemas.py`. `total` is the unfiltered-by-page
 * count so the FE can render pagination without a second call; `limit`
 * + `offset` are echoed back.
 */
export interface GoalListPublic {
  items: Goal[];
  total: number;
  limit: number;
  offset: number;
}

interface RawGoalListPayload {
  items?: unknown;
  total?: unknown;
  limit?: unknown;
  offset?: unknown;
}

/**
 * Adapt the wire envelope for `GET /goals` into the typed
 * `GoalListPublic`. Returns `null` when the payload is missing or
 * missing the expected `items` array — the caller (e.g. the goals list
 * page) treats that as "endpoint returned nothing useful" and renders
 * the error/retry path.
 */
export function adaptGoalList(raw: unknown): GoalListPublic | null {
  if (!raw || typeof raw !== "object") return null;
  const payload = raw as RawGoalListPayload;
  if (!Array.isArray(payload.items)) return null;

  const items: Goal[] = [];
  for (const item of payload.items) {
    if (item && typeof item === "object") {
      const adapted = adaptGoalFromPayload(item as RawGoalPayload);
      if (adapted) items.push(adapted);
    }
  }

  return {
    items,
    total: toFiniteInt(payload.total),
    limit: toFiniteInt(payload.limit),
    offset: toFiniteInt(payload.offset),
  };
}

export type { ApiErrorBody };