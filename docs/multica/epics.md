# Project Tracker — Personal Finance Tracker

> **Status:** v1.6 — epic-0001 **DONE** (8/8); epic-0002 **DONE** (7/7 sub-task
> + Stage 5 release fixup complete; [PR #18](https://github.com/01persen/PersonalFinanceTrackerV2/pull/18)
> merged ke `main` pada 2026-07-27 13:06 UTC, CI hijau `api quality` + `web quality`).
> epic-0003 + epic-0008 siap dipromosikan paralel.
> **Owner:** Tech Leader (Engineering Squad)

Tracker mengikuti urutan dependency graph (bukan urgency bisnis), sesuai SOP.
Epic `BLOCKED` menunggu klarifikasi stakeholder atau dependency lain.

## Daftar Epic

| ID | Judul | Prioritas | Status | Dependency | Owner Area |
|----|-------|-----------|--------|-----------|-----------|
| epic-0001 | Foundation, Auth & Data Model | P-FOUNDATION | **DONE** | — | Backend |
| epic-0002 | Multi-Account Management | P-CORE | **DONE** | 0001 | Backend + Frontend |
| epic-0003 | Transaction Core | P-CORE | NOT_STARTED | 0001, 0002 | Backend + Frontend |
| epic-0004 | Categorization & Search | P-CORE | NOT_STARTED | 0003 | Backend + Frontend |
| epic-0005 | Goal Trackers (Saving & Emergency Fund) | P-CORE | NOT_STARTED | 0002, 0003 | Backend + Frontend |
| epic-0006 | Debt Tracker | P-CORE | NOT_STARTED | 0002 | Backend + Frontend |
| epic-0007 | Networth, Dashboard & Visualization | P-CORE | NOT_STARTED | 0003, 0005, 0006 | Frontend + Backend |
| epic-0008 | Export, Backup & Settings | P-ENHANCEMENT | NOT_STARTED | 0001 | Backend + Frontend |
| epic-0009 | Recurring Transaction & Reminder (narrow) | P-ENHANCEMENT | NOT_STARTED | 0003 | Backend + Frontend |

## Dependency Graph

```
0001 Foundation  ✅ DONE
├── 0002 Multi-Account
│   ├── 0003 Transaction Core
│   │   ├── 0004 Categorization & Search
│   │   ├── 0005 Goal Trackers
│   │   ├── 0006 Debt Tracker
│   │   └── 0009 Recurring (BLOCKED — kondisional)
│   └── 0008 Export, Backup & Settings
└── 0007 Networth, Dashboard & Visualization  [butuh 0003 + 0005 + 0006]
```

## Stage Plan (saat eksekusi dimulai)

- **Stage 1:** epic-0001 (Foundation) — **DONE**
- **Stage 2:** epic-0002 + epic-0008 (paralel — keduanya butuh 0001) — ready
  to start
- **Stage 3:** epic-0003
- **Stage 4 (paralel):** epic-0004 + epic-0005 + epic-0006
- **Stage 5:** epic-0007
- **Stage 6:** epic-0009 — recurring tagihan tetap + reminder

## Status Legend

- `NOT_STARTED` — siap dieksekusi setelah dependency DONE.
- `IN_PROGRESS` — sudah ada parent issue dengan engineer assigned.
- `BLOCKED` — menunggu klarifikasi stakeholder atau dependency lain.
- `DONE` — semua sub-issue selesai dan PR sudah merged.

## Catatan

- epic **0002** sekarang **DONE** (7/7 sub-task merged). Sub-task list:
  - ✅ sub-0002-01 — Backend CRUD `/accounts` (PR #11 merged).
  - ✅ sub-0002-02 — Backend agregasi saldo (PR #12 merged).
  - ✅ sub-0002-03 — Frontend daftar akun + saldo (PR #13 merged; #14 closed obsolete).
  - ✅ sub-0002-04 — Frontend form tambah/edit akun (PR #15 merged; backend fix PR #16).
  - ✅ sub-0002-05 — QA saldo engine test suite (PR #17 merged, 34 tests, 100% coverage).
  - ✅ sub-0002-06 — Release fix: rebase `release/epic-0002` → `origin/main`,
    resolve 6 conflict file + fix 17 API lint error (RUF002/RUF003/I001).
  - ✅ sub-0002-07 — CI fix: bump Node 22.11.0 → 22.13.0 (PR #19) + npm
    registry override (PR #20) + regenerate `package-lock.json` (PR #21).
  - [PR #18](https://github.com/01persen/PersonalFinanceTrackerV2/pull/18)
    `release/epic-0002 → main` **MERGED** (commit `6428c30`) dengan CI
    `api quality` + `web quality` hijau. Epic-0002 fully shipped.
- epic **0001** sekarang **DONE** (8/8 sub-task merged). Sub-task list:
  - ✅ sub-0001-01 — Init backend project (PR #1 merged).
  - ✅ sub-0001-02 — Schema + migration + seed kosong (PR #2 merged).
  - ✅ sub-0001-03 — Endpoint auth (PR #3 merged).
  - ✅ sub-0001-04 — Init frontend + auth UI (PR #5 merged).
  - ✅ sub-0001-05 — Shell layout (PR #6 merged).
  - ✅ sub-0001-06 — PWA setup (PR #7 merged).
  - ✅ sub-0001-07 — CI/CD skeleton (PR #8 merged via Option B: local pre-commit +
    label gate auto-merge, tanpa branch protection required status checks).
  - ✅ sub-0001-08 — Default seed data (PR #9 merged; seed ke trigger register).
- epic **0009** NOT_STARTED dengan scope sempit: recurring untuk tagihan tetap
  (CC, langganan, cicilan fixed amount) + reminder. Gaji tetap manual (input
  sendiri setiap bulan, amount variabel).
- epic **0007** (dashboard) sengaja di stage terakhir karena butuh data dari
  0003 (transaction), 0005 (goal tracker), dan 0006 (debt tracker).
- epic **0008** (export & settings) bisa paralel dengan 0002 karena berdiri
  sendiri di atas data model 0001.
- **CI/CD approach (2026-07-26):** Repo `01persen/PersonalFinanceTrackerV2`
  tetap public (gratis), tapi **drop CI enforcement + branch protection
  required checks**. Yang aktif: local pre-commit hook
  (`.githooks/pre-commit` + `scripts/setup-hooks.sh`) + GitHub Actions
  advisory-only + `release-auto-merge.yml` label gate. Rationale + trade-off
  lihat Epic Detail Doc sub-0001-07 section Notes.

## Riwayat Perubahan

- v0.1 (2026-07-23) — Initial draft oleh System Analyst.
- v1.0 (2026-07-23) — Tech Leader revisi: drop epic-0005 (migration) &
  epic-0006 (recurring) lama; tambah epic multi-account, goal trackers,
  debt tracker, networth dashboard. Recurring dipindah ke epic-0009 BLOCKED.
- v1.1 (2026-07-23) — Tech Leader: tambah seed data section dari analisis
  spreadsheet; epic-0009 disempitkan ke recurring tagihan tetap saja.
- v1.2 (2026-07-23) — Tech Leader: lock tech stack PWA + Supabase + FastAPI
  (PRD §9). epic-0001 → IN_PROGRESS, epic-0009 → NOT_STARTED (scope sempit).
- v1.3 (2026-07-26) — Tech Leader: CI/CD approach berubah ke **Option B**
  (local pre-commit + label gate). Sub-0001-07 merged; sub-0001-08 promoted
  ke TODO. Epic Detail Doc `epic-0001-foundation-auth-and-data-model.md`
  di-update untuk reflect architectural change.
- v1.4 (2026-07-26) — Backend Engineer: epic-0001 → DONE. 8/8 sub-task
  closed, semua PR sudah merged ke `release/epic-0001`. Tinggal CI/CD
  Engineer buka PR `release/epic-0001 → main` untuk finalize. epic-0002 +
  epic-0008 siap dipromosikan paralel.
- v1.5 (2026-07-27) — Tech Leader: epic-0002 → DONE. 5/5 sub-task merged
  ke `release/epic-0002` (HEAD `3db0c13`). Stage H triggered — buka PR
  `release/epic-0002 → main` untuk finalize. Backlog baru: extend
  `ci.yml` ke `release/*` branches (CI gap ditemukan saat merge PR #17)
  + auto-fix `RUF002` Unicode minus di `tests/test_balance_engine.py`
  (minor, ruff findings).
- v1.6 (2026-07-27) — Tech Leader: Stage 5 release fixup complete (sub-0002-06
  + sub-0002-07). PR #18 merged ke `main` (commit `6428c30`, 2026-07-27 13:06
  UTC). CI `api quality` + `web quality` hijau. epic-0002 fully shipped.
  Sub-task backlog catatan: extend `ci.yml` ke `release/*` branches + auto-fix
  RUF002 Unicode di `tests/test_balance_engine.py` belum di-merge ke main
  (di-handle di epic-0003 atau backlog terpisah).