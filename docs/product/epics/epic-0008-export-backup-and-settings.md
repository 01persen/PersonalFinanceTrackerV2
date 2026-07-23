# Epic 0008 — Export, Backup & Settings

- **ID:** epic-0008
- **Prioritas:** P-ENHANCEMENT
- **Status:** NOT_STARTED
- **Owner:** Backend + Frontend Engineer
- **Dependency:** epic-0001
- **Branch:** `release/epic-0008`

## Tujuan

Memberikan user kontrol atas data miliknya (export, backup) dan pengaturan
akun/preferensi.

## Scope

### Backend

- Endpoint export:
  - `GET /export/transactions.csv` — semua transaksi user.
  - `GET /export/transactions.json` — semua transaksi + akun + kategori +
    goals + debts (full snapshot).
- Endpoint backup: `GET /export/backup.zip` — JSON snapshot dalam zip.
- Endpoint settings: `GET/PATCH /settings` — profil, preferensi (default
  currency IDR, locale id-ID, awal minggu Senin).

### Frontend

- Halaman settings (profil + preferensi).
- Tombol "Export CSV" / "Export JSON" / "Download Backup".

## Sub-Issue (rencana)

1. `sub-0008-01` — Endpoint export CSV.
2. `sub-0008-02` — Endpoint export JSON + backup zip.
3. `sub-0008-03` — Endpoint settings (GET/PATCH).
4. `sub-0008-04` — UI settings.
5. `sub-0008-05` — UI export + backup.

## Acceptance Criteria

- Export CSV menghasilkan file yang dapat dibuka di spreadsheet tanpa
  kehilangan field penting.
- Backup zip dapat di-restore ulang ke environment lokal tanpa kehilangan
  data.
- Settings tersimpan dan ter-apply pada session berikutnya.

## Out-of-Scope

- Backup terjadwal otomatis (on-demand cukup untuk MVP).
- Sync ke cloud storage eksternal.
- Restore wizard dari file backup (cukup dokumentasi manual untuk MVP).