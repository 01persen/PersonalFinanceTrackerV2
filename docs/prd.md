# Personal Finance Tracker — PRD (v1.0)

> **Status:** APPROVED by stakeholder (kickoff issue, iteration v1.0)
> **Owner:** Tech Leader (Engineering Squad)
> **Author:** System Analyst (draft) → Tech Leader (revisi)
> **Tanggal:** 2026-07-23

## 1. Latar Belakang

User mencatat keuangan pribadi via Google Spreadsheet. Spreadsheet berfungsi
namun memiliki keterbatasan: tidak ada visualisasi otomatis, sulit dicari,
tidak ada tracker goal (networth, saving, debt, emergency fund), dan berisiko
human-error saat input manual berulang.

PRD ini mengusulkan **Personal Finance Tracker** — aplikasi personal untuk
menggantikan spreadsheet dengan UX lebih baik, fitur tracker, dan visualisasi.

## 2. Tujuan Produk

1. Memindahkan pencatatan keuangan pribadi ke aplikasi dengan input cepat di
   mobile dan dashboard lengkap di web desktop.
2. Menyediakan visualisasi (chart) income/expense bulanan dan networth.
3. Menyediakan tracker goal: networth, saving, debt, emergency fund.
4. Mendukung multi-account (cash, bank, e-wallet, dll).
5. Mempertahankan akses & portabilitas data (export on-demand).

## 3. Non-Goals (eksplisit, MVP)

- Migrasi data spreadsheet — user mulai dari awal (tanpa import).
- Sync bank / open-banking / auto-import transaksi.
- Multi-currency real-time (IDR saja untuk MVP).
- Mobile native app (lihat Section 9 untuk pendekatan teknis — kemungkinan
  PWA, bukan native).
- Multi-user / household / RBAC (single-user).
- Tax reporting / compliance lokal.
- Budgeting limit per kategori (lihat Open Questions — fitur ini bisa masuk
  MVP atau post-MVP tergantung klarifikasi).

## 4. Persona

- **Primary:** User tunggal — individu yang sudah terbiasa spreadsheet, ingin
  pencatatan lebih cepat di mobile, dan dashboard lengkap di web desktop.

## 5. Platform Target

- **Mobile** (prioritas input): UI dioptimalkan untuk menambah transaksi /
  cek saldo dengan cepat.
- **Web desktop** (prioritas viewing): dashboard lengkap, chart, dan manajemen
  akun/goal.

Pendekatan teknis: lihat Section 9 (PWA vs native — klarifikasi dibutuhkan).

## 6. User Stories

- Sebagai user, saya bisa menambah transaksi income/expense/transfer dengan
  field minimum: tanggal, tipe, nominal, akun, kategori, catatan.
- Sebagai user, saya bisa mengelola **multi-account** (cash, bank, e-wallet)
  dengan saldo pembuka.
- Sebagai user, saya bisa mencatat **catatan pendapatan dan pengeluaran
  perbulan** seperti spreadsheet (transaction core + view bulanan).
- Sebagai user, saya bisa melihat **networth** (total assets − liabilities)
  dengan trend chart.
- Sebagai user, saya bisa membuat **saving goal** dengan target nominal dan
  tanggal target, serta melihat progress.
- Sebagai user, saya bisa membuat **debt tracker** (nama, nominal awal,
  tenor, bunga, sisa saldo, cicilan).
- Sebagai user, saya bisa membuat **emergency fund goal** dengan target nominal
  dan progress tracking.
- Sebagai user, saya bisa melihat **dashboard chart**: income vs expense
  bulanan, networth trend, top kategori, progress saving/emergency fund,
  sisa debt.
- Sebagai user, saya bisa **mencari & memfilter** transaksi (tanggal, akun,
  kategori, tipe).
- Sebagai user, saya bisa **export** data ke CSV/JSON on-demand.

## 7. Fitur (Scope MVP)

### 7.1 In-Scope MVP

