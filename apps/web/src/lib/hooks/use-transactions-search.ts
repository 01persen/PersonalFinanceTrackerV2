"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  fetchTransactionsSearch,
  type Transaction,
  type TransactionSearchFilters,
  type TransactionSearchResult,
} from "@/lib/api/transaction-client";
import { ApiError } from "@/lib/api/client";

/**
 * Data-fetching hook for `GET /transactions/search` (sub-0004-05).
 *
 * The hook is **stateless** w.r.t. the filter payload — the caller
 * (typically the ``/transactions`` page) owns the filter state and is
 * responsible for syncing it to the URL. The hook only owns the
 * in-flight fetch lifecycle and the result envelope. This split keeps
 * the data flow obvious: the URL is the single source of truth for
 * filters, the page mirrors it into a local ``TransactionSearchFilters``
 * value, and the hook translates that into a fetch + result.
 *
 * Race defense mirrors sub-0003-06 / sub-0003-07 / sub-0004-04:
 *
 *   - ``latestLoadIdRef`` bumps per ``load()`` call; setState after
 *     ``await`` only runs when the captured id is still the latest.
 *   - ``abortControllerRef`` lets each new load cancel the prior
 *     request mid-flight so its ``setState`` (or setState-after-error)
 *     never fires.
 *   - The ``useEffect`` cleanup aborts any in-flight load on unmount
 *     so React 18 strict-mode double mounts don't leak a pending
 *     promise that could call setState on an unmounted component.
 */

export type SearchLoadStatus = "loading" | "ready" | "error";

export interface UseTransactionsSearchResult {
  status: SearchLoadStatus;
  rows: Transaction[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  errorMessage: string | null;
}

export type UseTransactionsSearchApi = {
  state: UseTransactionsSearchResult;
  retry: () => void;
};

function summarizeSearchError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return "Sesi kamu sudah berakhir. Masuk lagi untuk mencari transaksi.";
    }
    if (error.status === 404) {
      // Foreign account/category id from a shared URL — sub-0004-03 BE
      // returns 404 here. Render as "tidak ditemukan" rather than a
      // generic server error so users with a stale link know what to do.
      return "Filter yang dikirim tidak ditemukan. Periksa kembali pranala.";
    }
    if (error.status === 422) {
      return (
        error.message ||
        "Filter pencarian tidak valid. Coba ubah dan cari ulang."
      );
    }
    if (error.status >= 500) {
      return "Server sedang bermasalah. Coba lagi beberapa saat.";
    }
    return error.message || "Gagal mencari transaksi.";
  }
  return "Tidak bisa mencari transaksi. Periksa koneksi lalu coba lagi.";
}

const INITIAL_STATE: UseTransactionsSearchResult = {
  status: "loading",
  rows: [],
  total: 0,
  page: 1,
  pageSize: 50,
  hasMore: false,
  errorMessage: null,
};

/**
 * Drop rows that share an ``id`` with an existing row. The search
 * endpoint echoes ``page`` + ``page_size`` and never returns the same
 * id twice in a single response, but two consecutive pages CAN have a
 * row in common when ``deleted_at`` flips between the two fetches —
 * we dedupe here so the "Muat halaman berikutnya" button doesn't
 * surface ghost rows.
 */
function dedupeRows(rows: Transaction[]): Transaction[] {
  const seen = new Set<string>();
  const out: Transaction[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

/**
 * Kick off a search whenever ``filters`` changes. The hook treats a
 * re-render with a different ``filters`` reference as "fetch now" —
 * the page is responsible for debouncing inputs that should batch
 * (the global search bar debounces the ``q`` field itself, so a fast
 * typist never causes more than one round-trip per debounce window).
 */
export function useTransactionsSearch(
  filters: TransactionSearchFilters,
): UseTransactionsSearchApi {
  const [state, setState] = useState<UseTransactionsSearchResult>(INITIAL_STATE);
  const latestLoadIdRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const runFetch = useCallback(async (nextFilters: TransactionSearchFilters) => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const loadId = ++latestLoadIdRef.current;
    const isPagination = nextFilters.page > 1;

    setState((current) => ({
      ...current,
      status: "loading",
      errorMessage: null,
    }));

    const dropStale = (): boolean =>
      loadId !== latestLoadIdRef.current || controller.signal.aborted;

    try {
      const result: TransactionSearchResult = await fetchTransactionsSearch(
        nextFilters,
        { signal: controller.signal },
      );
      if (dropStale()) return;

      setState((current) => ({
        status: "ready",
        rows: isPagination
          ? dedupeRows([...current.rows, ...result.items])
          : result.items,
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        hasMore: result.page * result.pageSize < result.total,
        errorMessage: null,
      }));
    } catch (error) {
      if (dropStale()) return;
      setState((current) => ({
        ...current,
        status: "error",
        rows: isPagination ? current.rows : [],
        total: isPagination ? current.total : 0,
        page: nextFilters.page,
        pageSize: nextFilters.pageSize,
        hasMore: isPagination ? current.hasMore : false,
        errorMessage: summarizeSearchError(error),
      }));
    }
  }, []);

  useEffect(() => {
    void runFetch(filters);
  }, [filters, runFetch]);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
    };
  }, []);

  const retry = useCallback(() => {
    void runFetch(filtersRef.current);
  }, [runFetch]);

  return { state, retry };
}