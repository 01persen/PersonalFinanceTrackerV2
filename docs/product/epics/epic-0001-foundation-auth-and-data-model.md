# Epic 0001 — Foundation, Auth & Data Model

- **ID:** epic-0001
- **Prioritas:** P-FOUNDATION
- **Status:** NOT_STARTED
- **Owner:** Backend Engineer (primary) + Frontend Engineer (auth UI)
- **Dependency:** —
- **Branch:** `release/epic-0001`

## Tujuan

Membangun fondasi aplikasi: schema database, sistem autentikasi, dan shell UI
agar epic berikutnya punya landasan untuk menaruh fitur (multi-account,
tracker, dashboard).

## Scope

### Backend

- Setup project + dependency manager (FastAPI + SQLAlchemy, atau
  Express + Prisma — keputusan final setelah diskusi tim & klarifikasi OQ3/OQ4).
- Schema Postgres (lihat Sub-Section "Schema"):
  - `users` (id, email, password_hash, created_at, updated_at).
  - `accounts` (id, user_id FK, name, type enum
    [cash, bank, e_wallet, investment, credit_card, other], currency,
    opening_balance_cents, is_asset bool, archived, created_at, updated_at).
  - `categories` (id, user_id FK, name, kind enum [income, expense],
    parent_id nullable, color, archived).
  - `transactions` (id, user_id FK, account_id FK, category_id FK nullable,
    type enum [income, expense, transfer], amount_cents bigint, currency,
    occurred_on date, note, transfer_pair_id nullable, recurring_rule_id
    nullable, created_at, updated_at).
  - `category_rules` (id, user_id FK, pattern, category_id FK, priority).
  - `goals` (id, user_id FK, kind enum [saving, emergency_fund],
    name, target_amount_cents, target_date nullable, account_id FK nullable,
    current_amount_cents, created_at, updated_at).
  - `debts` (id, user_id FK, name, kind enum [loan, credit_card, mortgage,
    other], principal_cents, interest_rate numeric, tenor_months int nullable,
    start_date, note, status enum [active, paid_off], created_at,
    updated_at).
  - `debt_payments` (id, debt_id FK, occurred_on date, amount_cents,
    principal_portion_cents, interest_portion_cents, note, created_at).
- Migrasi schema + seed kosong per user baru.
- Endpoint auth: register, login, logout, refresh token, "me".

### Frontend

- Halaman login & register.
- Auth guard untuk route private.
- Shell layout (sidebar + header) placeholder.
- Setup PWA manifest + service worker (jika OQ3 = PWA).

## Sub-Issue (rencana)

1. `sub-0001-01` — Init backend project + struktur folder + tooling.
2. `sub-0001-02` — Schema + migration + seed kosong (semua tabel di atas).
3. `sub-0001-03` — Endpoint auth (register/login/logout/me).
4. `sub-0001-04` — Init frontend + auth UI + guard.
5. `sub-0001-05` — Shell layout + navigasi dasar.
6. `sub-0001-06` — PWA setup (manifest + service worker) — sub-issue ini
   bisa di-defer jika OQ3 jawabannya bukan PWA.
7. `sub-0001-07` — CI/CD skeleton + lint + typecheck + test runner.
8. `sub-0001-08` — **Default seed data** — saat user baru register, seed
   default categories (income + expense group), default account types,
   dan preference awal (locale id-ID, currency IDR, multiplier EF=3).
   Daftar lengkap lihat PRD §14.

## Acceptance Criteria

- User bisa register, login, logout, dan melihat endpoint `/me` mengembalikan
  profil sendiri.
- Schema migration reversible dan dapat dijalankan ulang tanpa kehilangan data.
- Semua tabel di sub-section Schema sudah ter-create dengan index yang sesuai
  (`user_id`, `occurred_on`, dll).
- CI lulus untuk PR kosong (lint + typecheck pass).
- Test minimal untuk auth (happy path + invalid credentials).

## Out-of-Scope

- Fitur bisnis apapun (transaksi, akun, tracker, dll). Itu masuk epic 0002+.
- Multi-user RBAC — schema sudah siap tapi tidak diaktifkan.
- Audit log / soft-delete untuk MVP (added di post-MVP jika dibutuhkan).