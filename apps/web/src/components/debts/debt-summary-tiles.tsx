"use client";

import { formatDebtIdrAmountOnly, formatDebtIdrFromCents } from "@/lib/api/debt-client";

interface DebtSummaryTilesProps {
  totalRemainingCents: number;
  totalPrincipalCents: number;
  totalInterestPaidCents: number;
  totalMonthlyPaymentCents: number;
  activeCount: number;
  paidOffCount: number;
  tenorlessCount: number;
  /**
   * `true` while the per-row `/summary` fetches are still in flight.
   * When true the tile values render as skeletons instead of "Rp 0"
   * so the user sees the in-progress state during the first paint
   * after a filter change.
   */
  isLoadingSummaries: boolean;
}

interface TileSpec {
  label: string;
  hint: string;
  testId: string;
}

const REMAINING_TILE: TileSpec = {
  label: "Sisa saldo",
  hint: "Total pokok yang belum dibayar (utang aktif).",
  testId: "debt-tile-remaining",
};

const PRINCIPAL_TILE: TileSpec = {
  label: "Total pokok",
  hint: "Akumulasi pokok dari semua utang yang pernah dicatat.",
  testId: "debt-tile-principal",
};

const INTEREST_TILE: TileSpec = {
  label: "Bunga terbayar",
  hint: "Akumulasi porsi bunga dari setiap cicilan yang tercatat.",
  testId: "debt-tile-interest",
};

const MONTHLY_TILE: TileSpec = {
  label: "Cicilan / bulan",
  hint: "Total cicilan flat bulanan dari utang aktif berjadwal.",
  testId: "debt-tile-monthly",
};

/**
 * The four ringkasan tiles for the debt list page (sub-0006-04).
 * Mirrors the goals "ringkasan" pattern from sub-0005-03 + the
 * dashboard snapshot tile family from sub-0002-02 / sub-0004-04:
 *
 *   - Whole-rupiah format (no decimals — IDR has no sub-rupiah coins).
 *   - Skeleton blocks for the in-flight summary fetches so the user
 *     doesn't see "Rp 0" flash during the first paint.
 *   - aria-label + data-testid so QA can assert each tile in
 *     isolation (the spec calls out currency / zero / large values).
 *
 * The tenorless-count hint renders under the cicilan tile so a debt
 * without a schedule (`tenor_months is null`) doesn't silently lower
 * the user's expectation of the monthly total.
 */
export function DebtSummaryTiles({
  totalRemainingCents,
  totalPrincipalCents,
  totalInterestPaidCents,
  totalMonthlyPaymentCents,
  activeCount,
  paidOffCount,
  tenorlessCount,
  isLoadingSummaries,
}: DebtSummaryTilesProps) {
  return (
    <section
      aria-label="Ringkasan utang"
      data-testid="debts-summary-tiles"
      className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4"
    >
      <SummaryTile
        spec={REMAINING_TILE}
        cents={totalRemainingCents}
        isLoading={isLoadingSummaries}
      />
      <SummaryTile
        spec={PRINCIPAL_TILE}
        cents={totalPrincipalCents}
        isLoading={false}
      />
      <SummaryTile
        spec={INTEREST_TILE}
        cents={totalInterestPaidCents}
        isLoading={isLoadingSummaries}
      />
      <SummaryTile
        spec={MONTHLY_TILE}
        cents={totalMonthlyPaymentCents}
        isLoading={false}
        footer={
          tenorlessCount > 0 ? (
            <p className="mt-1 text-[0.6875rem] text-slate-500">
              {tenorlessCount} utang aktif tanpa jadwal tetap tidak
              ikut dijumlahkan ke cicilan.
            </p>
          ) : null
        }
      />
      <p className="sr-only">
        Ringkasan utang: {activeCount} aktif, {paidOffCount} lunas.
      </p>
    </section>
  );
}

interface SummaryTileProps {
  spec: TileSpec;
  cents: number;
  isLoading: boolean;
  footer?: React.ReactNode;
}

function SummaryTile({ spec, cents, isLoading, footer }: SummaryTileProps) {
  return (
    <article
      className="card flex flex-col gap-1"
      aria-label={spec.label}
      data-testid={spec.testId}
    >
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
        {spec.label}
      </p>
      {isLoading ? (
        <div
          className="h-7 w-32 animate-pulse rounded bg-slate-200"
          data-testid={`${spec.testId}-skeleton`}
        />
      ) : (
        <p className="text-2xl font-bold tabular-nums text-slate-900">
          {formatDebtIdrFromCents(cents)}
        </p>
      )}
      <p className="text-xs leading-5 text-slate-500">{spec.hint}</p>
      {footer}
    </article>
  );
}

/**
 * Stand-alone helper for tests + the per-row ringkasan (sub-0006-06
 * will reuse this for the detail page). Reads as ``Rp X`` without
 * the currency code prefix so the row label can keep the prefix once.
 */
export function readAmountOnly(cents: number): string {
  return formatDebtIdrAmountOnly(cents);
}