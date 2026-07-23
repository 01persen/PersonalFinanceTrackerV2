# Epic 0002 — Multi-Account Management

- **ID:** epic-0002
- **Prioritas:** P-CORE
- **Status:** NOT_STARTED
- **Owner:** Backend + Frontend Engineer
- **Dependency:** epic-0001
- **Branch:** `release/epic-0002`

## Tujuan

User bisa mengelola banyak akun keuangan (cash, bank, e-wallet, kartu kredit,
dll) dengan saldo pembuka, dan sistem menghitung saldo berjalan otomatis
berdasarkan transaksi.

## Scope

### Backend

- Endpoint CRUD `/accounts` (POST, GET list, GET by id, PATCH, DELETE).
- Validasi: `currency` IDR untuk MVP (lihat PRD §10).
- Tipe akun menentukan `is_asset`:
  - asset: cash, bank, e_wallet, investment, other → `is_asset=true`.
  - liability: credit_card → `is_asset=false`.
- Endpoint agregasi saldo: `GET /accounts/{id}/balance` dan
  `GET /accounts/balances` (semua akun user).
- Saldo = opening_balance + sum(income ke akun) − sum(expense dari akun)
  + sum(transfer in) − sum(transfer out).

### Frontend

- Halaman daftar akun + saldo terkini.
- Form tambah/edit akun (nama, tipe, opening balance, archived).
- Empty state untuk user baru.

## Sub-Issue (rencana)

1. `sub-0002-01` — Endpoint CRUD akun.
2. `sub-0002-02` — Endpoint agregasi saldo per akun + total.
3. `sub-0002-03` — UI daftar akun + saldo.
4. `sub-0002-04` — UI form tambah/edit akun.
5. `sub-0002-05` — Test saldo engine (deterministik + edge case).

## Acceptance Criteria

- User bisa menambah akun cash, bank, e-wallet, kartu kredit.
- Saldo akun ter-update otomatis setelah transaksi.
- Total saldo = sum(saldo akun asset) − sum(saldo akun liability) sesuai
  dengan definisi networth.

## Out-of-Scope

- Sync otomatis dari bank (post-MVP).
- Multi-currency (IDR saja untuk MVP).