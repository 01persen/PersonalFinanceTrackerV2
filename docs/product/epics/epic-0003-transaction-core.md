# Epic 0003 — Transaction Core

- **ID:** epic-0003
- **Prioritas:** P-CORE
- **Status:** NOT_STARTED
- **Owner:** Backend + Frontend Engineer
- **Dependency:** epic-0001, epic-0002
- **Branch:** `release/epic-0003`

## Tujuan

CRUD transaksi income/expense/transfer dengan validasi, list/filter dasar,
serta view "catatan pendapatan dan pengeluaran perbulan" seperti spreadsheet.

## Scope

### Backend

- Endpoint CRUD `/transactions` (POST, GET list, GET by id, PATCH, DELETE).
- Validasi: amount > 0, occurred_on valid, account milik user, currency IDR.
- Filter list: rentang tanggal, akun, tipe, kategori, limit/offset.
- Transfer: dua transaksi terkait via `transfer_pair_id`, atomik.
- Endpoint aggregasi bulanan: `GET /transactions/summary?year=&month=` —
  total income, total expense, per kategori, per akun.
- Soft-delete (`deleted_at` nullable) untuk audit ringan.

### Frontend

- Form tambah/edit transaksi (mobile-optimized: field besar, picker cepat).
- List transaksi dengan filter ringkas (tanggal, akun, kategori).
- View "Pendapatan & Pengeluaran Bulanan" — tabel/daftar seperti
  spreadsheet (kolom Tanggal, Tipe, Nominal, Kategori, Catatan).
- Empty state & loading skeleton.

## Sub-Issue (rencana)

1. `sub-0003-01` — Endpoint POST/GET list transaksi + validasi.
2. `sub-0003-02` — Endpoint PATCH/DELETE (soft) transaksi.
3. `sub-0003-03` — Endpoint transfer (paired create).
4. `sub-0003-04` — Endpoint aggregasi bulanan (summary).
5. `sub-0003-05` — UI form transaksi (mobile-first).
6. `sub-0003-06` — UI list + filter dasar.
7. `sub-0003-07` — UI "Pendapatan & Pengeluaran Bulanan".
8. `sub-0003-08` — Test integrasi + e2e ringan.

## Acceptance Criteria

- User bisa menambah transaksi income dan expense dari mobile dalam ≤ 10 detik.
- Transfer membuat dua entri terkait dan saldo dua akun bergerak sesuai.
- View bulanan menampilkan transaksi ter-group by tanggal dengan total income,
  total expense, dan net bulanan.
- Filter rentang tanggal dan akun mengembalikan hasil yang konsisten dengan DB.

## Out-of-Scope

- Auto-categorize (epic-0004).
- Recurring (epic-0009 BLOCKED).
- Goal tracker link (epic-0005).