/**
 * Indonesian Rupiah formatter helpers for the dashboard module
 * (sub-0007-02).
 *
 * The dashboard KPI cards reuse `formatIdrFromCents` from
 * `apps/web/src/lib/api/account-client.ts` so the format stays consistent
 * across surfaces (networth, income, expense). This module adds:
 *
 * - `formatIdrCompact` — for chart axis labels (sub-0007-03/04/05):
 *   drops the `Rp` prefix, normalizes to the id-ID locale's no-decimal
 *   integer form (`25.000.000`). Avoids crowding the axis with currency
 *   labels while keeping the dot-grouping convention.
 *
 * - `formatIdrShortAxis` — for very large magnitudes where the chart
 *   column is narrow: short-form (`Rp 25 jt`, `Rp 1,2 M`). Uses the
 *   `notation: "compact"` formatter. Negative amounts prefix with `-`.
 *
 * Locale + currency are locked: the MVP is single-currency (IDR) and
 * whole-rupiah only (no sub-rupiah coins). The BE stores amounts as
 * integer `*_cents` so we always round down at display time.
 *
 * Note: `formatIdrFromCents` is re-exported so the KPI cards don't
 * reach across to `account-client.ts`. Re-exporting (not duplicating)
 * keeps the source-of-truth for the rounded currency string in one
 * place — the formatter would otherwise drift across modules.
 */

export {
  formatIdrFromCents,
  formatIdrFromCentsSigned,
} from "@/lib/api/account-client";

const IDR_INTEGER_FORMATTER = new Intl.NumberFormat("id-ID", {
  maximumFractionDigits: 0,
});

const IDR_COMPACT_FORMATTER = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  notation: "compact",
  maximumFractionDigits: 1,
});

/**
 * Convert backend cents (1/100 rupiah, integer) to whole-rupiah.
 * Same convention as `account-client.ts::centsToRupiah` — kept private
 * here so the public surface of the dashboard formatter stays narrow.
 */
function centsToRupiah(cents: number): number {
  return Math.round(cents / 100);
}

/**
 * Format a cents amount as Indonesian Rupiah without decimals or the
 * `Rp` prefix — chart axis labels. Dot-grouped (id-ID locale) so
 * `formatIdrCompact(2_500_000_000)` returns `"25.000.000"`. Negative
 * amounts prefix with `-` (mirrors the BE convention for networth
 * values that can be liabilities-dominant).
 */
export function formatIdrCompact(cents: number): string {
  return IDR_INTEGER_FORMATTER.format(centsToRupiah(cents));
}

/**
 * Compact IDR for narrow chart columns. Uses `Intl.NumberFormat`'s
 * compact notation so the rendered label fits when the column is
 * tight: 2.500.000.000 → `Rp 25 jt`, 1.200.000.000 → `Rp 1,2 M`.
 *
 * Falls back to the full IDR formatter when the magnitude is small
 * enough that the compact form would lose meaning (under `Rp 10.000`).
 */
export function formatIdrShortAxis(cents: number): string {
  const rupiah = centsToRupiah(cents);
  if (Math.abs(rupiah) < 10_000) {
    return new Intl.NumberFormat("id-ID", {
      style: "currency",
      currency: "IDR",
      maximumFractionDigits: 0,
    }).format(rupiah);
  }
  return IDR_COMPACT_FORMATTER.format(rupiah);
}
