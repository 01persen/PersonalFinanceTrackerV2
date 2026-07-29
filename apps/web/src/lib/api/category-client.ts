import { apiRequest } from "@/lib/api/client";
import {
  adaptCategories,
  CATEGORY_KIND_VALUES,
  type Category,
  type CategoryKind,
} from "@/lib/api/categories";

export { CATEGORY_KIND_VALUES, type Category, type CategoryKind };

/**
 * Friendly labels for the category kind toggle. Mirrors the
 * ``CategoryKind`` enum in the backend.
 */
export const CATEGORY_KIND_LABEL: Record<CategoryKind, string> = {
  income: "Pemasukan",
  expense: "Pengeluaran",
};

/**
 * Fetch the user's categories (income + expense). The backend returns a
 * flat list ordered kind → parent → name; the FE keeps the order so the
 * filter dropdown groupings stay stable across page loads.
 *
 * Accepts an ``AbortSignal`` so the caller can drop in-flight requests
 * when a newer load starts (race condition guard, see sub-0002-03 Cek 5).
 */
export async function fetchCategories(
  options: { signal?: AbortSignal } = {},
): Promise<Category[] | null> {
  const raw = await apiRequest<unknown>("/categories", { signal: options.signal });
  return adaptCategories(raw);
}