- **Foundation, Auth & Data Model** (P-FOUNDATION).
- **Multi-Account Management** (P-CORE).
- **Transaction Core** (P-CORE) — CRUD income/expense/transfer.
- **Categorization & Search** (P-CORE) — kategori, auto-rule, search/filter.
- **Goal Trackers — Saving & Emergency Fund** (P-CORE).
- **Debt Tracker** (P-CORE).
- **Networth, Dashboard & Visualization** (P-CORE).
- **Export, Backup & Settings** (P-ENHANCEMENT).

### 7.2 Out-of-Scope MVP

- Data migration spreadsheet (user mulai dari awal).
- Recurring transaction + reminder (lihat epic-0009 BLOCKED — menunggu
  klarifikasi).
- Budgeting limit per kategori (lihat Open Questions).
- Bank sync / open-banking.
- Mobile native app (jika pendekatan PWA disetujui).

## 8. Acceptance Criteria (MVP)

- User bisa register/login dan hanya mengakses data sendiri.
- User bisa menambah transaksi income/expense dalam ≤ 10 detik dari mobile.
- Multi-account: saldo per akun dan total saldo akurat setelah transaksi.
- Networth dihitung = sum(aset) − sum(debt outstanding) +/− transfer
  di-handle benar.
- Saving & emergency fund: progress = current / target × 100%, dengan
  update saat transaksi ke akun terkait.
- Debt tracker: sisa saldo berkurang sesuai cicilan, dengan kalkulator
  bunga sederhana (flat atau efektif, lihat klarifikasi).
- Dashboard chart render < 2 detik untuk dataset hingga 5.000 transaksi.
- Export CSV/JSON round-trip tanpa kehilangan field.
- Single-user; data model siap-extend untuk multi-user di post-MVP.

## 9. Tech Stack (LOCKED v1.2)

- **Frontend:** Next.js (React, TypeScript), Tailwind CSS, Recharts.
- **Backend:** FastAPI (Python) — SQLAlchemy + Alembic.
- **DB:** **Supabase Postgres** (free tier 500MB).
- **Auth:** **Supabase Auth** (email + password, JWT) — built-in.
- **Deployment:** Vercel (frontend) + Supabase (DB + Auth).
- **Mobile:** **PWA** (Progressive Web App — installable, offline read-only,
  single codebase).

> **Locked** dari jawaban stakeholder (OQ3 = PWA, OQ4 = ikut rekomendasi
> Supabase).

## 10. Storage & Backup

- **Cloud (managed Postgres), free tier preferred.** Rekomendasi awal:
  Supabase (free 500MB Postgres + Auth built-in), atau Neon (free 512MB).
- **Backup:** on-demand export saja. Backup terjadwal otomatis masuk post-MVP.
- **Single-user MVP.** Schema `user_id` tetap ada agar forward-compat.

## 11. Metrik Sukses (post-launch)

- User bisa input transaksi dalam ≤ 10 detik dari mobile.
- Dashboard chart render < 2 detik untuk 5.000 transaksi.
- User aktif login kembali ≥ 3x dalam minggu pertama pasca-launch.
- Semua fitur MVP digunakan (tidak ada dead feature).

## 12. Risiko & Mitigasi

| Risiko | Mitigasi |
|---|---|
| PWA terbatas di iOS (push, background) | Jika butuh push/background sync, escalate ke native di post-MVP. |
| Free tier quota habis | Monitoring quota dari hari 1; siapkan plan upgrade. |
| Visualisasi lambat di data besar | Server-side aggregation + paginasi, default range 12 bulan. |
| Perhitungan networth/debt salah | Unit test untuk kalkulator finansial; manual audit di staging. |

## 13. Open Questions — Status

| ID | Pertanyaan | Status |
|----|-----------|--------|
| OQ1 | Recurring transaction + reminder | **YA, dengan scope sempit** — hanya untuk tagihan tetap (CC, langganan). Gaji tetap manual (variabel). Reminder untuk tagihan yang akan jatuh tempo. |
| OQ2 | Budgeting limit per kategori | **DROP** — spreadsheet user tidak punya budgeting; pakai view "Rekapan Pengeluaran per Bulan" saja. |
| OQ3 | Mobile approach | **PWA** (lock dari PRD §9). |
| OQ4 | Free cloud preference | **Supabase** (lock dari PRD §9, ikut rekomendasi). |
| OQ5 | Bunga flat/effective | **FLAT** (default, dari analisis spreadsheet). |

