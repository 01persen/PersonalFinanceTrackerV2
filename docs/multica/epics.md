# Project Tracker — Personal Finance Tracker

> **Status:** DRAFT v1.0 — menunggu klarifikasi OQ1–OQ5 (lihat PRD §13)
> **Owner:** Tech Leader (Engineering Squad)

Tracker mengikuti urutan dependency graph (bukan urgency bisnis), sesuai SOP.
Epic `BLOCKED` menunggu klarifikasi stakeholder atau dependency lain.

## Daftar Epic

| ID | Judul | Prioritas | Status | Dependency | Owner Area |
|----|-------|-----------|--------|-----------|-----------|
| epic-0001 | Foundation, Auth & Data Model | P-FOUNDATION | **IN_PROGRESS** | — | Backend |
| epic-0002 | Multi-Account Management | P-CORE | NOT_STARTED | 0001 | Backend + Frontend |
| epic-0003 | Transaction Core | P-CORE | NOT_STARTED | 0001, 0002 | Backend + Frontend |
| epic-0004 | Categorization & Search | P-CORE | NOT_STARTED | 0003 | Backend + Frontend |
| epic-0005 | Goal Trackers (Saving & Emergency Fund) | P-CORE | NOT_STARTED | 0002, 0003 | Backend + Frontend |
| epic-0006 | Debt Tracker | P-CORE | NOT_STARTED | 0002 | Backend + Frontend |
| epic-0007 | Networth, Dashboard & Visualization | P-CORE | NOT_STARTED | 0003, 0005, 0006 | Frontend + Backend |
| epic-0008 | Export, Backup & Settings | P-ENHANCEMENT | NOT_STARTED | 0001 | Backend + Frontend |
| epic-0009 | Recurring Transaction & Reminder (narrow) | P-ENHANCEMENT | NOT_STARTED | 0003 | Backend + Frontend |

## Dependency Graph

```
0001 Foundation
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

- **Stage 1:** epic-0001 (Foundation) — **IN PROGRESS**
- **Stage 2:** epic-0002 + epic-0008 (paralel — keduanya butuh 0001)
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

- epic **0001** sudah IN_PROGRESS (parent issue dibuat, Backend Engineer
  ditugaskan).
- epic **0009** sekarang NOT_STARTED dengan scope sempit: recurring untuk
  tagihan tetap (CC, langganan, cicilan fixed amount) + reminder. Gaji tetap
  manual (input sendiri setiap bulan, amount variabel).
- epic **0007** (dashboard) sengaja di stage terakhir karena butuh data dari
  0003 (transaction), 0005 (goal tracker), dan 0006 (debt tracker).
- epic **0008** (export & settings) bisa paralel dengan 0002 karena berdiri
  sendiri di atas data model 0001.

## Riwayat Perubahan

- v0.1 (2026-07-23) — Initial draft oleh System Analyst.
- v1.0 (2026-07-23) — Tech Leader revisi: drop epic-0005 (migration) &
  epic-0006 (recurring) lama; tambah epic multi-account, goal trackers,
  debt tracker, networth dashboard. Recurring dipindah ke epic-0009 BLOCKED.
- v1.1 (2026-07-23) — Tech Leader: tambah seed data section dari analisis
  spreadsheet; epic-0009 disempitkan ke recurring tagihan tetap saja.
- v1.2 (2026-07-23) — Tech Leader: lock tech stack PWA + Supabase + FastAPI
  (PRD §9). epic-0001 → IN_PROGRESS, epic-0009 → NOT_STARTED (scope sempit).