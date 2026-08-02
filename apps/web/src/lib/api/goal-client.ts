import { ApiError, apiRequest, type ApiErrorBody } from "@/lib/api/client";
import {
  adaptGoal,
  adaptGoalList,
  adaptGoals,
  GOAL_KIND_VALUES,
  type Goal,
  type GoalKind,
  type GoalListPublic,
} from "@/lib/api/goals";

export {
  GOAL_KIND_VALUES,
  type Goal,
  type GoalKind,
  type GoalListPublic,
};

/**
 * Friendly labels for the goal `kind` (Indonesian). Mirrors the
 * `GoalKind` enum in the backend and is reused by the kind filter chip
 * and the goal-card badge.
 */
export const GOAL_KIND_LABEL: Record<GoalKind, string> = {
  saving: "Tabungan",
  emergency_fund: "Dana darurat",
};

/**
 * Default page size — matches the backend default for `GET /goals`
 * (sub-0005-01). 50 rows is comfortable on mobile (each card is dense)
 * while still fitting the BE max of 200 in a single page when needed.
 */
export const GOAL_PAGE_SIZE = 50;
/** Hard upper bound enforced by the backend `Query(le=200)`. */
export const GOAL_MAX_PAGE_SIZE = 200;

/**
 * Filter + pagination payload for `GET /goals`. Mirrors the
 * `kind` + `archived` + `limit` + `offset` query params the route
 * accepts (sub-0005-01 + sub-0005-02).
 *
 * `kind` is `null` for "Semua" (no kind filter) — mirrors the chip
 * selector on the list page so the URL stays shareable (AC shareable
 * link).
 */
export interface GoalListFilters {
  kind: GoalKind | null;
  /** Page size (default 50, max 200). */
  limit: number;
  /** Number of rows to skip from the start of the filtered result. */
  offset: number;
}

export const EMPTY_GOAL_FILTERS: GoalListFilters = {
  kind: null,
  limit: GOAL_PAGE_SIZE,
  offset: 0,
};

function buildQuery(filters: GoalListFilters): string {
  const params = new URLSearchParams();
  if (filters.kind) {
    params.set("kind", filters.kind);
  }
  // Always echo limit + offset so the FE can render pagination without
  // guessing — same convention as the transactions list endpoint
  // (sub-0003-06).
  params.set("limit", String(filters.limit));
  params.set("offset", String(filters.offset));
  const qs = params.toString();
  return qs.length > 0 ? `?${qs}` : "";
}

/**
 * Fetch a page of goals from `GET /goals`. Filters are composable (AND);
 * see `apps/api/src/app/api/v1/goals.py` for the server-side predicate
 * list (kind + archived + limit + offset, sorted `kind asc, start_date
 * desc, created_at desc, id asc` for stable pagination).
 *
 * Accepts an `AbortSignal` so the caller can drop in-flight requests
 * when a newer load starts (race condition guard, see sub-0002-03 Cek 5).
 */
export async function fetchGoals(
  filters: GoalListFilters,
  options: { signal?: AbortSignal } = {},
): Promise<GoalListPublic> {
  const raw = await apiRequest<unknown>(`/goals${buildQuery(filters)}`, {
    signal: options.signal,
  });
  const adapted = adaptGoalList(raw);
  if (adapted === null) {
    throw new ApiError(200, "Respons daftar target tidak dikenali.");
  }
  return adapted;
}

/**
 * Fetch the flat list of goals (no pagination metadata). Used by the
 * goals list page when it can fit the user's set in a single page —
 * same convention as `fetchCategories` for the management page.
 *
 * Returns `null` when the payload is missing/malformed so the caller
 * can render the error-retry path.
 */
export async function fetchGoalList(
  options: { signal?: AbortSignal; limit?: number; offset?: number } = {},
): Promise<Goal[] | null> {
  const raw = await apiRequest<unknown>(
    `/goals?limit=${encodeURIComponent(options.limit ?? GOAL_PAGE_SIZE)}&offset=${encodeURIComponent(options.offset ?? 0)}`,
    { signal: options.signal },
  );
  // adaptGoals handles both bare-list shape and the paginated envelope
  // so the wire-shape change from sub-0005-01 is transparent at the
  // call site. For the bare-list case we return `[]`; for the
  // paginated envelope we return its items.
  if (Array.isArray(raw)) {
    return adaptGoals(raw);
  }
  const envelope = adaptGoalList(raw);
  return envelope ? envelope.items : null;
}

/**
 * Fetch a single goal by id. Returns `null` when the payload is
 * missing or the row doesn't belong to the caller (the endpoint
 * returns 404 for both cases, so the FE can't tell them apart).
 */
