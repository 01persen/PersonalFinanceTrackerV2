"use client";

import Link from "next/link";

import {
  DEBT_KIND_LABEL,
  DEBT_STATUS_LABEL,
  formatDebtBungaPct,
  formatDebtIdrAmountOnly,
  formatDebtIdrFromCents,
  formatDebtIsoDate,
  type Debt,
  type DebtKind,
  type DebtStatus,
  type DebtSummary,
} from "@/lib/api/debt-client";

interface DebtListProps {
  debts: Debt[];
  /**
   * Per-debt summary lookup so the row can show the live
   * `remaining_principal_cents` (the persisted `principal_cents` is
   * the *original* loan amount, not the outstanding balance). Missing
   * entries render as a small "Memuat…" line under the row so the
   * list isn't blocked by a slow summary fetch.
   */
  summaries: Map<string, DebtSummary>;
  /** `true` while the per-row summary fetches are still pending. */
  summariesLoading: boolean;
  /** IDs whose `/summary` fetch is still in flight. */
  pendingIds: ReadonlySet<string>;
  /**
   * IDs whose `/summary` fetch settled with a non-404 error. Rows in
   * this set render an explicit failure state (skeleton, not "Rp 0")
   * so the dashboard never flashes misleading zeros (DEF-1).
   */
  failedIds: ReadonlySet<string>;
  /**
   * Hide the "Catat cicilan" CTA. Used by the debts page when the
   * payment form is intentionally unavailable (e.g. while sub-0006-02
   * is still in-flight on FE). Defaults to `false` (CTA visible).
   */
  hidePaymentCta?: boolean;
}

interface KindBadgeStyles {
  badge: string;
}

const KIND_BADGE_STYLES: Record<DebtKind, KindBadgeStyles> = {
  loan: { badge: "bg-slate-100 text-slate-700" },
  credit_card: { badge: "bg-rose-100 text-rose-800" },
  paylater: { badge: "bg-orange-100 text-orange-800" },
  KTA: { badge: "bg-amber-100 text-amber-800" },
  KKB: { badge: "bg-violet-100 text-violet-800" },
  KPR: { badge: "bg-sky-100 text-sky-800" },
  other: { badge: "bg-slate-100 text-slate-700" },
};

const STATUS_BADGE_STYLES: Record<DebtStatus, string> = {
  active: "bg-emerald-100 text-emerald-800",
  paid_off: "bg-slate-200 text-slate-700",
};

/**
 * Pure helper exported for the unit test (sub-0006-04 AC). Mirrors the
 * production sort so the test can pin the ordering in isolation from
 * React: status (`active` before `paid_off`), then `start_date desc`,
 * then `created_at desc`, then `id asc` as the final tiebreaker. The
 * status order matches the BE order (`status` is a small enum so
 * sorting alphabetically `active < paid_off` would be wrong; we need
 * to surface the live debts on top of the closed ones).
 */
export function sortDebtsForDisplay(debts: Debt[]): Debt[] {
  const statusOrder: Record<DebtStatus, number> = {
    active: 0,
    paid_off: 1,
  };
  return [...debts].sort((left, right) => {
    const statusDiff = statusOrder[left.status] - statusOrder[right.status];
    if (statusDiff !== 0) return statusDiff;

    const leftStart = Date.parse(left.startDate);
    const rightStart = Date.parse(right.startDate);
    const leftTime = Number.isFinite(leftStart) ? leftStart : 0;
    const rightTime = Number.isFinite(rightStart) ? rightStart : 0;
    if (leftTime !== rightTime) return rightTime - leftTime;

    const leftCreated = Date.parse(left.createdAt);
    const rightCreated = Date.parse(right.createdAt);
    const leftCreatedTime = Number.isFinite(leftCreated) ? leftCreated : 0;
    const rightCreatedTime = Number.isFinite(rightCreated) ? rightCreated : 0;
    if (leftCreatedTime !== rightCreatedTime) return rightCreatedTime - leftCreatedTime;

    return left.id.localeCompare(right.id);
  });
}

interface DebtListProps {
  debts: Debt[];
  /**
   * Per-debt summary lookup so the row can show the live
   * `remaining_principal_cents` (the persisted `principal_cents` is
   * the *original* loan amount, not the outstanding balance). Missing
   * entries render as a small "Memuat…" line under the row so the
   * list isn't blocked by a slow summary fetch.
   */
  summaries: Map<string, DebtSummary>;
  /** `true` while at least one per-row summary fetch is still pending or failed. */
  summariesLoading: boolean;
  /** IDs whose `/summary` fetch is still in flight. */
  pendingIds: ReadonlySet<string>;
  /**
   * IDs whose `/summary` fetch settled with a non-404 error. Rows in
   * this set render an explicit failure state (skeleton, not "Rp 0")
   * so the dashboard never flashes misleading zeros (DEF-1).
   */
  failedIds: ReadonlySet<string>;
}

