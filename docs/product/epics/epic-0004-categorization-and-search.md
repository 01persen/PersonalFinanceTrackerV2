# Epic 0004 — Categorization & Search

- **ID:** epic-0004
- **Prioritas:** P-CORE
- **Status:** NOT_STARTED
- **Owner:** Backend + Frontend Engineer
- **Dependency:** epic-0003
- **Branch:** `release/epic-0004`

## Tujuan

Memberikan kontrol kategori (termasuk auto-categorize rule) dan pencarian
lanjut untuk transaksi.

## Scope

### Backend

- CRUD kategori + archive.
- Auto-categorize rule (regex/substring) dengan priority dan backfill opsional.
- Search endpoint: full-text note + filter kombinasi (tanggal, tipe, akun,
  kategori, nominal min/max).

### Frontend

- Halaman manajemen kategori (CRUD + parent/child).
- Search bar global dengan filter panel.

## Sub-Issue (rencana)

1. `sub-0004-01` — CRUD kategori backend.
2. `sub-0004-02` — Category rule engine + backfill opsional.
3. `sub-0004-03` — Search endpoint dengan filter kombinasi.
4. `sub-0004-04` — UI manajemen kategori.
5. `sub-0004-05` — UI search global dengan filter panel.

## Acceptance Criteria

- Rule kategori otomatis menerapkan kecocokan saat transaksi dibuat/diimpor.
- Pencarian note mengembalikan hasil yang sesuai dengan substring/regex rule.
- Filter kombinasi (tanggal + akun + kategori) mengembalikan hasil yang
  konsisten.
- Search mengembalikan hasil dalam < 500 ms untuk 5.000 transaksi.

## Out-of-Scope

- Visualisasi chart (epic-0007).
- Budgeting limit per kategori (lihat PRD §13 OQ2 — bisa masuk MVP atau
  post-MVP).
- Recurring (epic-0009 BLOCKED).