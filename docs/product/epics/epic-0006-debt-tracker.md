# Epic 0006 — Debt Tracker

- **ID:** epic-0006
- **Prioritas:** P-CORE
- **Status:** NOT_STARTED
- **Owner:** Backend + Frontend Engineer
- **Dependency:** epic-0002
- **Branch:** `release/epic-0006`

## Tujuan

User bisa mencatat utang (loan, kartu kredit, KPR, dll), tenor, bunga, dan
mencatat cicilan. Sisa saldo dan total bunga terkalkulasi otomatis.

## Scope

### Backend

- CRUD `debts` (kind: loan | credit_card | paylater | KTA | KKB | KPR | other).
- Field: name, kind, principal_cents, bunga_pct (annual, decimal),
  tenor_months int nullable, start_date, monthly_payment_cents
  (auto-calc flat: (principal + total_interest) / tenor_months), note,
  status (active | paid_off).
- CRUD `debt_payments` (occurred_on, amount_cents, principal_portion_cents,
  interest_portion_cents, source_account_id FK nullable, note).
- Endpoint agregasi: `GET /debts/{id}/summary` =
  remaining_principal_cents, total_interest_paid_cents,
  next_payment_due_date (jika ada schedule), months_remaining.
- Kalkulator bunga: **flat** (default, sederhana — sesuai spreadsheet
  `uangplanner.com`). Jika OQ5 jawabannya effective/compound, escalate
  model di post-MVP.
- Auto-update `status = paid_off` saat remaining_principal = 0.

### Frontend

- Halaman daftar utang + ringkasan total (sisa saldo, total bunga, monthly
  payment).
- Form tambah/edit utang.
- Form tambah cicilan.
- Tabel history cicilan per utang.

## Sub-Issue (rencana)

1. `sub-0006-01` — Endpoint CRUD debt.
2. `sub-0006-02` — Endpoint CRUD debt_payments + auto-update status.
3. `sub-0006-03` — Kalkulator bunga flat + summary endpoint.
4. `sub-0006-04` — UI daftar utang + ringkasan.
5. `sub-0006-05` — UI form utang + form cicilan.
6. `sub-0006-06` — UI history cicilan.

## Acceptance Criteria

- User bisa menambah utang dengan principal, bunga, tenor; monthly payment
  terhitung (flat).
- Setiap cicilan mengurangi remaining_principal dan menambah total_interest.
- Status otomatis berubah ke `paid_off` saat lunas.
- Summary akurat untuk sample case: 12jt @10% flat / 12 bulan → cicilan
  ~1.1jt/bln, total bunga ~1.2jt.

## Out-of-Scope

- Effective/compound interest (lihat PRD §13 OQ5 — default flat untuk MVP).
- Auto-debit / auto-payment integration.
- Credit score tracking.