/**
 * Pure helper exported for the unit test (sub-0006-04 AC). Resolves
 * the per-row state from the three summary tracking slots. Centralised
 * here so the page-level wrapper, the row, and the test share one
 * source of truth for the row classification.
 *
 *   - `"ready"`   — summary fetched successfully.
 *   - `"loading"` — fetch is still in flight.
 *   - `"failed"`  — fetch settled with a non-404 error.
 *   - `"ready"`   — fallback for a row that wasn't in the fan-out
 *     (shouldn't happen in practice; returned as `ready` so the row
 *     degrades gracefully instead of rendering skeleton forever).
 */
export function resolveDebtRowState(
  debtId: string,
  summaries: ReadonlyMap<string, DebtSummary>,
  pendingIds: ReadonlySet<string>,
  failedIds: ReadonlySet<string>,
): "ready" | "loading" | "failed" {
  if (summaries.has(debtId)) return "ready";
  if (failedIds.has(debtId)) return "failed";
  if (pendingIds.has(debtId)) return "loading";
  return "ready";
}

/**
 * Read-only debt list — the page-level wrapper for the debt row
 * stack. Mirrors `GoalList` (sub-0005-03) so the layout is identical
 * to other dashboard lists: header with the count, then a vertical
 * stack of cards on mobile / a table-ish grid on `sm+`.
 *
 * The wrapper exists so the page can focus on data orchestration
 * (load + filter + URL sync + per-row summary fan-out) while the
 * layout + sort + zero-state copy live here.
 */
