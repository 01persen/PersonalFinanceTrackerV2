"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { ActionIcon } from "@/components/shell/icons";
import {
  CATEGORY_KIND_LABEL,
  CATEGORY_KIND_VALUES,
  createCategory,
  extractCategoryValidationError,
  formatCategoryApiError,
  updateCategory,
  type Category,
  type CategoryFormErrors,
  type CategoryKind,
} from "@/lib/api/category-client";

interface CategoryEditorSheetProps {
  open: boolean;
  category: Category | null;
  defaultParentId: string | null;
  categories: Category[];
  onClose: () => void;
  onSaved: (category: Category) => void;
}

interface CategoryFormValues {
  name: string;
  kind: CategoryKind;
  parentId: string;
  color: string;
  icon: string;
}

interface ParentOption {
  category: Category;
  depth: number;
}

const CATEGORY_NAME_MAX = 120;
const CATEGORY_COLOR_MAX = 16;
const CATEGORY_ICON_MAX = 64;
const CATEGORY_COLLATOR = new Intl.Collator("id-ID", {
  sensitivity: "base",
  numeric: true,
});

function initialValues(
  category: Category | null,
  defaultParentId: string | null,
  categories: Category[],
): CategoryFormValues {
  if (category) {
    return {
      name: category.name,
      kind: category.kind,
      parentId: category.parentId ?? "",
      color: category.color ?? "",
      icon: category.icon ?? "",
    };
  }

  const parent = defaultParentId
    ? categories.find((item) => item.id === defaultParentId)
    : null;
  return {
    name: "",
    kind: parent?.kind ?? "expense",
    parentId: parent?.id ?? "",
    color: "",
    icon: "",
  };
}

function flattenParentOptions(categories: Category[]): ParentOption[] {
  const rows = [...categories]
    .filter((category) => !category.archived)
    .sort((left, right) => {
      const kindOrder =
        CATEGORY_KIND_VALUES.indexOf(left.kind) -
        CATEGORY_KIND_VALUES.indexOf(right.kind);
      return (
        kindOrder ||
        CATEGORY_COLLATOR.compare(left.name, right.name) ||
        left.id.localeCompare(right.id)
      );
    });
  const byId = new Map(rows.map((category) => [category.id, category]));
  const childrenByParent = new Map<string, Category[]>();
  const roots: Category[] = [];

  for (const category of rows) {
    const parent = category.parentId ? byId.get(category.parentId) : null;
    if (!parent || parent.id === category.id) {
      roots.push(category);
      continue;
    }
    const children = childrenByParent.get(parent.id) ?? [];
    children.push(category);
    childrenByParent.set(parent.id, children);
  }

  const options: ParentOption[] = [];
  const visited = new Set<string>();
  const visit = (
    category: Category,
    depth: number,
    ancestors: ReadonlySet<string>,
  ): void => {
    if (ancestors.has(category.id)) return;
    visited.add(category.id);
    options.push({ category, depth });
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(category.id);
    for (const child of childrenByParent.get(category.id) ?? []) {
      visit(child, depth + 1, nextAncestors);
    }
  };

  for (const root of roots) visit(root, 0, new Set<string>());
  for (const category of rows) {
    if (!visited.has(category.id)) visit(category, 0, new Set<string>());
  }
  return options;
}

function descendantIds(categories: Category[], categoryId: string): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const category of categories) {
    if (!category.parentId) continue;
    const children = childrenByParent.get(category.parentId) ?? [];
    children.push(category.id);
    childrenByParent.set(category.parentId, children);
  }

  const forbidden = new Set<string>([categoryId]);
  const pending = [...(childrenByParent.get(categoryId) ?? [])];
  while (pending.length > 0) {
    const id = pending.pop();
    if (!id || forbidden.has(id)) continue;
    forbidden.add(id);
    pending.push(...(childrenByParent.get(id) ?? []));
  }
  return forbidden;
}

