/**
 * Indonesian Rupiah formatter helpers for the goals list page
 * (sub-0005-03). Mirror `formatIdrFromCents` from `account-client.ts`
 * but live in the goals module so the page doesn't need to import the
 * account surface (the FE is intentionally explicit about its
 * dependencies — no codegen per SOP).
 *
 * Output convention (IDR locale, sub-0003-05 baseline):
 *
 *   - `Rp 25.000.000` — dot as thousands separator, no decimal
 *     because sub-rupiah coins aren't in circulation.
 *   - Whole rupiah only — cents are rounded to the nearest integer.
 */

const IDR_FORMATTER = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

const IDR_COMPACT_FORMATTER = new Intl.NumberFormat("id-ID", {
  maximumFractionDigits: 0,
});

export function centsToRupiah(cents: number): number {
  return Math.round(cents / 100);
}

/**
 * Format a cents amount as Indonesian Rupiah without decimals. Negative
 * amounts prefix with `-` (e.g. `-Rp 100.000`). The goals list page
 * never surfaces a negative balance, but the helper stays symmetric so
 * the same formatter can be reused for account-style rows.
 */
export function formatGoalIdrFromCents(cents: number): string {
  return IDR_FORMATTER.format(centsToRupiah(cents));
}

/**
 * Format just the integer portion (no `Rp` prefix). Used inside the
 * compound label `Rp X / Rp Y` on a goal card so the prefix doesn't
 * repeat on every number.
 */
export function formatGoalIdrAmountOnly(cents: number): string {
  return IDR_COMPACT_FORMATTER.format(centsToRupiah(cents));
}