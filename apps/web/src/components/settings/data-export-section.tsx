"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { ApiError } from "@/lib/api/client";
import { fetchExportBlob } from "@/lib/api/export-client";
import { downloadBlob } from "@/lib/download";
import { useAuth } from "@/lib/auth/auth-context";

/**
 * Data export section (sub-0008-05 — Export CSV / Export JSON / Download
 * Backup).
 *
 * Three buttons, each with an independent in-flight state so a slow
 * CSV export doesn't block the JSON download. The errors are surfaced
 * via a single inline banner above the section so the user sees the
 * toast regardless of which button fired.
 *
 * Authentication:
 *
 * - 401 / 403 → redirect to `/login` and surface a "Sesi berakhir,
 *   silakan login ulang" message. The redirect is triggered via
 *   `useAuth().logout()` so the local token store is cleared; the
 *   `AuthGuard` wrapper on the page will then bounce to the login
 *   screen on the next render.
 * - 5xx / network → "Gagal mengunduh, coba lagi" and the button stays
 *   enabled so the user can retry without a page reload.
 *
 * UX contract (AC (a)–(f)):
 *
 * - (a) Filename prefers the BE's `Content-Disposition` header
 *   (transactions-YYYY-MM-DD.csv, etc.) and falls back to the
 *   component's static filename template so a regression on the BE
 *   side still produces a sane file name.
 * - (b) Each button shows its own spinner. Buttons in flight disable
 *   themselves; the other buttons stay tappable.
 * - (c) On success the browser fires the download and the button
 *   returns to its idle state.
 * - (d) 401 → toast + redirect to `/login`.
 * - (e) 5xx / network → toast; button stays enabled.
 * - (f) Double-click guard: the in-flight state disables the button
 *   and a `latestRequestIdRef` ignores stale results so a slow
 *   request that resolves after a retry can't fire a duplicate
 *   download.
 *
 * Mobile-first 390×844: buttons stack vertically in a single column
 * with `min-h-[44px]` touch targets. The label / spinner switch is
 * `inline-flex` so the button width doesn't reflow mid-click.
 */

type ExportKind = "csv" | "json" | "zip";

interface ExportAction {
  kind: ExportKind;
  path: string;
  label: string;
  fallbackFilename: string;
  description: string;
  busyLabel: string;
  hint: string;
}

const EXPORT_ACTIONS: readonly ExportAction[] = [
  {
    kind: "csv",
    path: "/export/transactions.csv",
    label: "Export CSV",
    fallbackFilename: "transactions.csv",
    busyLabel: "Menyiapkan CSV...",
    description: "transactions-YYYY-MM-DD.csv",
    hint: "Buka di spreadsheet (LibreOffice / Excel / pandas).",
  },
  {
    kind: "json",
    path: "/export/transactions.json",
    label: "Export JSON",
    fallbackFilename: "transactions.json",
    busyLabel: "Menyiapkan JSON...",
    description: "transactions-YYYY-MM-DD.json",
    hint: "Snapshot JSON lengkap (akun, kategori, transaksi, goals, debts).",
  },
  {
    kind: "zip",
    path: "/export/backup.zip",
    label: "Download Backup",
    fallbackFilename: "backup.zip",
    busyLabel: "Membuat backup...",
    description: "backup-YYYY-MM-DD.zip",
    hint: "Arsip ZIP dengan JSON + manifest. Restore manual (lihat PRD §10).",
  },
];

type NoticeKind = "success" | "error" | "info";

interface Notice {
  kind: NoticeKind;
  message: string;
}

const SUCCESS_DURATION_MS = 4000;
const ERROR_DURATION_MS = 8000;

