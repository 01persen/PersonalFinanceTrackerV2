import { ApiError, apiRequest } from "@/lib/api/client";
import {
  adaptCategories,
  adaptCategory,
  adaptCategoryList,
  CATEGORY_KIND_VALUES,
  type Category,
  type CategoryKind,
  type CategoryListPublic,
} from "@/lib/api/categories";

export {
  CATEGORY_KIND_VALUES,
  type Category,
  type CategoryKind,
  type CategoryListPublic,
};

export const CATEGORY_KIND_LABEL: Record<CategoryKind, string> = {
  income: "Pemasukan",
  expense: "Pengeluaran",
};

export interface CategoryCreatePayload {
  name: string;
  kind: CategoryKind;
  parentId?: string | null;
  color?: string | null;
  icon?: string | null;
}

export interface CategoryUpdatePayload {
  name?: string;
  kind?: CategoryKind;
  parentId?: string | null;
  color?: string | null;
  icon?: string | null;
}

interface RawCategoryCreatePayload {
  name: string;
  kind: CategoryKind;
  parent_id: string | null;
  color: string | null;
  icon: string | null;
}

interface RawCategoryUpdatePayload {
  name?: string;
  kind?: CategoryKind;
  parent_id?: string | null;
  color?: string | null;
  icon?: string | null;
}

function listPath(limit: number, offset: number): string {
  return `/categories?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`;
}

export async function fetchCategories(
  options: { signal?: AbortSignal; limit?: number; offset?: number } = {},
): Promise<Category[] | null> {
  const raw = await apiRequest<unknown>(
    listPath(options.limit ?? 500, options.offset ?? 0),
    { signal: options.signal },
  );
  return adaptCategories(raw);
}

/**
 * Fetch the paginated `GET /categories` envelope as a typed
 * `CategoryListPublic`. Use this when the caller needs pagination
 * metadata (`total`, `limit`, `offset`) — the FE Manajemen Kategori page
 * sticks to {@link fetchCategories} because it can fit the MVP tree in a
 * single page (max 500 rows, the backend ceiling). Transactions /
 * category-picker filters can also use {@link fetchCategories} for the
 * flat list — the adapter is envelope-aware so the wire-shape change
 * from sub-0004-01 is transparent at the call site.
 *
 * Accepts an `AbortSignal` so the caller can drop in-flight requests
 * when a newer load starts (race condition guard, sub-0002-03 Cek 5).
 */
export async function fetchCategoryList(
  options: { signal?: AbortSignal; limit?: number; offset?: number } = {},
): Promise<CategoryListPublic | null> {
  const raw = await apiRequest<unknown>(
    listPath(options.limit ?? 500, options.offset ?? 0),
    { signal: options.signal },
  );
  return adaptCategoryList(raw);
}

export async function createCategory(
  payload: CategoryCreatePayload,
): Promise<Category> {
  const body: RawCategoryCreatePayload = {
    name: payload.name,
    kind: payload.kind,
    parent_id: payload.parentId ?? null,
    color: payload.color ?? null,
    icon: payload.icon ?? null,
  };
  const raw = await apiRequest<unknown>("/categories", {
    method: "POST",
    body,
  });
  const category = adaptCategory(raw);
  if (!category) throw new Error("Respons kategori baru tidak dikenali.");
  return category;
}

export async function updateCategory(
  id: string,
  payload: CategoryUpdatePayload,
): Promise<Category> {
  const body: RawCategoryUpdatePayload = {};
  if (payload.name !== undefined) body.name = payload.name;
  if (payload.kind !== undefined) body.kind = payload.kind;
  if (payload.parentId !== undefined) body.parent_id = payload.parentId;
  if (payload.color !== undefined) body.color = payload.color;
  if (payload.icon !== undefined) body.icon = payload.icon;

  const raw = await apiRequest<unknown>(
    `/categories/${encodeURIComponent(id)}`,
    { method: "PATCH", body },
  );
  const category = adaptCategory(raw);
  if (!category) throw new Error("Respons pembaruan kategori tidak dikenali.");
  return category;
}

export async function archiveCategory(
  id: string,
  reason?: string,
): Promise<Category> {
  const raw = await apiRequest<unknown>(
    `/categories/${encodeURIComponent(id)}/archive`,
    { method: "POST", body: reason ? { reason } : {} },
  );
  const category = adaptCategory(raw);
  if (!category) throw new Error("Respons arsip kategori tidak dikenali.");
  return category;
}

export async function deleteCategory(id: string): Promise<void> {
  await apiRequest<void>(`/categories/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function formatCategoryApiError(
  error: unknown,
  fallback: string,
): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return "Sesi kamu sudah berakhir. Masuk lagi untuk melanjutkan.";
    }
    if (error.status === 403) {
      return "Kamu tidak memiliki izin untuk mengelola kategori ini.";
    }
    if (error.status === 404) {
      return "Kategori tidak ditemukan atau sudah diarsipkan.";
    }
    if (error.status === 422) {
      return error.message || "Data kategori belum valid.";
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

export const CATEGORY_FORM_FIELDS = [
  "name",
  "kind",
  "parentId",
  "color",
  "icon",
] as const;
export type CategoryFormField = (typeof CATEGORY_FORM_FIELDS)[number];
export type CategoryFormErrors = Partial<Record<CategoryFormField, string>> &
  Record<string, string | undefined>;

export interface ExtractedCategoryValidationError {
  fieldErrors: CategoryFormErrors;
  generalErrors: string[];
}

export function extractCategoryValidationError(
  error: unknown,
): ExtractedCategoryValidationError | null {
  if (!(error instanceof ApiError) || error.status !== 422) return null;

  const detail =
    error.body && typeof error.body === "object"
      ? (error.body as { detail?: unknown }).detail
      : null;
  if (!Array.isArray(detail)) return null;

  const fieldErrors: CategoryFormErrors = {};
  const generalErrors: string[] = [];

  for (const entry of detail) {
    if (!entry || typeof entry !== "object") continue;
    const message =
      typeof (entry as { msg?: unknown }).msg === "string"
        ? (entry as { msg: string }).msg
        : null;
    if (!message) continue;

    const location = Array.isArray((entry as { loc?: unknown }).loc)
      ? (entry as { loc: unknown[] }).loc
      : [];
    const field = location.findLast(
      (segment): segment is string =>
        typeof segment === "string" && segment !== "body",
    );
    const formField = toCategoryFormField(field);
    if (!formField) {
      generalErrors.push(message);
      continue;
    }

    const current = fieldErrors[formField];
    fieldErrors[formField] = current ? `${current} ${message}` : message;
  }

  return { fieldErrors, generalErrors };
}

function toCategoryFormField(field: string | undefined): CategoryFormField | null {
  switch (field) {
    case "name":
    case "kind":
    case "color":
    case "icon":
      return field;
    case "parent_id":
      return "parentId";
    default:
      return null;
  }
}