export async function fetchGoalById(
  id: string,
  options: { signal?: AbortSignal } = {},
): Promise<Goal | null> {
  const raw = await apiRequest<unknown>(`/goals/${encodeURIComponent(id)}`, {
    signal: options.signal,
  });
  return adaptGoal(raw);
}

/**
 * Map any thrown value to a friendly Indonesian message. Mirrors
 * `formatCategoryApiError` so the error UI across the app stays
 * consistent: 401/403 → sesi berakhir, 404 → tidak ditemukan / sudah
 * diarsipkan, 422 → validation message, 5xx → server gangguan.
 *
 * The form layer (sub-0005-04) has its own no-fallback formatter in
 * `goal-form-state.ts` so this signature stays compatible with the
 * list page usage.
 */
export function formatGoalApiError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return "Sesi kamu sudah berakhir. Masuk lagi untuk memuat daftar target.";
    }
    if (error.status === 404) {
      return "Target tidak ditemukan atau sudah diarsipkan.";
    }
    if (error.status === 422) {
      return error.message || "Data target belum valid.";
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

/* -------------------------------------------------------------------------- *
 * sub-0005-04 — Form CRUD + settings                                          *
 * -------------------------------------------------------------------------- *
 *
 * Everything below this divider was added by sub-0005-04 (the FE goal
 * form layer). The list above is owned by sub-0005-03 (the FE goal list
 * page); both share `Goal`, `GoalKind`, `GOAL_KIND_VALUES` from
 * `@/lib/api/goals`. The form pages pull CRUD + settings + 422 mapper
 * from this file via the re-exports at the top of the form layer.
 */

/**
 * Output shape for the caller's `/users/me/settings` row. Mirrors
 * `UserSettingsPublic` in `apps/api/src/app/api/schemas.py`. The wire
 * field name `ef_multiplier` matches the request body contract pinned
 * in sub-0005-02.
 */
export interface UserSettings {
  locale: string;
  currency: string;
  efMultiplier: number;
  dependentsCount: number;
  theme: string;
  updatedAt: string;
}

const IDR_FORMATTER = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

/**
 * Format a cents amount as Indonesian Rupiah without decimals. Mirrors
 * the FE-side helper in `account-client.ts` — copied here so the goals
 * form layer doesn't have to take a dependency on accounts.
 */
export function formatIdrFromCents(cents: number): string {
  return IDR_FORMATTER.format(Math.round(cents / 100));
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

/**
 * Payload for `POST /goals`. The kind discriminator decides which
 * kind-specific fields the BE accepts — the FE mirrors the same rule in
 * `GoalCreate._validate_kind_specific` so a cross-field leak never
 * reaches the wire.
 */
export interface GoalCreatePayload {
  kind: GoalKind;
  name: string;
  targetAmountCents: number;
  currentAmountCents?: number | null;
  linkedAccountId?: string | null;
  startDate?: string | null;
  targetDate?: string | null;
  jangkaWaktuMonths?: number | null;
  monthlyExpenseCents?: number | null;
  jumlahTanggungan?: number | null;
  multiplier?: number | null;
  notes?: string | null;
}

/**
 * Payload for `PATCH /goals/{id}` — every field is optional, only the
 * fields you set are sent. `kind` is intentionally not editable here
 * (server-controlled; the BE schema rejects unknown fields with 422).
 */
export interface GoalUpdatePayload {
  name?: string;
  targetAmountCents?: number;
  currentAmountCents?: number | null;
  linkedAccountId?: string | null;
  startDate?: string;
  targetDate?: string | null;
  jangkaWaktuMonths?: number | null;
  monthlyExpenseCents?: number | null;
  jumlahTanggungan?: number | null;
  multiplier?: number | null;
  notes?: string | null;
}

interface RawGoalCreatePayload {
  kind: GoalKind;
  name: string;
  target_amount_cents: number;
  current_amount_cents: number | null;
  linked_account_id: string | null;
  start_date: string | null;
  target_date: string | null;
  jangka_waktu_months: number | null;
  monthly_expense_cents: number | null;
  jumlah_tanggungan: number | null;
  multiplier: number | null;
  notes: string | null;
}

interface RawGoalUpdatePayload {
  name?: string;
  target_amount_cents?: number;
  current_amount_cents?: number | null;
  linked_account_id?: string | null;
  start_date?: string;
  target_date?: string | null;
  jangka_waktu_months?: number | null;
  monthly_expense_cents?: number | null;
  jumlah_tanggungan?: number | null;
  multiplier?: number | null;
  notes?: string | null;
}

function toCreatePayload(payload: GoalCreatePayload): RawGoalCreatePayload {
  return {
    kind: payload.kind,
    name: payload.name,
    target_amount_cents: payload.targetAmountCents,
    current_amount_cents:
      payload.currentAmountCents === undefined ? null : payload.currentAmountCents,
    linked_account_id:
      payload.linkedAccountId === undefined ? null : payload.linkedAccountId,
    start_date: payload.startDate === undefined ? null : payload.startDate,
    target_date: payload.targetDate === undefined ? null : payload.targetDate,
    jangka_waktu_months:
      payload.jangkaWaktuMonths === undefined ? null : payload.jangkaWaktuMonths,
    monthly_expense_cents:
      payload.monthlyExpenseCents === undefined ? null : payload.monthlyExpenseCents,
    jumlah_tanggungan:
      payload.jumlahTanggungan === undefined ? null : payload.jumlahTanggungan,
    multiplier: payload.multiplier === undefined ? null : payload.multiplier,
    notes: payload.notes === undefined ? null : payload.notes,
  };
}

function toUpdatePayload(payload: GoalUpdatePayload): RawGoalUpdatePayload {
  const out: RawGoalUpdatePayload = {};
  if (payload.name !== undefined) out.name = payload.name;
  if (payload.targetAmountCents !== undefined) {
    out.target_amount_cents = payload.targetAmountCents;
  }
  if (payload.currentAmountCents !== undefined) {
    out.current_amount_cents = payload.currentAmountCents;
  }
  if (payload.linkedAccountId !== undefined) {
    out.linked_account_id = payload.linkedAccountId;
  }
  if (payload.startDate !== undefined) out.start_date = payload.startDate;
  if (payload.targetDate !== undefined) out.target_date = payload.targetDate;
  if (payload.jangkaWaktuMonths !== undefined) {
    out.jangka_waktu_months = payload.jangkaWaktuMonths;
  }
  if (payload.monthlyExpenseCents !== undefined) {
    out.monthly_expense_cents = payload.monthlyExpenseCents;
  }
  if (payload.jumlahTanggungan !== undefined) {
    out.jumlah_tanggungan = payload.jumlahTanggungan;
  }
  if (payload.multiplier !== undefined) out.multiplier = payload.multiplier;
  if (payload.notes !== undefined) out.notes = payload.notes;
  return out;
}

/**
 * Create a new goal. On success returns the persisted `Goal`. On 422
 * the underlying `ApiError` is thrown; the form layer extracts per-field
 * errors via `extractGoalValidationError`.
 */
export async function createGoal(payload: GoalCreatePayload): Promise<Goal> {
  const raw = await apiRequest<unknown>("/goals", {
    method: "POST",
    body: toCreatePayload(payload),
  });
  const adapted = adaptGoal(raw);
  if (!adapted) {
    throw new Error("Respons goal baru tidak dikenali.");
  }
  return adapted;
}

/**
 * Patch an existing goal. Only the fields present in `payload` are
 * sent (partial update). On 422 the underlying `ApiError` is thrown;
 * the form layer maps `detail[].loc` to per-field errors via
 * `extractGoalValidationError`.
 */
export async function updateGoal(id: string, payload: GoalUpdatePayload): Promise<Goal> {
  const raw = await apiRequest<unknown>(`/goals/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: toUpdatePayload(payload),
  });
  const adapted = adaptGoal(raw);
  if (!adapted) {
    throw new Error("Respons pembaruan goal tidak dikenali.");
  }
  return adapted;
}

/**
 * Soft-delete a goal by hitting `DELETE /goals/{id}` (which sets
 * `archived_at = now()`). Returns void on success. A second DELETE on
 * an already-archived row is a 204 no-op server-side.
 */
export async function archiveGoal(id: string): Promise<void> {
  await apiRequest<void>(`/goals/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/* -------------------------------------------------------------------------- *
 * User settings (sub-0005-02)                                                *
 * -------------------------------------------------------------------------- *
 *
 * The EF goal form needs the caller's `ef_multiplier` default at mount
 * so the multiplier field can be pre-filled with the per-user setting
 * (PRD §14, default 3). The FE fetches it from the dedicated
 * `/users/me/settings` endpoint that was added in sub-0005-02 (it lives
 * alongside the older `/preferences` endpoint without renaming it).
 */

interface RawUserSettingsPayload {
  locale: unknown;
  currency: unknown;
  ef_multiplier: unknown;
  dependents_count: unknown;
  theme: unknown;
  updated_at: unknown;
}

function adaptUserSettings(raw: unknown): UserSettings | null {
  if (!raw || typeof raw !== "object") return null;
  const payload = raw as RawUserSettingsPayload;
  if (
    typeof payload.locale !== "string" ||
    typeof payload.currency !== "string" ||
    typeof payload.theme !== "string" ||
    typeof payload.ef_multiplier === "undefined"
  ) {
    return null;
  }
  return {
    locale: payload.locale,
    currency: payload.currency,
    efMultiplier: toFiniteInt(payload.ef_multiplier),
    dependentsCount: toFiniteInt(payload.dependents_count),
    theme: payload.theme,
    updatedAt: toIsoString(payload.updated_at, ""),
  };
}

/**
 * Fetch the caller's settings row from `GET /users/me/settings`.
 * Returns `null` when the response envelope is missing or the user has
 * no preferences row yet (the form layer falls back to the seed default
 * of 3 in that case — sub-0005-02 seed).
 *
 * Accepts an `AbortSignal` so the caller can drop in-flight requests
 * when a newer load starts (race condition guard, sub-0002-03 Cek 5).
 */
export async function fetchMySettings(
  options: { signal?: AbortSignal } = {},
): Promise<UserSettings | null> {
  try {
    const raw = await apiRequest<unknown>("/users/me/settings", {
      signal: options.signal,
    });
    return adaptUserSettings(raw);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      // Legacy user without a seed preferences row (or a fresh install
      // where the seed hasn't run yet). The FE falls back to the seed
      // default of 3 — see `DEFAULT_EF_MULTIPLIER_FALLBACK` below.
      return null;
    }
    throw error;
  }
}

/**
 * Fallback default for the EF multiplier when the user has no
 * preferences row yet. Mirrors the seed default in
 * `apps/api/src/app/services/seed.py` and
 * `apps/api/src/app/services/goal_engine.py`. Kept in sync via the
 * server-side test (`apps/api/tests/test_seed.py`).
 */
export const DEFAULT_EF_MULTIPLIER_FALLBACK = 3;

/* -------------------------------------------------------------------------- *
 * Validation error mapping                                                   *
 * -------------------------------------------------------------------------- *
 *
 * Mirrors the pattern used by `account-client.ts` and
 * `transaction-client.ts`: parse a 422 response into per-field errors
 * the form can render inline, falling back to the generic
 * `ApiError.message` for non-422 errors.
 */

export const GOAL_FORM_FIELDS = [
  "name",
  "kind",
  "targetAmountCents",
  "currentAmountCents",
  "linkedAccountId",
  "startDate",
  "targetDate",
  "jangkaWaktuMonths",
  "monthlyExpenseCents",
  "jumlahTanggungan",
  "multiplier",
  "notes",
] as const;
export type GoalFormField = (typeof GOAL_FORM_FIELDS)[number];

export type GoalFormErrors = Partial<Record<GoalFormField, string>> &
  Record<string, string | undefined>;

export interface ExtractedGoalValidationError {
  /** Field-level errors keyed by FE camelCase field name. */
  fieldErrors: GoalFormErrors;
  /** Non-field errors (e.g. root-level Pydantic validators). */
  generalErrors: string[];
}

export function extractGoalValidationError(
  error: unknown,
): ExtractedGoalValidationError | null {
  if (!(error instanceof ApiError) || error.status !== 422) {
    return null;
  }

  const fieldErrors: GoalFormErrors = {};
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
    const camelField = snakeToGoalField(snakeField);
    if (camelField) {
      const existing = fieldErrors[camelField];
      fieldErrors[camelField] = existing ? `${existing} ${msg}` : msg;
    } else {
      generalErrors.push(msg);
    }
  }

  return { fieldErrors, generalErrors };
}

function snakeToGoalField(snake: string): GoalFormField | null {
  switch (snake) {
    case "kind":
      return "kind";
    case "name":
      return "name";
    case "target_amount_cents":
      return "targetAmountCents";
    case "current_amount_cents":
      return "currentAmountCents";
    case "linked_account_id":
      return "linkedAccountId";
    case "start_date":
      return "startDate";
    case "target_date":
      return "targetDate";
    case "jangka_waktu_months":
      return "jangkaWaktuMonths";
    case "monthly_expense_cents":
      return "monthlyExpenseCents";
    case "jumlah_tanggungan":
      return "jumlahTanggungan";
    case "multiplier":
      return "multiplier";
    case "notes":
      return "notes";
    case "tabungan_bulanan_cents":
    case "lama_mengumpulkan_bulan":
    case "target_amount_snapshot_cents":
      // Auto-calc fields owned by the goal-engine — not editable on the
      // FE form, but if a stray Pydantic message points here we surface
      // it via the general error bucket so the user still sees the text.
      return null;
    default:
      return null;
  }
}

/**
 * Re-export `ApiErrorBody` so import sites that already pull from
 * `goal-client` don't have to drill into `client.ts` for the type.
 */
export type { ApiErrorBody };