export function CategoryEditorSheet({
  open,
  category,
  defaultParentId,
  categories,
  onClose,
  onSaved,
}: CategoryEditorSheetProps) {
  const [values, setValues] = useState<CategoryFormValues>(() =>
    initialValues(category, defaultParentId, categories),
  );
  const [errors, setErrors] = useState<CategoryFormErrors>({});
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const busyRef = useRef(busy);

  const parentOptions = useMemo(
    () => flattenParentOptions(categories),
    [categories],
  );
  const forbiddenParentIds = useMemo(
    () => (category ? descendantIds(categories, category.id) : new Set<string>()),
    [categories, category],
  );

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    if (!open) return;
    setValues(initialValues(category, defaultParentId, categories));
    setErrors({});
    setGeneralError(null);
    setBusy(false);
  }, [open, category, defaultParentId, categories]);

  useEffect(() => {
    if (!open) return;

    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !busyRef.current) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    const focusTimer = window.setTimeout(() => nameInputRef.current?.focus(), 0);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
      window.clearTimeout(focusTimer);
      previouslyFocusedRef.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  const mode = category ? "edit" : "create";
  const title = mode === "edit" ? "Edit kategori" : "Tambah kategori";
  const selectedKindFallback = values.kind === "income" ? "#059669" : "#e11d48";

  const updateValue = <Key extends keyof CategoryFormValues>(
    field: Key,
    value: CategoryFormValues[Key],
  ): void => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
    setGeneralError(null);
  };

  const handleKindChange = (kind: CategoryKind): void => {
    const parent = categories.find((item) => item.id === values.parentId);
    setValues((current) => ({
      ...current,
      kind,
      parentId: parent && parent.kind !== kind ? "" : current.parentId,
    }));
    setErrors((current) => {
      const next = { ...current };
      delete next.kind;
      delete next.parentId;
      return next;
    });
    setGeneralError(null);
  };

  const validate = (): CategoryFormValues | null => {
    const nextErrors: CategoryFormErrors = {};
    const name = values.name.trim();
    const color = values.color.trim();
    const icon = values.icon.trim();

    if (!name) nextErrors.name = "Nama kategori wajib diisi.";
    if (name.length > CATEGORY_NAME_MAX) {
      nextErrors.name = `Nama maksimal ${CATEGORY_NAME_MAX} karakter.`;
    }
    if (color.length > CATEGORY_COLOR_MAX) {
      nextErrors.color = `Warna maksimal ${CATEGORY_COLOR_MAX} karakter.`;
    }
    if (icon.length > CATEGORY_ICON_MAX) {
      nextErrors.icon = `Ikon maksimal ${CATEGORY_ICON_MAX} karakter.`;
    }

    if (values.parentId) {
      const parent = categories.find((item) => item.id === values.parentId);
      if (!parent || parent.archived) {
        nextErrors.parentId = "Kategori induk sudah tidak tersedia.";
      } else if (forbiddenParentIds.has(parent.id)) {
        nextErrors.parentId = "Kategori tidak boleh menjadi induk dirinya atau turunannya.";
      } else if (parent.kind !== values.kind) {
        nextErrors.parentId = "Jenis kategori induk harus sama.";
      }
    }

    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      setGeneralError("Periksa kembali isian yang ditandai.");
      return null;
    }

    return { ...values, name, color, icon };
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setErrors({});
    setGeneralError(null);
    const validValues = validate();
    if (!validValues) return;

    setBusy(true);
    try {
      const payload = {
        name: validValues.name,
        kind: validValues.kind,
        parentId: validValues.parentId || null,
        color: validValues.color || null,
        icon: validValues.icon || null,
      };
      const saved = category
        ? await updateCategory(category.id, payload)
        : await createCategory(payload);
      onSaved(saved);
    } catch (error) {
      const extracted = extractCategoryValidationError(error);
      if (extracted) {
        setErrors(extracted.fieldErrors);
        setGeneralError(
          extracted.generalErrors.length > 0
            ? extracted.generalErrors.join(" ")
            : "Periksa kembali isian yang ditandai.",
        );
      } else {
        setGeneralError(
          formatCategoryApiError(error, "Kategori gagal disimpan. Coba lagi."),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 md:flex md:items-center md:justify-center md:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="category-editor-title"
    >
      <button
        type="button"
        className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm"
        aria-label="Tutup form kategori"
        onClick={onClose}
        disabled={busy}
      />
      <section className="absolute inset-0 flex min-h-0 flex-col bg-white md:relative md:inset-auto md:max-h-[calc(100vh-3rem)] md:w-full md:max-w-xl md:rounded-2xl md:border md:border-slate-200 md:shadow-2xl">
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-200 px-4 py-4 sm:px-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-700">
              {mode === "edit" ? "Perbarui kategori" : "Kategori baru"}
            </p>
            <h2 id="category-editor-title" className="mt-1 text-xl font-bold text-slate-950">
              {title}
            </h2>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              Pilih tanpa induk untuk kategori utama, atau tempatkan di bawah kategori lain.
            </p>
          </div>
          <button
            type="button"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500"
            onClick={onClose}
            disabled={busy}
            aria-label="Tutup"
          >
            <ActionIcon name="close" className="h-5 w-5" />
          </button>
        </header>

        <form className="flex min-h-0 flex-1 flex-col" onSubmit={handleSubmit} noValidate>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
            {generalError ? (
              <div
                className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm leading-6 text-red-800"
                role="alert"
                aria-live="assertive"
              >
                {generalError}
              </div>
            ) : null}

            <div className="grid gap-5">
              <div>
                <label htmlFor="category-name" className="form-label">
                  Nama kategori
                </label>
                <input
                  ref={nameInputRef}
                  id="category-name"
                  name="name"
                  type="text"
                  className="form-input mt-1"
                  placeholder="Contoh: Makan siang"
                  autoComplete="off"
                  required
                  maxLength={CATEGORY_NAME_MAX}
                  value={values.name}
                  onChange={(event) => updateValue("name", event.target.value)}
                  disabled={busy}
                  aria-invalid={errors.name ? "true" : "false"}
                  aria-describedby={errors.name ? "category-name-error" : "category-name-hint"}
                />
                {errors.name ? (
                  <p id="category-name-error" className="form-error" role="alert">
                    {errors.name}
                  </p>
                ) : (
                  <p id="category-name-hint" className="mt-1 text-xs text-slate-500">
                    Wajib, maksimal {CATEGORY_NAME_MAX} karakter.
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="category-kind" className="form-label">
                  Jenis kategori
                </label>
                <select
                  id="category-kind"
                  name="kind"
                  className="form-input mt-1"
                  value={values.kind}
                  onChange={(event) =>
                    handleKindChange(event.target.value as CategoryKind)
                  }
                  disabled={busy}
                  aria-invalid={errors.kind ? "true" : "false"}
                  aria-describedby={errors.kind ? "category-kind-error" : "category-kind-hint"}
                >
                  {CATEGORY_KIND_VALUES.map((kind) => (
                    <option key={kind} value={kind}>
                      {CATEGORY_KIND_LABEL[kind]}
                    </option>
                  ))}
                </select>
                {errors.kind ? (
                  <p id="category-kind-error" className="form-error" role="alert">
                    {errors.kind}
                  </p>
                ) : (
                  <p id="category-kind-hint" className="mt-1 text-xs text-slate-500">
                    Induk dan turunannya harus memiliki jenis yang sama.
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="category-parent" className="form-label">
                  Kategori induk <span className="font-normal text-slate-500">(opsional)</span>
                </label>
                <select
                  id="category-parent"
                  name="parentId"
                  className="form-input mt-1"
                  value={values.parentId}
                  onChange={(event) => updateValue("parentId", event.target.value)}
                  disabled={busy}
                  aria-invalid={errors.parentId ? "true" : "false"}
                  aria-describedby={errors.parentId ? "category-parent-error" : "category-parent-hint"}
                >
                  <option value="">Tanpa induk — kategori utama</option>
                  {parentOptions.map(({ category: option, depth }) => {
                    const forbidden = forbiddenParentIds.has(option.id);
                    const incompatible = option.kind !== values.kind;
                    const reason =
                      option.id === category?.id
                        ? " — kategori ini"
                        : forbidden
                          ? " — turunan"
                          : incompatible
                            ? " — beda jenis"
                            : "";
                    return (
                      <option
                        key={option.id}
                        value={option.id}
                        disabled={forbidden || incompatible}
                      >
                        {`${"— ".repeat(Math.min(depth, 5))}${option.name} (${CATEGORY_KIND_LABEL[option.kind]})${reason}`}
                      </option>
                    );
                  })}
                </select>
                {errors.parentId ? (
                  <p id="category-parent-error" className="form-error" role="alert">
                    {errors.parentId}
                  </p>
                ) : (
                  <p id="category-parent-hint" className="mt-1 text-xs text-slate-500">
                    Diri sendiri, turunan, dan kategori beda jenis tidak dapat dipilih.
                  </p>
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="category-color" className="form-label">
                    Warna <span className="font-normal text-slate-500">(opsional)</span>
                  </label>
                  <div className="mt-1 flex items-center gap-2">
                    <span
                      className="h-10 w-10 shrink-0 rounded-md border border-slate-200 shadow-sm"
                      style={{ backgroundColor: values.color.trim() || selectedKindFallback }}
                      aria-hidden="true"
                    />
                    <input
                      id="category-color"
                      name="color"
                      type="text"
                      className="form-input"
                      placeholder="#0f766e"
                      maxLength={CATEGORY_COLOR_MAX}
                      value={values.color}
                      onChange={(event) => updateValue("color", event.target.value)}
                      disabled={busy}
                      aria-invalid={errors.color ? "true" : "false"}
                      aria-describedby={errors.color ? "category-color-error" : "category-color-hint"}
                    />
                  </div>
                  {errors.color ? (
                    <p id="category-color-error" className="form-error" role="alert">
                      {errors.color}
                    </p>
                  ) : (
                    <p id="category-color-hint" className="mt-1 text-xs text-slate-500">
                      Nama warna atau kode hex.
                    </p>
                  )}
                </div>

                <div>
                  <label htmlFor="category-icon" className="form-label">
                    Ikon <span className="font-normal text-slate-500">(opsional)</span>
                  </label>
                  <input
                    id="category-icon"
                    name="icon"
                    type="text"
                    className="form-input mt-1"
                    placeholder="Contoh: food"
                    maxLength={CATEGORY_ICON_MAX}
                    value={values.icon}
                    onChange={(event) => updateValue("icon", event.target.value)}
                    disabled={busy}
                    aria-invalid={errors.icon ? "true" : "false"}
                    aria-describedby={errors.icon ? "category-icon-error" : "category-icon-hint"}
                  />
                  {errors.icon ? (
                    <p id="category-icon-error" className="form-error" role="alert">
                      {errors.icon}
                    </p>
                  ) : (
                    <p id="category-icon-hint" className="mt-1 text-xs text-slate-500">
                      Nama ikon singkat, maksimal {CATEGORY_ICON_MAX} karakter.
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>

          <footer className="grid shrink-0 grid-cols-2 gap-3 border-t border-slate-200 bg-white px-4 py-4 sm:flex sm:justify-end sm:px-6">
            <button
              type="button"
              className="btn-secondary"
              onClick={onClose}
              disabled={busy}
            >
              Batal
            </button>
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy
                ? "Menyimpan..."
                : mode === "edit"
                  ? "Simpan perubahan"
                  : "Tambah kategori"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
