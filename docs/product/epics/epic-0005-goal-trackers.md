# Epic 0005 — Goal Trackers (Saving & Emergency Fund)

- **ID:** epic-0005
- **Prioritas:** P-CORE
- **Status:** NOT_STARTED
- **Owner:** Backend + Frontend Engineer
- **Dependency:** epic-0002, epic-0003
- **Branch:** `release/epic-0005`

## Tujuan

User bisa membuat goal Saving dan Emergency Fund dengan target nominal (dan
opsional tanggal target), lalu melihat progress secara real-time.

## Scope

### Backend

- CRUD `goals` (kind: saving | emergency_fund).
- Field saving goal: name, goal_amount_cents, target_date nullable,
  start_date, jangka_waktu_months int, tabungan_bulanan_cents (auto-calc),
  current_amount_cents, linked_account_id nullable, notes.
- Field emergency fund goal: monthly_expense_cents (snapshot), jumlah_tanggungan,
  multiplier (default 3), target_amount_cents (auto-calc), tabungan_bulanan_cents,
  current_amount_cents, lama_mengumpulkan_bulan (auto-calc).
- Endpoint progress: `GET /goals/{id}/progress` =
  current_amount_cents / target_amount_cents × 100.
- Opsi: link goal ke akun — current_amount dihitung otomatis dari saldo akun
  (computed, bukan stored, untuk akurasi).
- Auto-update current_amount saat ada transaksi baru ke akun terkait.
- Konfigurasi multiplier EF per-user (default 3, dari PRD §14).

## Sub-Issue (rencana)

1. `sub-0005-01` — Endpoint CRUD goal.
2. `sub-0005-02` — Engine progress (compute dari saldo akun linked).
3. `sub-0005-03` — UI daftar goal + progress bar.
4. `sub-0005-04` — UI form buat/edit goal.
5. `sub-0005-05` — Banner notifikasi progress.

## Acceptance Criteria

- User bisa membuat saving goal dengan target, current amount ter-update
  sesuai saldo akun linked.
- Emergency fund goal berfungsi sama dengan saving goal (kind berbeda).
- Progress bar akurat (verified via test: transaksi income ke akun linked →
  progress naik).
- Target tercapai menampilkan state "achieved" + tanggal.

## Out-of-Scope

- Debt tracker (epic-0006) — model terpisah.
- Auto-allocation / sweep antar akun.