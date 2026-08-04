"use client";

import { useMemo } from "react";

import type { Account } from "@/lib/api/accounts";
import {
  DEBT_KIND_LABEL,
  formatDebtIdrAmountOnly,
  formatDebtIdrFromCents,
  formatDebtIsoDate,
  type Debt,
  type DebtKind,
  type DebtPayment,
  type DebtStatus,
} from "@/lib/api/debt-client";

interface DebtHistoryTableProps {
  debt: Debt;
  payments: DebtPayment[];
  /**
   * When `true`, the table renders the skeleton state in place of the
   * body rows so the layout doesn't flash on the first paint. Mirrors
   * the loading affordance used by the debt list (sub-0006-04).
   */
  isLoading: boolean;
  /**
   * Optional account lookup so the source-account column can render
   * the friendly name (e.g. "BCA Utama") instead of the raw uuid.
   * `sourceAccountId === null` (cash payment) renders as "Tunai"
   * regardless of the lookup.
   */
  accountsById: Map<string, Account>;
}

const KIND_BADGE_STYLES: Record<DebtKind, string> = {
  loan: "bg-slate-100 text-slate-700",
  credit_card: "bg-rose-100 text-rose-800",
  paylater: "bg-orange-100 text-orange-800",
  KTA: "bg-amber-100 text-amber-800",
  KKB: "bg-violet-100 text-violet-800",
  KPR: "bg-sky-100 text-sky-800",
  other: "bg-slate-100 text-slate-700",
};

const STATUS_BADGE_STYLES: Record<DebtStatus, string> = {
  active: "bg-emerald-100 text-emerald-800",
  paid_off: "bg-slate-200 text-slate-700",
};

/**
 * Read-only cicilan history for `/debts/{id}` (sub-0006-06).
 *
 * Visual contract:
 *
 *   - **Columns** — `Tanggal`, `Nominal`, `Pokok`, `Bunga`, `Sumber`,
 *     `Catatan`. The split is the most important signal for the
 *     user (the whole point of the table — "how much of every
 *     cicilan went to principal vs interest?") so the columns stay
 *     wide enough to read at a glance on mobile.
 *   - **Currency** — `formatDebtIdrFromCents` for the canonical
 *     "Rp X" string; the `pokok` / `bunga` cells use the compact
 *     `formatDebtIdrAmountOnly` so the split reads at a glance
 *     without the row's left edge drifting (the row header carries
 *     the `Rp` prefix once, in the `Nominal` column).
 *   - **Date** — Indonesian long form, parsed as UTC so a
 *     `2026-01-15` timestamp from the BE never drifts to
 *     `2026-01-14` in a UTC-7 browser.
 *   - **Source account** — the friendly account name when the
 *     `accountsById` lookup has the row; "Tunai" when the payment
 *     was made in cash (`sourceAccountId === null`); "Akun tidak
 *     ditemukan" when the lookup is missing the row (defensive —
 *     the BE rejects a foreign source account at write time, so
 *     the lookup should never miss in practice).
 *   - **Empty / skeleton** — see the two sub-components below. The
 *     empty state is a non-CTA panel (the "Catat cicilan" CTA lives
 *     in the page header so the user can fill the gap in one tap
 *     from the empty state too).
 *
 * Pagination lives in a sibling component
 * (`debt-history-pagination.tsx`) so the page can wire the
 * `onPageChange` callback without re-rendering the table.
 */
