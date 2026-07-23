# Epic 0009 — Recurring Transaction & Reminder (narrow scope)

- **ID:** epic-0009
- **Prioritas:** P-ENHANCEMENT
- **Status:** NOT_STARTED (scope sempit, lock dari jawaban stakeholder)
- **Owner:** Backend + Frontend Engineer
- **Dependency:** epic-0003 (locked; bisa mulai setelah 0003 merged)
- **Branch:** `release/epic-0009`

## Tujuan

Otomasi transaksi **tagihan tetap** (CC, langganan, cicilan dengan nominal
fixed) yang berulang, plus reminder agar user tidak lupa bayar. **Gaji tetap
manual** — user input sendiri setiap bulan karena nominalnya variabel.

## Scope

### Use case spesifik (lock)

1. **Tagihan tetap (recurring, auto-create):**
   - Tagihan kartu kredit (fixed amount per cycle).
   - Langganan (Netflix, Spotify, internet, dll).
   - Cicilan fixed (KPR, KKB flat, KTA flat).
2. **Gaji (manual, TIDAK recurring):** User input sendiri setiap bulan.
3. **Reminder in-app** untuk tagihan recurring yang akan jatuh tempo.

### Backend

- Model `recurring_rules` (cadence: daily/weekly/monthly/yearly, start_on,
  end_on nullable, next_run_on, account_id, category_id nullable,
  amount_cents, note, kind enum [bill | subscription | cicilan_fixed]).
- Worker/cron yang materialize transaksi dari rule tepat waktu (idempotent
  jika dijalankan berulang). Tidak termasuk gaji.
- Reminder schedule: notifikasi in-app untuk due dalam 3 hari, 1 hari,
  dan hari H.

### Frontend

- Halaman daftar recurring rule + form CRUD.
- Banner/dropdown reminder di dashboard.

## Sub-Issue (rencana)

1. `sub-0009-01` — Model + endpoint CRUD recurring rule.
2. `sub-0009-02` — Materializer/cron worker + idempotency.
3. `sub-0009-03` — Reminder engine + storage notifikasi.
4. `sub-0009-04` — UI daftar recurring rule.
5. `sub-0009-05` — UI reminder di dashboard.

## Acceptance Criteria

- Rule recurring (bill/subscription/cicilan_fixed) membuat transaksi secara
  otomatis pada tanggal jatuh tempo.
- Materializer aman dijalankan ulang (tidak duplikat) — pakai
  `(recurring_rule_id, period_key)` sebagai idempotency key.
- Reminder muncul H-3, H-1, H-0 untuk transaksi yang akan jatuh tempo.
- Gaji tetap input manual — sistem tidak membuat rule recurring untuk gaji.

## Out-of-Scope

- Recurring untuk gaji (nominal variabel, manual entry).
- Recurring untuk transaksi lain yang amount-nya berubah-ubah (handled manual).
- Push notification ke device (in-app only untuk MVP).
- Auto-debit / auto-payment integration.