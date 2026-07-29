"use client";

import {
  amountMeta,
  badgeStyle,
  formatDateLongId,
  formatIdrFromCents,
  type MonthlyTransactionGroup,
} from "@/components/transactions/bulanan/monthly-grouping";

interface MonthlyTransactionsTableProps {
  groups: MonthlyTransactionGroup[];
}

/**
 * Spreadsheet-like grouped table for the monthly view. One row per
 * transaction — columns are Tipe, Nominal, Kategori, Catatan. The
 * Tanggal column is rendered as a group header that spans the full
 * row, mirroring the structure called out in the epic acceptance
 * criteria ("transaksi ter-group by tanggal").
 *
 * Hidden on small screens (`hidden md:block`) — the card view
 * (`MonthlyTransactionsCards`) takes over below the `md` breakpoint.
 */
export function MonthlyTransactionsTable({ groups }: MonthlyTransactionsTableProps) {
  if (groups.length === 0) return null;

  return (
    <section
      className="card hidden overflow-hidden p-0 md:block"
      aria-label="Tabel transaksi bulanan"
    >
      <table className="w-full table-fixed border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold uppercase tracking-[0.08em] text-slate-600">
            <th scope="col" className="w-28 px-4 py-3">
              Tanggal
            </th>
            <th scope="col" className="w-32 px-4 py-3">
              Tipe
            </th>
            <th scope="col" className="w-44 px-4 py-3 text-right">
              Nominal
            </th>
            <th scope="col" className="px-4 py-3">
              Kategori
            </th>
            <th scope="col" className="px-4 py-3">
              Catatan
            </th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <GroupRows key={group.date} group={group} />
          ))}
        </tbody>
      </table>
    </section>
  );
}

function GroupRows({ group }: { group: MonthlyTransactionGroup }) {
  return (
    <>
      <tr className="border-t border-slate-200 bg-slate-50/60">
        <th
          scope="rowgroup"
          colSpan={5}
          className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-[0.08em] text-slate-600"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{formatDateLongId(group.date)}</span>
            <span className="font-normal normal-case text-slate-500">
              {group.rows.length} transaksi
              {group.incomeCents > 0 && group.expenseCents > 0 ? (
                <>
                  {" · "}
                  <span className="text-emerald-700">
                    + {formatIdrFromCents(group.incomeCents)}
                  </span>
                  {" / "}
                  <span className="text-rose-700">
                    − {formatIdrFromCents(group.expenseCents)}
                  </span>
                </>
              ) : group.incomeCents > 0 ? (
                <>
                  {" · "}
                  <span className="text-emerald-700">
                    + {formatIdrFromCents(group.incomeCents)}
                  </span>
                </>
              ) : group.expenseCents > 0 ? (
                <>
                  {" · "}
                  <span className="text-rose-700">
                    − {formatIdrFromCents(group.expenseCents)}
                  </span>
                </>
              ) : null}
            </span>
          </div>
        </th>
      </tr>
      {group.rows.map(({ row, accountName, categoryName }) => {
        const badge = badgeStyle(row.type);
        const meta = amountMeta(row.type);
        return (
          <tr
            key={row.id}
            className="border-t border-slate-100 hover:bg-slate-50/60"
          >
            <td className="whitespace-nowrap px-4 py-3 align-top text-xs font-medium text-slate-500 tabular-nums">
              {row.occurredOn.slice(8, 10)}
              <span className="block text-[0.625rem] uppercase tracking-wide text-slate-400">
                {row.occurredOn.slice(5, 7)}/{row.occurredOn.slice(0, 4)}
              </span>
            </td>
            <td className="px-4 py-3 align-top">
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${badge.container}`}
              >
                {badge.label}
              </span>
            </td>
            <td
              className={`px-4 py-3 text-right align-top text-sm font-semibold tabular-nums ${meta.color}`}
              aria-label={`Nominal ${row.type} ${formatIdrFromCents(row.amountCents)}`}
            >
              {meta.prefix} {formatIdrFromCents(row.amountCents)}
            </td>
            <td className="px-4 py-3 align-top">
              <p className="text-sm font-semibold text-slate-900">{categoryName}</p>
              <p className="mt-0.5 text-xs text-slate-500">{accountName}</p>
            </td>
            <td className="px-4 py-3 align-top text-sm text-slate-600">
              {row.note ? row.note : <span className="text-slate-400">—</span>}
            </td>
          </tr>
        );
      })}
    </>
  );
}
