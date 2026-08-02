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
 * returns 404 for both, so the FE can't tell them apart).
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

export type { ApiErrorBody };