export function DebtList({
  debts,
  summaries,
  summariesLoading,
  pendingIds,
  failedIds,
  hidePaymentCta = false,
}: DebtListProps) {
  const ordered = sortDebtsForDisplay(debts);

  return (
    <section
      aria-label="Daftar utang"
      data-testid="debts-list"
      className="mt-6"
    >
      <p className="text-xs text-slate-500">
        Menampilkan {ordered.length} utang · cicilan dan sisa saldo
        mengikuti ringkasan per-baris.
      </p>
      {summariesLoading ? (
        <p
          className="mt-1 text-xs text-slate-400"
          aria-live="polite"
          data-testid="debts-summaries-pending"
        >
          Memuat ringkasan per-baris…
        </p>
      ) : null}
      <ul className="mt-4 grid list-none grid-cols-1 gap-3 p-0 sm:gap-4">
        {ordered.map((debt) => {
          const state = resolveDebtRowState(
            debt.id,
            summaries,
            pendingIds,
            failedIds,
          );
          const summary = summaries.get(debt.id) ?? null;
          return (
            <li key={debt.id} className="list-none">
              <DebtRow
                debt={debt}
                summary={summary}
                rowState={state}
                hidePaymentCta={hidePaymentCta}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

interface DebtRowProps {
  debt: Debt;
  summary: DebtSummary | null;
  /**
   * Resolved row state (see `resolveDebtRowState`). Centralised here
   * so the cell rendering uses one set of branches instead of three
   * overlapping boolean flags.
   */
  rowState: "ready" | "loading" | "failed";
  /**
   * Hide the "Catat cicilan" CTA on the row. Used by the debts
   * page when the payment form is intentionally unavailable.
   * Defaults to `false` (CTA visible).
   */
  hidePaymentCta?: boolean;
}

function DebtRow({
  debt,
  summary,
  rowState,
  hidePaymentCta = false,
}: DebtRowProps) {
  const kindBadge = KIND_BADGE_STYLES[debt.kind];
  const statusBadge = STATUS_BADGE_STYLES[debt.status];
  const monthly = debt.monthlyPaymentCents;
  const remaining =
    summary?.remainingPrincipalCents !== undefined
      ? summary.remainingPrincipalCents
      : null;
  const interestPaid =
    summary?.totalInterestPaidCents !== undefined
      ? summary.totalInterestPaidCents
      : null;
  const isPaidOff = debt.status === "paid_off";
  const summaryLoading = rowState === "loading";
  const summaryFailed = rowState === "failed";
  // `Sisa pokok` must never flash "Rp 0" or "—" — the cell renders
  // a skeleton for both `loading` and `failed` so the user sees a
  // consistent "data unavailable" placeholder (DEF-1).
  const remainingLoading = summaryLoading || summaryFailed;

  return (
    <article
      className="card flex flex-col gap-3"
      data-debt-id={debt.id}
      data-status={debt.status}
      data-summary-state={rowState}
      aria-label={`Utang ${debt.name}`}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p
            className="truncate text-base font-semibold text-slate-900"
            title={debt.name}
          >
            {debt.name}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Mulai {formatDebtIsoDate(debt.startDate)}
            {debt.tenorMonths !== null
              ? ` · Tenor ${debt.tenorMonths} bulan`
              : " · Tanpa tenor tetap"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-xs font-semibold ${kindBadge.badge}`}
          >
            {DEBT_KIND_LABEL[debt.kind]}
          </span>
          <span
            className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-xs font-semibold ${statusBadge}`}
          >
            {DEBT_STATUS_LABEL[debt.status]}
          </span>
        </div>
      </header>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <DebtDataPoint
          label="Sisa pokok"
          value={
            remaining !== null
              ? formatDebtIdrFromCents(remaining)
              : null
          }
          loading={remainingLoading}
          testId="debt-row-remaining"
        />
        <DebtDataPoint
          label="Pokok awal"
          value={formatDebtIdrFromCents(debt.principalCents)}
          loading={false}
          testId="debt-row-principal"
        />
        <DebtDataPoint
          label="Cicilan / bulan"
          value={
            monthly !== null
              ? formatDebtIdrFromCents(monthly)
              : "Tanpa jadwal tetap"
          }
          loading={false}
          muted={monthly === null}
          testId="debt-row-monthly"
        />
        <DebtDataPoint
          label="Bunga (annual)"
          value={formatDebtBungaPct(debt.bungaPct)}
          loading={false}
          testId="debt-row-bunga"
        />
      </dl>

      <p className="text-xs text-slate-500" aria-live="polite">
        {summaryLoading ? (
          <span data-testid={`debt-row-summary-pending-${debt.id}`}>
            Memuat ringkasan…
          </span>
        ) : summaryFailed ? (
          // DEF-1: explicit failure state. The ringkasan banner above
          // the list surfaces the upstream error; the row itself
          // doesn't fabricate a "Bunga terbayar: Rp 0" line that the
          // user could mistake for a real zero.
          <span data-testid={`debt-row-summary-failed-${debt.id}`}>
            Ringkasan tidak dapat dimuat. Buka peringatan di atas
            untuk mencoba lagi.
          </span>
        ) : isPaidOff ? (
          <>
            Bunga terbayar sampai lunas:{" "}
            <span className="font-semibold tabular-nums text-slate-700">
              {formatDebtIdrFromCents(interestPaid ?? 0)}
            </span>
            .
          </>
        ) : summary ? (
          <>
            Bunga terbayar:{" "}
            <span className="font-semibold tabular-nums text-slate-700">
              {formatDebtIdrFromCents(interestPaid ?? 0)}
            </span>
            {summary.monthsRemaining !== null ? (
              <>
                {" "}· Sisa tenor:{" "}
                <span className="font-semibold tabular-nums text-slate-700">
                  {summary.monthsRemaining} bulan
                </span>
              </>
            ) : null}
            {summary.nextPaymentDueDate ? (
              <>
                {" "}· Jatuh tempo berikutnya:{" "}
                <span className="font-semibold tabular-nums text-slate-700">
                  {formatDebtIsoDate(summary.nextPaymentDueDate)}
                </span>
              </>
            ) : null}
          </>
        ) : (
          // Defensive: rowState === "ready" but the summary map
          // somehow doesn't have this id (e.g. mid-render after a
          // filter change). Render an em dash instead of "Rp 0" so
          // we never mis-label a missing summary as a real zero.
          <span>Ringkasan tidak tersedia.</span>
        )}
      </p>

      {debt.note ? (
        <p className="rounded-md bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">
          {debt.note}
        </p>
      ) : null}

      <DebtRowActions
        debtId={debt.id}
        debtStatus={debt.status}
        hidePaymentCta={hidePaymentCta}
      />
    </article>
  );
}

interface DebtRowActionsProps {
  debtId: string;
  debtStatus: DebtStatus;
  hidePaymentCta: boolean;
}

/**
 * Per-row action footer. Mirrors the layout used by the transactions
 * / goals list rows so the same affordances surface everywhere:
 *
 *   - "Catat cicilan" (primary): only for `active` debts so the user
 *     can't POST a payment on a closed debt (the BE rejects with 422
 *     anyway, but the UI guard is friendlier).
 *   - "Edit" (secondary): always available.
 *
 * Hidden when `hidePaymentCta` is set — the page uses this flag when
 * the payment form is intentionally unavailable (e.g. while the BE
 * branch is still in-flight on FE).
 */
function DebtRowActions({
  debtId,
  debtStatus,
  hidePaymentCta,
}: DebtRowActionsProps) {
  const isPaidOff = debtStatus === "paid_off";
  return (
    <div
      className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3"
      data-testid={`debt-row-actions-${debtId}`}
    >
      {!hidePaymentCta && !isPaidOff ? (
        <Link
          href={`/debts/${encodeURIComponent(debtId)}/pay`}
          className="btn-primary !w-auto px-3 py-1.5 text-xs"
          aria-label="Catat cicilan"
          data-testid={`debt-row-pay-${debtId}`}
        >
          + Catat cicilan
        </Link>
      ) : null}
      <Link
        href={`/debts/${encodeURIComponent(debtId)}/edit`}
        className="btn-secondary !w-auto px-3 py-1.5 text-xs"
        aria-label="Edit utang"
        data-testid={`debt-row-edit-${debtId}`}
      >
        Edit
      </Link>
    </div>
  );
}

interface DebtDataPointProps {
  label: string;
  value: string | null;
  loading: boolean;
  muted?: boolean;
  testId?: string;
}

function DebtDataPoint({
  label,
  value,
  loading,
  muted = false,
  testId,
}: DebtDataPointProps) {
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
 * Re-export of the bare amount helper so tests / future call-sites
 * can format without pulling the entire client surface.
 */
export function readRupiahFromCents(cents: number): string {
  return formatDebtIdrAmountOnly(cents);
}