import type { ApiErrorBody } from "@/lib/api/client";

export const CATEGORY_KIND_VALUES = ["income", "expense"] as const;
export type CategoryKind = (typeof CATEGORY_KIND_VALUES)[number];

export interface Category {
  id: string;
  name: string;
  kind: CategoryKind;
  parentId: string | null;
  color: string | null;
  icon: string | null;
  archived: boolean;
  archivedAt: string | null;
}

interface RawCategoryPayload {
  id?: unknown;
  name?: unknown;
  kind?: unknown;
  parent_id?: unknown;
  color?: unknown;
  icon?: unknown;
  archived?: unknown;
  archived_at?: unknown;
}

function isCategoryKind(value: unknown): value is CategoryKind {
  return (
    typeof value === "string" &&
    (CATEGORY_KIND_VALUES as readonly string[]).includes(value)
  );
}

export function adaptCategory(raw: unknown): Category | null {
  if (!raw || typeof raw !== "object") return null;

  const payload = raw as RawCategoryPayload;
  if (
    typeof payload.id !== "string" ||
    typeof payload.name !== "string" ||
    !isCategoryKind(payload.kind)
  ) {
    return null;
  }

  return {
    id: payload.id,
    name: payload.name,
    kind: payload.kind,
    parentId: typeof payload.parent_id === "string" ? payload.parent_id : null,
    color: typeof payload.color === "string" ? payload.color : null,
    icon: typeof payload.icon === "string" ? payload.icon : null,
    archived: payload.archived === true,
    archivedAt:
      typeof payload.archived_at === "string" ? payload.archived_at : null,
  };
}

/**
 * Response envelope for `GET /categories` — mirrors `CategoryListPublic`
 * in `apps/api/src/app/api/schemas.py`. `items` is the flat list of the
 * caller's active categories, `total` is the *unfiltered-by-page* count,
 * `limit` + `offset` are echoed back so the FE can paginate without
 * re-deriving them. The default page size is 100 (sub-0004-01 AC (6))
 * and the max is 500 (enforced by the backend `Query(le=500)`).
 */
export interface CategoryListPublic {
  items: Category[];
  total: number;
  limit: number;
  offset: number;
}

interface RawCategoryListPayload {
  items?: unknown;
  total?: unknown;
  limit?: unknown;
  offset?: unknown;
}

function toFiniteCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/**
 * Adapt the wire payload returned by `GET /categories` into the typed
 * `CategoryListPublic` envelope. Returns `null` when the payload is
 * missing or missing the expected `items` array — the caller (e.g. the
 * management page) treats that as "endpoint returned nothing useful"
 * and renders the error/retry path.
 *
 * The BE sorted the rows deterministically as `kind asc, parent_id asc
 * NULLS FIRST, name asc` (sub-0004-01 AC (6)) — the FE keeps the
 * returned order so child groupings stay stable across page loads.
 */
export function adaptCategoryList(raw: unknown): CategoryListPublic | null {
  if (!raw || typeof raw !== "object") return null;
  const payload = raw as RawCategoryListPayload;
  if (!Array.isArray(payload.items)) return null;

  const items: Category[] = [];
  for (const item of payload.items) {
    const category = adaptCategory(item);
    if (category) items.push(category);
  }

  return {
    items,
    total: toFiniteCount(payload.total),
    limit: toFiniteCount(payload.limit),
    offset: toFiniteCount(payload.offset),
  };
}

/**
 * Adapt the wire payload into a flat `Category[]` — accepts both the
 * legacy bare-list shape and the new paginated envelope (`{items,
 * total, limit, offset}`). Returns `null` when the payload is missing
 * or missing the expected shape so callers can distinguish "endpoint
 * returned nothing useful" from "endpoint returned the empty array".
 */
export function adaptCategories(raw: unknown): Category[] | null {
  if (Array.isArray(raw)) {
    const categories: Category[] = [];
    for (const item of raw) {
      const category = adaptCategory(item);
      if (category) categories.push(category);
    }
    return categories;
  }

  const envelope = adaptCategoryList(raw);
  return envelope ? envelope.items : null;
}

export type { ApiErrorBody };
