import type { ApiErrorBody } from "@/lib/api/client";

/**
 * Mirrors `CategoryKind` in `apps/api/src/app/db/models/enums.py`. The
 * wire values come straight from the backend (snake_case); renaming these
 * would break the JSON contract with the API.
 *
 * Source of truth: `apps/api/src/app/db/models/enums.py`.
 */
export const CATEGORY_KIND_VALUES = ["income", "expense"] as const;
export type CategoryKind = (typeof CATEGORY_KIND_VALUES)[number];

/**
 * Output shape for a single category row, mirroring `CategoryPublic` in
 * `apps/api/src/app/api/schemas.py`.
 *
 * Categories are nested (parent → children) on the wire. The FE flattens
 * the list to build the picker; ``parentId`` is preserved so the picker
 * can group children under their parent.
 */
export interface Category {
  id: string;
  name: string;
  kind: CategoryKind;
  parentId: string | null;
  color: string | null;
  archived: boolean;
}

interface RawCategoryPayload {
  id: unknown;
  name: unknown;
  kind: unknown;
  parent_id: unknown;
  color: unknown;
  archived: unknown;
}

function isCategoryKind(value: unknown): value is CategoryKind {
  return (
    typeof value === "string" &&
    (CATEGORY_KIND_VALUES as readonly string[]).includes(value)
  );
}

function adaptCategoryFromPayload(raw: RawCategoryPayload): Category | null {
  if (
    typeof raw.id !== "string" ||
    typeof raw.name !== "string" ||
    !isCategoryKind(raw.kind)
  ) {
    return null;
  }

  return {
    id: raw.id,
    name: raw.name,
    kind: raw.kind,
    parentId: typeof raw.parent_id === "string" ? raw.parent_id : null,
    color: typeof raw.color === "string" ? raw.color : null,
    archived: raw.archived === true,
  };
}

/**
 * Hand-written adapter for `GET /categories`. Returns `[]` when the
 * payload is missing or malformed — the picker treats that as "no
 * categories yet" (the empty state still renders). Returns `null` for
 * a payload that's an object but missing the expected array shape, so
 * the caller can distinguish "endpoint returned nothing useful" from
 * "endpoint returned the empty array".
 */
export function adaptCategories(raw: unknown): Category[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Category[] = [];
  for (const item of raw) {
    if (item && typeof item === "object") {
      const adapted = adaptCategoryFromPayload(item as RawCategoryPayload);
      if (adapted) out.push(adapted);
    }
  }
  return out;
}

/**
 * Re-export so callers that already import from `categories` don't have
 * to drill into `client.ts` for the type.
 */
export type { ApiErrorBody };