export function DataExportSection() {
  const router = useRouter();
  const { logout } = useAuth();

  const [busyKind, setBusyKind] = useState<ExportKind | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const latestRequestIdRef = useRef<number>(0);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearNoticeTimer = useCallback(() => {
    if (noticeTimerRef.current !== null) {
      clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }
  }, []);

  const scheduleNoticeClear = useCallback(
    (durationMs: number) => {
      clearNoticeTimer();
      noticeTimerRef.current = setTimeout(() => {
        setNotice(null);
        noticeTimerRef.current = null;
      }, durationMs);
    },
    [clearNoticeTimer],
  );

  const showNotice = useCallback(
    (next: Notice) => {
      setNotice(next);
      const duration = next.kind === "success" ? SUCCESS_DURATION_MS : ERROR_DURATION_MS;
      scheduleNoticeClear(duration);
    },
    [scheduleNoticeClear],
  );

  const handleExport = useCallback(
    async (action: ExportAction) => {
      if (busyKind !== null) return; // Double-click guard — refuse
                                 // while another button is mid-flight.
      const requestId = ++latestRequestIdRef.current;
      setBusyKind(action.kind);
      setNotice(null);

      try {
        const { blob, filename } = await fetchExportBlob(action.path);
        // A retry that resolved after a newer request shouldn't fire
        // a duplicate download.
        if (requestId !== latestRequestIdRef.current) return;

        const resolvedFilename = filename ?? action.fallbackFilename;
        downloadBlob(blob, resolvedFilename);
        showNotice({
          kind: "success",
          message: `${action.label} berhasil. File tersimpan di folder unduhan.`,
        });
      } catch (error) {
        if (requestId !== latestRequestIdRef.current) return;
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }

        if (error instanceof ApiError) {
          if (error.status === 401 || error.status === 403) {
            // Sesi berakhir — bersihkan token lokal dan redirect ke
            // login. Toast ditampilkan sebelum redirect supaya user
            // paham kenapa tiba-tiba dialihkan.
            showNotice({
              kind: "error",
              message: "Sesi berakhir, silakan login ulang.",
            });
            try {
              await logout();
            } catch {
              // logout() best-effort; lanjut redirect.
            }
            router.replace("/login");
            return;
          }
          if (error.status >= 500 || error.status === 0) {
            showNotice({
              kind: "error",
              message: "Gagal mengunduh, coba lagi.",
            });
            return;
          }
          showNotice({
            kind: "error",
            message: error.message || "Gagal mengunduh, coba lagi.",
          });
          return;
        }

        showNotice({
          kind: "error",
          message: "Gagal mengunduh, coba lagi.",
        });
      } finally {
        if (requestId === latestRequestIdRef.current) {
          setBusyKind(null);
        }
      }
    },
    [busyKind, logout, router, showNotice],
  );

  const isAnyBusy = busyKind !== null;

  const noticeBanner = useMemo<React.ReactNode>(() => {
    if (!notice) return null;
    const tone =
      notice.kind === "success"
        ? "border-emerald-200 bg-emerald-50 text-emerald-800"
        : notice.kind === "error"
          ? "border-red-200 bg-red-50 text-red-800"
          : "border-slate-200 bg-slate-50 text-slate-700";
    const role = notice.kind === "error" ? "alert" : "status";
    return (
      <div
        role={role}
        aria-live={notice.kind === "error" ? "assertive" : "polite"}
        className={`rounded-lg border px-3 py-2 text-sm ${tone}`}
      >
        {notice.message}
      </div>
    );
  }, [notice]);

  return (
    <section
      aria-labelledby="data-export-heading"
      className="grid gap-4"
    >
      <header className="grid gap-1">
        <h3
          id="data-export-heading"
          className="text-base font-semibold text-slate-900"
        >
          Data
        </h3>
        <p className="text-xs text-slate-500">
          Unduh transaksi sebagai CSV / JSON, atau ambil snapshot
          lengkap sebagai arsip ZIP. Tombol diaktifkan satu per satu —
          unduhan yang lambat tidak mengunci tombol lain.
        </p>
      </header>

      {noticeBanner}

      <div className="grid gap-3" role="group" aria-label="Aksi ekspor data">
        {EXPORT_ACTIONS.map((action) => {
          const isBusy = busyKind === action.kind;
          const isOtherBusy = isAnyBusy && !isBusy;
          return (
            <div
              key={action.kind}
              className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
            >
              <div className="grid gap-0.5">
                <p className="text-sm font-medium text-slate-900">
                  {action.label}
                </p>
                <p className="text-xs text-slate-500">
                  <span className="font-mono">{action.description}</span>
                  {" — "}
                  {action.hint}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleExport(action)}
                disabled={isBusy || isOtherBusy}
                aria-disabled={isBusy || isOtherBusy}
                aria-busy={isBusy}
                className="btn-secondary mt-2 inline-flex min-h-[44px] items-center justify-center gap-2 sm:mt-0 sm:w-auto sm:px-4"
                data-export-kind={action.kind}
              >
                {isBusy ? (
                  <>
                    <span
                      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700"
                      aria-hidden="true"
                    />
                    <span>{action.busyLabel}</span>
                  </>
                ) : (
                  <span>{action.label}</span>
                )}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
