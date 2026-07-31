"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ConfirmDialog } from "@/components/accounts/confirm-dialog";
import { CategoryEditorSheet } from "@/components/categories/category-editor-sheet";
import { CategoryTree } from "@/components/categories/category-tree";
import { AppShell } from "@/components/shell/app-shell";
import { ActionIcon, NavigationIcon } from "@/components/shell/icons";
import {
  archiveCategory,
  fetchCategories,
  formatCategoryApiError,
  type Category,
} from "@/lib/api/category-client";
import { useAuth } from "@/lib/auth/auth-context";
import { AuthGuard } from "@/lib/auth/auth-guard";

type LoadStatus = "loading" | "ready" | "error";

type EditorState =
  | { mode: "create"; parentId: string | null }
  | { mode: "edit"; categoryId: string };

interface CategoriesPageState {
  status: LoadStatus;
  rows: Category[];
  errorMessage: string | null;
}

const INITIAL_STATE: CategoriesPageState = {
  status: "loading",
  rows: [],
  errorMessage: null,
};

const CATEGORY_COLLATOR = new Intl.Collator("id-ID", {
  sensitivity: "base",
  numeric: true,
});

function sortCategories(categories: Category[]): Category[] {
  return [...categories].sort((left, right) => {
    const kindOrder = left.kind === right.kind ? 0 : left.kind === "income" ? -1 : 1;
    const parentOrder =
      left.parentId === right.parentId
        ? 0
        : left.parentId === null
          ? -1
          : right.parentId === null
            ? 1
            : left.parentId.localeCompare(right.parentId);
    return (
      kindOrder ||
      parentOrder ||
      CATEGORY_COLLATOR.compare(left.name, right.name) ||
      left.id.localeCompare(right.id)
    );
  });
}

function countDescendants(categories: Category[], categoryId: string): number {
  const childrenByParent = new Map<string, string[]>();
  for (const category of categories) {
    if (!category.parentId) continue;
    const children = childrenByParent.get(category.parentId) ?? [];
    children.push(category.id);
    childrenByParent.set(category.parentId, children);
  }

  const seen = new Set<string>([categoryId]);
  const pending = [...(childrenByParent.get(categoryId) ?? [])];
  while (pending.length > 0) {
    const id = pending.pop();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    pending.push(...(childrenByParent.get(id) ?? []));
  }
  return seen.size - 1;
}

export default function CategoriesPage() {
  return (
    <AuthGuard>
      <CategoriesContent />
    </AuthGuard>
  );
}

