# Personal Finance Tracker

Aplikasi pencatatan keuangan pribadi single-user, mobile-first (PWA), dengan
multi-account, tracker (networth, saving, debt, emergency fund), visualisasi
grafik, dan view "Pendapatan & Pengeluaran Bulanan" seperti spreadsheet.

## Status

- **Kickoff:** review (issue GRE-2, awaiting Greenendra sign-off)
- **Epic-0001 Foundation:** DONE (8/8 sub-task merged ke `main`)
- **Epic-0002 Multi-Account:** DONE (5/5 sub-task merged ke `release/epic-0002`; release → `main` PR in-flight)
- **PRD:** v1.2 FINAL

## Tech Stack (locked)

- Frontend: Next.js + TypeScript + Tailwind + Recharts + PWA
- Backend: FastAPI + SQLAlchemy + Alembic
- DB: Supabase Postgres (free tier)
- Auth: Supabase Auth (email + password)
- Deploy target: Vercel (FE) + Supabase (BE/DB/Auth)

## Folder

- `docs/prd.md` — Product Requirements Document
- `docs/multica/epics.md` — Project Tracker
- `docs/product/epics/` — Epic Detail Docs (epic-0001 … epic-0009)

## Branch Strategy

- `main` — production
- `release/epic-NNNN` — epic branch (dibuat saat epic dimulai)
- `feat/<subtask-slug>` — sub-issue branch dari `release/epic-NNNN`
- `hotfix/*` — langsung ke `main`

## SOP Singkat

1. Epic NOT_STARTED + Epic Detail Doc published → Tech Leader buat parent
   issue `[epic-NNNN] <judul>`, assign engineer, flip status → IN_PROGRESS.
2. Engineer pecah epic jadi sub-issue di parent issue.
3. Engineer kerja di branch `feat/*`, push PR ke `release/epic-NNNN`.
4. CI/CD pipeline merge `release/epic-NNNN → main` jika semua sub-issue
   closed dan pipeline hijau. Tidak ada code review manual.
5. Tech Leader flip status epic → DONE setelah merged.

## Daftar Epic

| ID | Judul | Prioritas | Status |
|----|-------|-----------|--------|
| 0001 | Foundation, Auth & Data Model | P-FOUNDATION | **DONE** |
| 0002 | Multi-Account Management | P-CORE | **DONE** |
| 0003 | Transaction Core | P-CORE | NOT_STARTED |
| 0004 | Categorization & Search | P-CORE | NOT_STARTED |
| 0005 | Goal Trackers (Saving & Emergency Fund) | P-CORE | NOT_STARTED |
| 0006 | Debt Tracker | P-CORE | NOT_STARTED |
| 0007 | Networth, Dashboard & Visualization | P-CORE | NOT_STARTED |
| 0008 | Export, Backup & Settings | P-ENHANCEMENT | NOT_STARTED |
| 0009 | Recurring Transaction & Reminder (narrow) | P-ENHANCEMENT | NOT_STARTED |
