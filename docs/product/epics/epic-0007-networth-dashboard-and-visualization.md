# Epic 0007 — Networth, Dashboard & Visualization

- **ID:** epic-0007
- **Prioritas:** P-CORE
- **Status:** NOT_STARTED
- **Owner:** Frontend Engineer (primary) + Backend (aggregate)
- **Dependency:** epic-0003, epic-0005, epic-0006
- **Branch:** `release/epic-0007`

## Tujuan

Menyajikan ringkasan keuangan dan visualisasi untuk mendukung keputusan user.
Networth = total assets − total liabilities (auto-computed).

## Scope

### Backend

- Endpoint aggregasi:
  - `GET /dashboard/summary` — total saldo akun asset, total saldo akun
    liability, networth, income/expense bulan ini.
  - `GET /dashboard/networth-trend` — networth per bulan selama N bulan
    terakhir.
  - `GET /dashboard/income-expense-trend` — income vs expense per bulan
    selama 12 bulan terakhir.
  - `GET /dashboard/top-categories` — top N kategori expense bulan ini.
  - `GET /dashboard/goals-progress` — progress semua goal.
  - `GET /dashboard/debts-summary` — total sisa utang + total bunga paid.
- Cache 60 detik di server.

### Frontend

- Dashboard utama (web desktop prioritized):
  - KPI cards: Networth, Income bulan ini, Expense bulan ini, Emergency Fund
    progress.
  - Chart line networth trend (12 bulan).
  - Chart bar income vs expense per bulan (12 bulan).
  - Chart donut top 5 kategori expense bulan ini.
  - Progress bar untuk setiap saving/emergency fund goal.
  - Card ringkasan utang (sisa saldo + total bunga).
- Empty state untuk user baru.
- Mobile: versi ringkas dengan KPI + 1 chart utama.

## Sub-Issue (rencana)

1. `sub-0007-01` — Backend aggregation endpoints (cached).
2. `sub-0007-02` — Dashboard layout (web desktop) + KPI cards.
3. `sub-0007-03` — Chart line networth trend.
4. `sub-0007-04` — Chart bar income vs expense.
5. `sub-0007-05` — Chart donut top kategori.
6. `sub-0007-06` — Widget goal progress + debt summary.
7. `sub-0007-07` — Mobile ringkas view.
8. `sub-0007-08` — Empty state & loading state.

## Acceptance Criteria

- Dashboard render < 2 detik untuk dataset 5.000 transaksi.
- Tidak ada N+1 query (aggregate di server).
- Networth = sum(asset saldo) − sum(liability saldo) +/− transfer pending.
- Chart responsive di mobile breakpoint (mobile melihat ringkasan, web
  melihat full dashboard — sesuai PRD §5).

## Out-of-Scope

- Export laporan ke PDF.
- Forecasting / prediksi networth.
- Real-time update (cukup polling / on-mount).