export function DebtHistoryTable({
  debt,
  payments,
  isLoading,
  accountsById,
}: DebtHistoryTableProps) {
  return (
    <section
      aria-label={`History cicilan untuk ${debt.name}`}
      data-testid="debt-history-section"
      className="mt-6"
    >
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th
                  scope="col"
                  className="px-3 py-3 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500"
                >
                  Tanggal
                </th>
                <th
                  scope="col"
                  className="px-3 py-3 text-right text-xs font-semibold uppercase tracking-[0.12em] text-slate-500"
                >
                  Nominal
                </th>
                <th
                  scope="col"
                  className="px-3 py-3 text-right text-xs font-semibold uppercase tracking-[0.12em] text-slate-500"
                >
                  Pokok
                </th>
                <th
                  scope="col"
                  className="px-3 py-3 text-right text-xs font-semibold uppercase tracking-[0.12em] text-slate-500"
                >
                  Bunga
                </th>
                <th
                  scope="col"
                  className="px-3 py-3 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500"
                >
                  Sumber
                </th>
                <th
                  scope="col"
                  className="px-3 py-3 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500"
                >
                  Catatan
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {isLoading ? (
                <DebtHistorySkeletonRows count={5} />
              ) : payments.length === 0 ? (
                <DebtHistoryEmptyRow
                  debtName={debt.name}
                  isPaidOff={debt.status === "paid_off"}
                />
              ) : (
                payments.map((payment) => (
                  <DebtHistoryRow
                    key={payment.id}
                    payment={payment}
                    accountsById={accountsById}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

interface DebtHistoryRowProps {
  payment: DebtPayment;
  accountsById: Map<string, Account>;
}

function DebtHistoryRow({ payment, accountsById }: DebtHistoryRowProps) {
  const sourceLabel = useMemo<string>(() => {
    if (payment.sourceAccountId === null) return "Tunai";
    const account = accountsById.get(payment.sourceAccountId);
    if (!account) return "Akun tidak ditemukan";
    return account.name;
  }, [payment.sourceAccountId, accountsById]);

  return (
    <tr
      data-testid={`debt-history-row-${payment.id}`}
      className="text-sm text-slate-700"
    >
      <td
        className="whitespace-nowrap px-3 py-3 text-slate-900"
        data-testid={`debt-history-row-date-${payment.id}`}
      >
        {formatDebtIsoDate(payment.occurredOn)}
      </td>
      <td className="whitespace-nowrap px-3 py-3 text-right font-semibold tabular-nums text-slate-900">
        {formatDebtIdrFromCents(payment.amountCents)}
      </td>
      <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums text-slate-700">
        Rp {formatDebtIdrAmountOnly(payment.principalPortionCents)}
      </td>
      <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums text-slate-700">
        Rp {formatDebtIdrAmountOnly(payment.interestPortionCents)}
      </td>
      <td className="whitespace-nowrap px-3 py-3 text-slate-700">
        {sourceLabel}
      </td>
      <td className="px-3 py-3 text-slate-600">
        {payment.note ? payment.note : <span className="text-slate-400">—</span>}
      </td>
    </tr>
  );
}

function DebtHistorySkeletonRows({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, index) => (
        <tr key={`skeleton-${index}`} aria-hidden="true">
          <td className="px-3 py-3">
            <div className="h-3 w-24 animate-pulse rounded bg-slate-200" />
          </td>
          <td className="px-3 py-3 text-right">
            <div className="ml-auto h-3 w-20 animate-pulse rounded bg-slate-200" />
          </td>
          <td className="px-3 py-3 text-right">
            <div className="ml-auto h-3 w-16 animate-pulse rounded bg-slate-100" />
          </td>
          <td className="px-3 py-3 text-right">
            <div className="ml-auto h-3 w-16 animate-pulse rounded bg-slate-100" />
          </td>
          <td className="px-3 py-3">
            <div className="h-3 w-24 animate-pulse rounded bg-slate-100" />
          </td>
          <td className="px-3 py-3">
            <div className="h-3 w-32 animate-pulse rounded bg-slate-100" />
          </td>
        </tr>
      ))}
    </>
  );
}

function DebtHistoryEmptyRow({
  debtName,
  isPaidOff,
}: {
  debtName: string;
  isPaidOff: boolean;
}) {
  return (
    <tr>
      <td colSpan={6} className="px-3 py-8 text-center text-sm text-slate-500">
        <p className="font-medium text-slate-700">
          {isPaidOff
            ? `${debtName} sudah lunas — tidak ada cicilan yang perlu dicatat.`
            : `Belum ada cicilan untuk ${debtName}.`}
        </p>
        <p className="mt-1 text-xs text-slate-500">
          {isPaidOff
            ? "Riwayat cicilan akan muncul di sini setelah ada cicilan yang tercatat."
            : "Catat cicilan pertama di pojok kanan atas untuk mulai mengisi history."}
        </p>
      </td>
    </tr>
  );
}

/* -------------------------------------------------------------------------- *
 * Detail summary card (sub-0006-06)                                          *
 * -------------------------------------------------------------------------- *
 *
 * Single-debt variant of the four-tile ringkasan the list page
 * (sub-0006-04) renders. The card surfaces:
 *
 *   - Debt header (name + kind/status badges).
 *   - Subheader (start date, tenor, bunga).
 *   - Four live tiles (sisa pokok, total pokok, bunga terbayar,
 *     cicilan / bulan). The `summary` prop can be `null` while the
 *     `/summary` fetch is still in flight — the tiles render a
 *     skeleton in that case so the user never sees "Rp 0" flash
 *     (same DEF-1 carry-over as the list page).
 *
 * The summary card lives in its own file so the page can keep its
 * orchestration focused on data flow + state machine; sibling
 * components stay reusable for future surfaces (e.g. a dashboard
 * widget that shows the per-debt ringkasan).
 */

interface DebtDetailSummaryCardProps {
  debt: Debt;
  summary: import("@/lib/api/debt-client").DebtSummary | null;
  isLoadingSummary: boolean;
  paymentCount: number;
}

export function DebtDetailSummaryCard({
  debt,
  summary,
  isLoadingSummary,
  paymentCount,
}: DebtDetailSummaryCardProps) {
  const kindBadge = KIND_BADGE_STYLES[debt.kind];
  const statusBadge = STATUS_BADGE_STYLES[debt.status];
  const isPaidOff = debt.status === "paid_off";
  const monthly = debt.monthlyPaymentCents;

  return (
    <section
      aria-label={`Ringkasan utang ${debt.name}`}
      data-testid="debt-detail-summary"
      className="card mt-6"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p
            className="truncate text-lg font-semibold text-slate-900"
            title={debt.name}
          >
            {debt.name}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Mulai {formatDebtIsoDate(debt.startDate)}
            {debt.tenorMonths !== null
              ? ` · Tenor ${debt.tenorMonths} bulan`
              : " · Tanpa tenor tetap"}
            {` · Bunga ${formatDebtBungaPctFromNumber(debt.bungaPct)} / tahun`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-xs font-semibold ${kindBadge}`}
            data-testid="debt-detail-kind-badge"
          >
            {DEBT_KIND_LABEL[debt.kind]}
          </span>
          <span
            className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-xs font-semibold ${statusBadge}`}
            data-testid="debt-detail-status-badge"
          >
            {isPaidOff ? "Lunas" : "Aktif"}
          </span>
        </div>
      </header>

      <dl className="mt-5 grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <SummaryTile
          label="Sisa pokok"
          value={
            summary
              ? formatDebtIdrFromCents(summary.remainingPrincipalCents)
              : null
          }
          loading={isLoadingSummary}
          testId="debt-detail-tile-remaining"
        />
        <SummaryTile
          label="Pokok awal"
          value={formatDebtIdrFromCents(debt.principalCents)}
          loading={false}
          testId="debt-detail-tile-principal"
        />
        <SummaryTile
          label="Bunga terbayar"
          value={
            summary
              ? formatDebtIdrFromCents(summary.totalInterestPaidCents)
              : null
          }
          loading={isLoadingSummary}
          testId="debt-detail-tile-interest"
        />
        <SummaryTile
          label="Cicilan / bulan"
          value={
            monthly !== null
              ? formatDebtIdrFromCents(monthly)
              : "Tanpa jadwal tetap"
          }
          loading={false}
          muted={monthly === null}
          testId="debt-detail-tile-monthly"
        />
      </dl>

      <p className="mt-4 text-xs leading-5 text-slate-500" aria-live="polite">
        {isPaidOff
          ? "Utang ini sudah lunas — ringkasan bunga mencerminkan total bunga yang sudah dibayarkan."
          : summary && summary.monthsRemaining !== null
            ? `Sisa tenor ${summary.monthsRemaining} bulan${
                summary.nextPaymentDueDate
                  ? ` · Jatuh tempo berikutnya ${formatDebtIsoDate(summary.nextPaymentDueDate)}`
                  : ""
              }.`
            : summary && summary.monthsRemaining === null && debt.tenorMonths === null
              ? "Tanpa jadwal tetap — cicilan dicatat secara manual."
              : ""}
        {` · ${paymentCount} cicilan tercatat.`}
      </p>

      {debt.note ? (
        <p className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">
          {debt.note}
        </p>
      ) : null}
    </section>
  );
}

interface SummaryTileProps {
  label: string;
  value: string | null;
  loading: boolean;
  muted?: boolean;
  testId?: string;
}

function SummaryTile({ label, value, loading, muted = false, testId }: SummaryTileProps) {
  return (
    <div className="flex flex-col gap-0.5" data-testid={testId}>
      <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
        {label}
      </dt>
      <dd
        className={`text-base font-semibold tabular-nums ${
          muted ? "text-slate-500" : "text-slate-900"
        }`}
      >
        {loading ? (
          <span
            className="inline-block h-5 w-20 animate-pulse rounded bg-slate-200"
            aria-hidden="true"
          />
        ) : value === null ? (
          "—"
        ) : (
          value
        )}
      </dd>
    </div>
  );
}

/**
 * Local "bunga per tahun" helper. Mirrors the same formatting the
 * list page uses (`formatDebtBungaPct`) but kept inline so the
 * detail page can render it inside the subheader copy without
 * importing the debt-client surface. The two formatters must agree
 * on the rounding (two-decimal cap) — pin in unit tests.
 */
function formatDebtBungaPctFromNumber(pct: number): string {
  if (!Number.isFinite(pct)) return "0%";
  return `${pct.toLocaleString("id-ID", {
    maximumFractionDigits: 2,
  })}%`;
}