function CategoriesContent() {
  const router = useRouter();
  const { user, logout, isLoading: isLoggingOut } = useAuth();
  const [state, setState] = useState<CategoriesPageState>(INITIAL_STATE);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<Category | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const latestLoadIdRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const archiveBusyRef = useRef(false);

  const load = useCallback(async () => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const loadId = ++latestLoadIdRef.current;
    const dropStale = (): boolean =>
      loadId !== latestLoadIdRef.current || controller.signal.aborted;

    setState((current) => ({
      ...current,
      status: "loading",
      errorMessage: null,
    }));

    try {
      const categories = await fetchCategories({
        signal: controller.signal,
        limit: 500,
      });
      if (dropStale()) return;
      if (categories === null) {
        throw new Error("Respons daftar kategori tidak dikenali.");
      }
      setState({
        status: "ready",
        rows: sortCategories(categories.filter((category) => !category.archived)),
        errorMessage: null,
      });
    } catch (error) {
      if (dropStale()) return;
      setState({
        status: "error",
        rows: [],
        errorMessage: formatCategoryApiError(
          error,
          "Tidak bisa memuat kategori. Periksa koneksi lalu coba lagi.",
        ),
      });
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
    };
  }, [load]);

  const handleLogout = async () => {
    await logout();
    router.replace("/login");
  };

  const handleCloseEditor = useCallback(() => setEditor(null), []);
  const handleOpenCreate = useCallback(
    () => setEditor({ mode: "create", parentId: null }),
    [],
  );
  const handleCreateChild = useCallback(
    (category: Category) =>
      setEditor({ mode: "create", parentId: category.id }),
    [],
  );
  const handleEdit = useCallback(
    (category: Category) =>
      setEditor({ mode: "edit", categoryId: category.id }),
    [],
  );
  const handleOpenArchive = useCallback((category: Category) => {
    setArchiveTarget(category);
    setArchiveError(null);
  }, []);
  const handleCloseArchive = useCallback(() => {
    if (archiveBusyRef.current) return;
    setArchiveTarget(null);
    setArchiveError(null);
  }, []);

  const handleSaved = useCallback((saved: Category) => {
    const updatedExisting = editor?.mode === "edit";
    setState((current) => {
      if (current.status !== "ready") return current;
      const rows = updatedExisting
        ? current.rows.map((category) =>
            category.id === saved.id ? saved : category,
          )
        : [...current.rows, saved];
      return { ...current, rows: sortCategories(rows) };
    });
    setEditor(null);
    setNotice(
      updatedExisting
        ? `Kategori “${saved.name}” berhasil diperbarui.`
        : `Kategori “${saved.name}” berhasil ditambahkan.`,
    );
  }, [editor]);

  const handleConfirmArchive = useCallback(async () => {
    if (!archiveTarget || archiveBusyRef.current || state.status !== "ready") {
      return;
    }

    const target = archiveTarget;
    const snapshot = state;
    archiveBusyRef.current = true;
    setArchiveBusy(true);
    setArchiveError(null);
    setState({
      ...state,
      rows: state.rows.filter((category) => category.id !== target.id),
    });

    try {
      await archiveCategory(target.id);
      setArchiveTarget(null);
      setNotice(`Kategori “${target.name}” berhasil diarsipkan.`);
    } catch (error) {
      setState(snapshot);
      setArchiveError(
        formatCategoryApiError(
          error,
          "Kategori gagal diarsipkan. Periksa koneksi lalu coba lagi.",
        ),
      );
    } finally {
      archiveBusyRef.current = false;
      setArchiveBusy(false);
    }
  }, [archiveTarget, state]);

  const editingCategory = useMemo(() => {
    if (!editor || editor.mode !== "edit") return null;
    return state.rows.find((category) => category.id === editor.categoryId) ?? null;
  }, [editor, state.rows]);
  const defaultParentId =
    editor?.mode === "create" ? editor.parentId : editingCategory?.parentId ?? null;
  const descendantCount = archiveTarget
    ? countDescendants(state.rows, archiveTarget.id)
    : 0;

  return (
    <AppShell
      user={user}
      isLoggingOut={isLoggingOut}
      onLogout={handleLogout}
    >
      <CategoriesHeader
        onAdd={handleOpenCreate}
        disabled={state.status !== "ready"}
      />

      {state.status === "loading" ? <CategoriesSkeleton /> : null}

      {state.status === "error" ? (
        <CategoriesError message={state.errorMessage} onRetry={() => void load()} />
      ) : null}

      {state.status === "ready" && notice ? (
        <div
          className="mt-6 flex items-start justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
          role="status"
          aria-live="polite"
        >
          <p>{notice}</p>
          <button
            type="button"
            className="shrink-0 rounded text-emerald-700 hover:text-emerald-950 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            onClick={() => setNotice(null)}
            aria-label="Tutup notifikasi"
          >
            <ActionIcon name="close" className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      {state.status === "ready" && state.rows.length === 0 ? (
        <CategoriesEmptyState onAdd={handleOpenCreate} />
      ) : null}

      {state.status === "ready" && state.rows.length > 0 ? (
        <CategoryTree
          categories={state.rows}
          onCreateChild={handleCreateChild}
          onEdit={handleEdit}
          onArchive={handleOpenArchive}
        />
      ) : null}

      <CategoryEditorSheet
        open={editor !== null}
        category={editingCategory}
        defaultParentId={defaultParentId}
        categories={state.rows}
        onClose={handleCloseEditor}
        onSaved={handleSaved}
      />

      <ConfirmDialog
        open={archiveTarget !== null}
        title="Arsipkan kategori?"
        description={
          archiveTarget ? (
            <>
              <p>
                Kategori <strong>{archiveTarget.name}</strong> akan disembunyikan dari
                daftar aktif. Riwayat transaksi tetap tersimpan.
              </p>
              {descendantCount > 0 ? (
                <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-amber-900">
                  {descendantCount} subkategori tetap aktif dan akan tampil sebagai
                  kategori utama.
                </p>
              ) : null}
              {archiveError ? (
                <p className="mt-2 text-red-700" role="alert">
                  {archiveError}
                </p>
              ) : null}
            </>
          ) : null
        }
        confirmLabel="Arsipkan"
        destructive
        busy={archiveBusy}
        onConfirm={() => void handleConfirmArchive()}
        onCancel={handleCloseArchive}
      />
    </AppShell>
  );
}

function CategoriesHeader({
  onAdd,
  disabled,
}: {
  onAdd: () => void;
  disabled: boolean;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-700">
          Epic 0004 · Categorization &amp; Search
        </p>
        <h2 className="mt-1 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">
          Manajemen kategori
        </h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
          Susun kategori pemasukan dan pengeluaran dalam hirarki yang mudah
          dipakai saat mencatat transaksi.
        </p>
      </div>
      <button
        type="button"
        className="btn-primary !w-auto px-4"
        onClick={onAdd}
        disabled={disabled}
      >
        + Tambah kategori
      </button>
    </header>
  );
}

function CategoriesSkeleton() {
  return (
    <div
      className="mt-6 grid items-start gap-5 xl:grid-cols-2"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      {[5, 7].map((rows, groupIndex) => (
        <div
          key={rows}
          className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
        >
          <div className="border-b border-slate-200 px-5 py-4">
            <div className="h-4 w-28 animate-pulse rounded bg-slate-200" />
            <div className="mt-2 h-3 w-44 animate-pulse rounded bg-slate-100" />
          </div>
          <ul className="divide-y divide-slate-100 px-4">
            {Array.from({ length: rows }).map((_, index) => (
              <li
                key={index}
                className={`flex items-center gap-3 py-3 ${
                  index % 3 === 1 ? "ml-5 border-l border-slate-200 pl-3" : ""
                }`}
              >
                <div className="h-9 w-9 animate-pulse rounded-full bg-slate-200" />
                <div className="min-w-0 flex-1">
                  <div
                    className={`h-4 animate-pulse rounded bg-slate-200 ${
                      (index + groupIndex) % 2 === 0 ? "w-32" : "w-44"
                    }`}
                  />
                  <div className="mt-2 h-3 w-20 animate-pulse rounded bg-slate-100" />
                </div>
                <div className="h-7 w-20 animate-pulse rounded bg-slate-100" />
              </li>
            ))}
          </ul>
        </div>
      ))}
      <span className="sr-only">Memuat pohon kategori...</span>
    </div>
  );
}

function CategoriesError({
  message,
  onRetry,
}: {
  message: string | null;
  onRetry: () => void;
}) {
  return (
    <section
      className="card mt-6 flex flex-col items-start gap-3 border-red-200 bg-red-50"
      role="alert"
      aria-live="assertive"
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100 text-red-700">
        <ActionIcon name="close" className="h-5 w-5" />
      </div>
      <h3 className="text-base font-semibold text-red-900">
        Gagal memuat kategori
      </h3>
      <p className="text-sm leading-6 text-red-800">
        {message ?? "Tidak bisa memuat kategori. Coba lagi beberapa saat."}
      </p>
      <button
        type="button"
        className="btn-primary !w-auto px-4"
        onClick={onRetry}
      >
        Coba lagi
      </button>
    </section>
  );
}

function CategoriesEmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <section
      className="card mt-6 flex flex-col items-center gap-4 py-10 text-center"
      aria-labelledby="categories-empty-heading"
    >
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-50 text-brand-700">
        <NavigationIcon name="categories" className="h-7 w-7" />
      </div>
      <div className="max-w-md">
        <h3
          id="categories-empty-heading"
          className="text-base font-semibold text-slate-900 sm:text-lg"
        >
          Belum ada kategori
        </h3>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Tambahkan kategori pemasukan atau pengeluaran agar transaksi lebih
          mudah dikelompokkan.
        </p>
      </div>
      <button
        type="button"
        className="btn-primary !w-auto px-5"
        onClick={onAdd}
      >
        Tambah kategori pertama
      </button>
    </section>
  );
}