Semua OQ terjawab. PRD v1.2 FINAL — engineering siap jalan.

## 14. Default Seed Data (dari analisis spreadsheet)

Analisis spreadsheet user (`uangplanner.com Money Planner`) menunjukkan
kategori & akun standar yang cocok dipakai sebagai **default seed** saat user
pertama-kali register. User bisa menambah/mengubah/edit setelahnya.

### Default Account Types
- `cash`, `bank`, `e_wallet`, `credit_card`, `investment`, `other`.

### Default Payment Methods (akun contoh)
- Cash, BCA, Kartu Kredit — user menambahkan akun mereka sendiri di SETUP.

### Default Income Categories
- Gaji, Gaji Pasangan, Bonus, Hadiah, Pendapatan Lain, Hutang Diterima,
  Piutang Diterima.

### Default Expense Categories (ter-group seperti spreadsheet)
- **Cicilan:** Cicilan Mobil, Cicilan Bank, Cicilan Kartu Kredit.
- **Rutinitas (tagihan bulanan):** Sewa/KPR, Listrik, Air, Internet, Zakat,
  Pendidikan, dll.
- **Tabungan & Investasi:** Saham, ReksaDana, Crypto, Cash, Usaha.
- **Belanja:** Belanja Bulanan, Belanja Mingguan, Transport, Bensin,
  Makan, Hiburan, Kebutuhan Anak, dll.

### Default Saving Goal Templates (mirip Savings Tracker spreadsheet)
- Field: `name`, `goal_amount_cents`, `target_date` (nullable),
  `start_date`, `jangka_waktu_months`, `tabungan_bulanan_cents`
  (auto-calc = goal / months), `current_amount_cents`, `linked_account_id`
  (nullable), `notes`.
- Progress = `current_amount / goal_amount × 100%`.

### Default Debt Tracker Fields (mirip Debt Tracker spreadsheet)
- `name`, `kind` (loan | credit_card | paylater | KTA | KKB | KPR | other),
  `principal_cents`, `bunga_pct` (annual), `tenor_months`, `start_date`,
  `monthly_payment_cents` (auto-calc flat), `status`.
- Cicilan (`debt_payment`): `occurred_on`, `amount_cents`,
  `principal_portion_cents`, `interest_portion_cents`, `source_account_id`,
  `note`.

### Emergency Fund Formula (mirip Emergency Fund spreadsheet)
- Inputs: `monthly_expense_cents`, `jumlah_tanggungan` (dependents count).
- `target_amount_cents = monthly_expense × dependents × multiplier`.
- Default multiplier = **3** (rule of thumb: 3 bulan × tanggungan). User
  bisa ubah.
- `lama_mengumpulkan_bulan = target_amount / tabungan_bulanan`.

### Monthly View Structure (mirip tab "January" dst.)
- Tabel **Rekapan Penghasilan**: `tanggal`, `sumber`, `nominal`, `catatan`.
- Tabel **Rekapan Pengeluaran**: `tanggal`, `detail`, `jumlah`, `kategori`,
  `metode_pembayaran`, `catatan`.
- Grouped by tanggal dengan total harian.

## 15. Riwayat Revisi

- v0.1 (2026-07-23) — Initial draft oleh System Analyst.
- v1.0 (2026-07-23) — Tech Leader revisi: scope MVP dikunci dari jawaban
  stakeholder (no migration, multi-account + 4 tracker + chart), non-goals
  dipertegas, tech stack diperbarui, open questions dirampingkan.
- v1.1 (2026-07-23) — Tech Leader: tambah Section 14 "Default Seed Data"
  berdasarkan analisis spreadsheet `uangplanner.com Money Planner`. Kategori,
  akun, field saving goal, debt tracker, emergency fund formula, dan struktur
  monthly view sekarang mengikuti template spreadsheet user (dengan sedikit
  normalisasi).
- v1.2 FINAL (2026-07-23) — Tech Leader: lock tech stack ke **PWA + Supabase +
  FastAPI**, OQ1 dijawab dengan scope sempit (recurring hanya untuk tagihan
  tetap), OQ2 di-drop, OQ5 default flat. Engineering siap dimulai.