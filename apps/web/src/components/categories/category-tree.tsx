"use client";

import { useMemo } from "react";

import {
  CATEGORY_KIND_LABEL,
  CATEGORY_KIND_VALUES,
  type Category,
  type CategoryKind,
} from "@/lib/api/category-client";

interface CategoryTreeProps {
  categories: Category[];
  onCreateChild: (category: Category) => void;
  onEdit: (category: Category) => void;
  onArchive: (category: Category) => void;
}

interface CategoryTreeNode {
  category: Category;
  children: CategoryTreeNode[];
}

const CATEGORY_KIND_STYLES: Record<
  CategoryKind,
  { badge: string; surface: string; fallbackColor: string }
> = {
  income: {
    badge: "bg-emerald-100 text-emerald-800",
    surface: "border-emerald-200 bg-emerald-50/70 text-emerald-900",
    fallbackColor: "#059669",
  },
  expense: {
    badge: "bg-rose-100 text-rose-800",
    surface: "border-rose-200 bg-rose-50/70 text-rose-900",
    fallbackColor: "#e11d48",
  },
};

const CATEGORY_COLLATOR = new Intl.Collator("id-ID", {
  sensitivity: "base",
  numeric: true,
});

function buildCategoryForest(categories: Category[]): CategoryTreeNode[] {
  const rows = [...categories]
    .filter((category) => !category.archived)
    .sort((left, right) =>
      CATEGORY_COLLATOR.compare(left.name, right.name) ||
      left.id.localeCompare(right.id),
    );
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

  const visited = new Set<string>();
  const visit = (
    category: Category,
    ancestors: ReadonlySet<string>,
  ): CategoryTreeNode | null => {
    if (ancestors.has(category.id)) return null;
    visited.add(category.id);
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(category.id);
    const children = (childrenByParent.get(category.id) ?? [])
      .map((child) => visit(child, nextAncestors))
      .filter((child): child is CategoryTreeNode => child !== null);
    return { category, children };
  };

  const forest = roots
    .map((category) => visit(category, new Set<string>()))
    .filter((node): node is CategoryTreeNode => node !== null);

  for (const category of rows) {
    if (visited.has(category.id)) continue;
    const node = visit(category, new Set<string>());
    if (node) forest.push(node);
  }

  return forest;
}

export function CategoryTree({
  categories,
  onCreateChild,
  onEdit,
  onArchive,
}: CategoryTreeProps) {
  const groups = useMemo(
    () =>
      CATEGORY_KIND_VALUES.map((kind) => {
        const rows = categories.filter((category) => category.kind === kind);
        return { kind, rows, forest: buildCategoryForest(rows) };
      }),
    [categories],
  );

  return (
    <div className="mt-6 grid items-start gap-5 xl:grid-cols-2">
      {groups.map(({ kind, rows, forest }) => (
        <CategoryGroup
          key={kind}
          kind={kind}
          count={rows.length}
          forest={forest}
          onCreateChild={onCreateChild}
          onEdit={onEdit}
          onArchive={onArchive}
        />
      ))}
    </div>
  );
}

interface CategoryGroupProps extends Omit<CategoryTreeProps, "categories"> {
  kind: CategoryKind;
  count: number;
  forest: CategoryTreeNode[];
}

function CategoryGroup({
  kind,
  count,
  forest,
  onCreateChild,
  onEdit,
  onArchive,
}: CategoryGroupProps) {
  const styles = CATEGORY_KIND_STYLES[kind];

  return (
    <section
      className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
      aria-labelledby={`category-group-${kind}`}
    >
      <header className={`flex items-center justify-between gap-3 border-b px-4 py-4 sm:px-5 ${styles.surface}`}>
        <div>
          <h3 id={`category-group-${kind}`} className="text-base font-semibold">
            {CATEGORY_KIND_LABEL[kind]}
          </h3>
          <p className="mt-1 text-xs opacity-80">
            {kind === "income"
              ? "Sumber dana yang masuk ke akun."
              : "Kebutuhan dan penggunaan dana."}
          </p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${styles.badge}`}>
          {count} kategori
        </span>
      </header>

      {forest.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-slate-500">
          Belum ada kategori {CATEGORY_KIND_LABEL[kind].toLowerCase()}.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100" role="tree">
          {forest.map((node) => (
            <CategoryBranch
              key={node.category.id}
              node={node}
              level={1}
              styles={styles}
              onCreateChild={onCreateChild}
              onEdit={onEdit}
              onArchive={onArchive}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

interface CategoryBranchProps extends Omit<CategoryTreeProps, "categories"> {
  node: CategoryTreeNode;
  level: number;
  styles: (typeof CATEGORY_KIND_STYLES)[CategoryKind];
}

function CategoryBranch({
  node,
  level,
  styles,
  onCreateChild,
  onEdit,
  onArchive,
}: CategoryBranchProps) {
  const { category, children } = node;
  const initial = (category.name.charAt(0) || "K").toUpperCase();

  return (
    <li
      role="treeitem"
      aria-level={level}
      aria-selected={false}
      aria-expanded={children.length > 0 || undefined}
    >
      <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:px-5">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white shadow-sm"
            style={{ backgroundColor: category.color || styles.fallbackColor }}
            aria-hidden="true"
          >
            {initial}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-slate-900" title={category.name}>
              {category.name}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">
              {category.parentId ? "Subkategori" : "Kategori utama"}
              {children.length > 0 ? ` · ${children.length} turunan langsung` : ""}
            </p>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 sm:flex sm:shrink-0">
          <button
            type="button"
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 shadow-sm transition hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2"
            onClick={() => onCreateChild(category)}
            aria-label={`Tambah subkategori di ${category.name}`}
          >
            + Anak
          </button>
          <button
            type="button"
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 shadow-sm transition hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2"
            onClick={() => onEdit(category)}
            aria-label={`Edit kategori ${category.name}`}
          >
            Edit
          </button>
          <button
            type="button"
            className="rounded-md border border-rose-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-rose-700 shadow-sm transition hover:bg-rose-50 focus:outline-none focus:ring-2 focus:ring-rose-500 focus:ring-offset-2"
            onClick={() => onArchive(category)}
            aria-label={`Arsipkan kategori ${category.name}`}
          >
            Arsip
          </button>
        </div>
      </div>
      {children.length > 0 ? (
        <ul className="ml-4 border-l border-slate-200 pl-2 sm:ml-7 sm:pl-3" role="group">
          {children.map((child) => (
            <CategoryBranch
              key={child.category.id}
              node={child}
              level={level + 1}
              styles={styles}
              onCreateChild={onCreateChild}
              onEdit={onEdit}
              onArchive={onArchive}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
