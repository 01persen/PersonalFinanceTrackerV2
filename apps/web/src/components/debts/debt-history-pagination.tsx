"use client";

import { ActionIcon } from "@/components/shell/icons";

interface DebtHistoryPaginationProps {
  /** 0-based page index (matches the BE `offset` semantics). */
  page: number;
  /** Page size (matches the BE `limit`). */
  pageSize: number;
  /**
   * Total row count for the debt. The component computes the page
   * count itself as `Math.ceil(total / pageSize)` so the page can
   * stay focused on the data fetch.
   */
  total: number;
  /** Disable both controls while the next/prev page is in flight. */
  isLoading: boolean;
  onPageChange: (nextPage: number) => void;
}

/**
 * Pagination control for the cicilan history table (sub-0006-06).
 *
 * The BE returns `total` + `limit` + `offset` in the list envelope
 * (sub-0006-02), so the FE computes the page count itself rather
 * than asking the BE. The page size is fixed at the call site
 * (defaults to `DEBT_HISTORY_DEFAULT_PAGE_SIZE`) — a page-size
 * selector is out of scope for the MVP and would add a third
 * dimension of URL state without a clear user need.
 *
 * The control is a bare `‹ Sebelumnya · Halaman N dari M · Berikutnya ›`
 * strip — same shape used by the goals list and the transactions
 * search results, so the affordance is familiar. When `total` is
 * `0` the component renders an inert "Halaman 1 dari 1" hint so the
 * table area keeps its vertical rhythm on the empty state (no
 * layout shift when the first cicilan lands).
 */
export function DebtHistoryPagination({
  page,
  pageSize,
  total,
  isLoading,
  onPageChange,
}: DebtHistoryPaginationProps) {
  const totalPages = Math.max(1, Math.ceil(Math.max(total, 0) / pageSize));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const canPrev = safePage > 0;
  const canNext = safePage < totalPages - 1;

  return (
    <nav
      aria-label="Navigasi halaman history cicilan"
      data-testid="debt-history-pagination"
      className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500"
    >
      <span>
        Halaman {safePage + 1} dari {totalPages}
        {total > 0
          ? ` · ${total} cicilan tercatat`
          : " · belum ada cicilan"}
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          className="btn-secondary !w-auto px-3 py-1.5 text-xs"
          onClick={() => onPageChange(safePage - 1)}
          disabled={!canPrev || isLoading}
          aria-disabled={!canPrev || isLoading}
          aria-label="Halaman sebelumnya"
          data-testid="debt-history-prev"
        >
          <ActionIcon
            name="chevron-left"
            className="mr-1 inline h-3 w-3"
            aria-hidden="true"
          />
          Sebelumnya
        </button>
        <button
          type="button"
          className="btn-secondary !w-auto px-3 py-1.5 text-xs"
          onClick={() => onPageChange(safePage + 1)}
          disabled={!canNext || isLoading}
          aria-disabled={!canNext || isLoading}
          aria-label="Halaman berikutnya"
          data-testid="debt-history-next"
        >
          Berikutnya
          <ActionIcon
            name="chevron-right"
            className="ml-1 inline h-3 w-3"
            aria-hidden="true"
          />
        </button>
      </div>
    </nav>
  );
}
