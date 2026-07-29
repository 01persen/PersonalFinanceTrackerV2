# Project Tracker — Personal Finance Tracker

> **Status:** v3.1 — epic-0001 **DONE** (8/8); epic-0002 **DONE** (7/7 sub-task
> + Stage 5 release fixup complete; [PR #18](https://github.com/01persen/PersonalFinanceTrackerV2/pull/18)
> merged ke `main` pada 2026-07-27 13:06 UTC, CI hijau `api quality` + `web quality`).
> epic-0003 **DONE** (8/8 sub-task + Stage H squash-merged ke `main`).
> [PR #28](https://github.com/01persen/PersonalFinanceTrackerV2/pull/28)
> squash-merge commit `00dc91d1aec86c3f3f3de19573cf4f942a894921`
> 2026-07-29 sudah live di `main`. Pipeline `30439876861`:
> `web quality` PASS + `api quality` FAIL (pre-existing flaky
> `test_get_sort_is_stable_for_same_day`, waived per TL note post-merge
> PR #22 + QA Stage-E PASS exclude via `-k 'not …'`); bypass di-justify
> di PR comment. Pipeline status: `passed-with-known-flaky-bypass`.
> Epic AC cross-check 4/4 PASS. epic-0004 **IN_PROGRESS** (sourced 2026-07-29,
> topmost eligible setelah epic-0003 DONE; hanya butuh `epic-0003`).
> epic-0006 tetap IN_PROGRESS (Stage B belum mulai). epic-0005/0007/0008/0009
> masih NOT_STARTED. Catatan CI follow-up: workflow `ci.yml` belum trigger
> pada push `release/*` sejak 2026-07-28T06:36:12Z — escalate tiket DevOps
> terpisah. **Branch release/epic-0003 masih hidup** (protected=true,
> `--delete-branch` skip oleh GitHub untuk protected branch) — bukan
> blocker tapi flag untuk konsistensi v1.5/v2.5 closing pattern; admin
> override atau unprotect dulu kalau mau dihapus. Kontrak FE: input nominal
> `25.000` (titik sebagai desimal) ditolak client-side sesuai lokale IDR
> (koma = desimal, titik = ribuan) — dokumentasikan ke stakeholder bila
> ada user yang terbiasa titik desimal. **Owner:** Tech Leader (Engineering
> Squad)

Tracker mengikuti urutan dependency graph (bukan urgency bisnis), sesuai SOP.
Epic `BLOCKED` menunggu klarifikasi stakeholder atau dependency lain.

## Daftar Epic

| ID | Judul | Prioritas | Status | Dependency | Owner Area |
|----|-------|-----------|--------|-----------|-----------|
| epic-0001 | Foundation, Auth & Data Model | P-FOUNDATION | **DONE** | — | Backend |
| epic-0002 | Multi-Account Management | P-CORE | **DONE** | 0001 | Backend + Frontend |
| epic-0003 | Transaction Core | P-CORE | **DONE** | 0001, 0002 | Backend + Frontend |
| epic-0004 | Categorization & Search | P-CORE | **IN_PROGRESS** | 0003 | Backend + Frontend |
| epic-0005 | Goal Trackers (Saving & Emergency Fund) | P-CORE | NOT_STARTED | 0002, 0003 | Backend + Frontend |
| epic-0006 | Debt Tracker | P-CORE | **IN_PROGRESS** | 0002 | Backend + Frontend |
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

- epic **0004** sekarang **IN_PROGRESS** (sourced 2026-07-29). Sub-task list
  (Stage B complete 2026-07-29, 7 sub-task di 5 stage). Parent issue:
  [GRE-38](https://multica/issues/GRE-38). Branch: `release/epic-0004`
  (cut dari `main` @ `00dc91d`, yaitu HEAD post epic-0003 squash-merge
  PR #28). Epic-0004 dipilih karena topmost eligible di tabel setelah
  epic-0003 DONE — hanya butuh `epic-0003` (DONE). epic-0006 tetap
  IN_PROGRESS (Stage B belum mulai); epic-0005 eligible (butuh 0002+0003
  DONE), epic-0007 blocked (butuh 0005 NOT_STARTED + 0006 IN_PROGRESS),
  epic-0008 + epic-0009 eligible. Carry-over penting ke sub-0004-03 search
  endpoint: **flaky test `test_get_sort_is_stable_for_same_day` sudah
  diangkat ke sub-task eksplisit `sub-0004-00`** (Stage 1 paralel, BE).
  Kontrak FE↔BE: kategori punya `parent_id` opsional untuk hirarki (sesuai
  spreadsheet user analysis).
  - [ ] sub-0004-00 — Backend Pre-req: fix flaky `test_get_sort_is_stable_for_same_day` → **todo** ([GRE-39](https://multica/issues/GRE-39)), BE. Stage 1 paralel dengan 01.
  - [ ] sub-0004-01 — Backend CRUD `/categories` + parent/child hirarki → **todo** ([GRE-40](https://multica/issues/GRE-40)), BE. Stage 1 paralel dengan 00.
  - [ ] sub-0004-02 — Backend Auto-categorize rule engine + backfill opsional → **backlog** ([GRE-41](https://multica/issues/GRE-41)), BE. Stage 2 (butuh 01).
  - [ ] sub-0004-03 — Backend Search endpoint + index design (perf < 500 ms @ 5k tx) → **backlog** ([GRE-42](https://multica/issues/GRE-42)), BE. Stage 2 (butuh 00).
  - [ ] sub-0004-04 — Frontend UI Manajemen Kategori (mobile-first) → **backlog** ([GRE-43](https://multica/issues/GRE-43)), FE. Stage 3 (butuh 01).
  - [ ] sub-0004-05 — Frontend UI Search global + filter panel (mobile-first) → **backlog** ([GRE-44](https://multica/issues/GRE-44)), FE. Stage 4 (butuh 03 + sub-0003-06 DONE).
  - [ ] sub-0004-06 — QA Integration + e2e test plan Epic 0004 → **backlog** ([GRE-45](https://multica/issues/GRE-45)), QA. Stage 5 (butuh semua).
  - Stage 1 kickoff rest-of-day 2026-07-29 (00 + 01 paralel, BE triggered via sub-issue assignment).
- epic **0006** sekarang **IN_PROGRESS** (sourced 2026-07-29). Sub-task list
  masih kosong — Stage B akan dijalankan TL dengan bantuan SA. Parent
  issue: [GRE-34](https://multica/issues/GRE-34). Branch: `release/epic-0006`
  (cut dari `main` @ `4a8b1b6`). Epic-0006 dipilih karena topmost eligible
  di tabel setelah 0004/0005 terblok dependency 0003 (IN_PROGRESS) — hanya
  butuh `epic-0002` (DONE). epic-0003 Stage 3 FE tetap in-flight paralel.
- epic **0003** sekarang **IN_PROGRESS**. Sub-task list (Stage B complete 2026-07-28, Stage 1 done 2026-07-28):
  - [x] sub-0003-01 — Backend POST + GET list + validasi → **DONE** 2026-07-28, [PR #22](https://github.com/01persen/PersonalFinanceTrackerV2/pull/22) merged ke `release/epic-0003` (squash `6737744a`). CDC clean, QA pass.
  - [x] sub-0003-02 — Backend PATCH + DELETE soft → **DONE** 2026-07-28, [PR #23](https://github.com/01persen/PersonalFinanceTrackerV2/pull/23) merged ke `release/epic-0003` (squash `793ef73`, +753/−17, migration reversible). QA PASS semua 3 AC + 6 area risiko (extra=forbid, DELETE idempotency 204, list/total pagination, audit trail server-side timestamp). Baseline failure `test_get_sort_is_stable_for_same_day` terisolasi pre-existing flaky → tiket housekeeping terpisah (risk: low). Carry-over ke sub-0003-04: aggregator `balance.py` harus filter `deleted_at IS NULL` agar konsisten dengan list exclusion.
  - [x] sub-0003-03 — Backend Transfer paired (atomik) → **DONE** 2026-07-28, [PR #24](https://github.com/01persen/PersonalFinanceTrackerV2/pull/24) merged ke `release/epic-0003` (squash `c9032b9`, +913/−2, migration `a1f7c8e2b4d9` reversible, 19 integration tests baru, 211 tests green post-merge). QA PASS semua 3 AC + validation matrix. Promote 2026-07-28.
  - [x] sub-0003-04 — Backend Aggregasi bulanan (summary) → **DONE** 2026-07-28, merged ke `release/epic-0003`. CDC clean, QA pass.
  - [x] sub-0003-05 — Frontend Form tambah/edit transaksi (mobile-first) → **DONE** 2026-07-28, [PR #26](https://github.com/01persen/PersonalFinanceTrackerV2/pull/26) merged ke `release/epic-0003` (squash `e3f51d9`, +2481/−152). QA PASS setelah 3 defect fix (sub-cent/round-to-0-cents, loading skeleton submit, transfer read-only lock). Branch auto-deleted by `--delete-branch` workflow. Promote 2026-07-28.
  - [x] sub-0003-06 — Frontend List transaksi + filter dasar → **DONE** 2026-07-28, [PR #25](https://github.com/01persen/PersonalFinanceTrackerV2/pull/25) merged ke `release/epic-0003`. Promote 2026-07-28.
  - [x] sub-0003-07 — Frontend View "Pendapatan & Pengeluaran Bulanan" → **DONE** 2026-07-29, [PR #27](https://github.com/01persen/PersonalFinanceTrackerV2/pull/27) merged ke `release/epic-0003` (squash `d258cbc`, +1354/−7). QA PASS semua 4 AC: grouped by tanggal (table colSpan + cards container); total income/expense/net akurat dari `GET /transactions/summary` (BE soft-delete-aware, 17/17 pytest hijau); default landing bulan berjalan pakai `useState(() => getCurrentMonth())` + prev/next + tombol "Bulan ini" dengan `disabled={isCurrentMonth}`; mobile responsive dengan `table hidden md:block` + cards `md:hidden`. Race defense mirror sub-0003-06 (AbortController + `latestLoadIdRef`), loading/error/empty komplit (loading skeleton table & cards terpisah, friendly error mapping 401/403/422/5xx + tombol "Coba lagi", empty state CTA "Tambah transaksi pertama"). Promote 2026-07-29 setelah Stage 3 done.
  - [x] sub-0003-08 — QA Integration + e2e test plan → **DONE** 2026-07-29,
    QA PASS semua 4 sub-AC: (a) 12/12 Playwright e2e + 84/85 pytest
    transaksi cover semua 4 Epic AC; (b) transfer rollback test
    `test_post_transfer_rolls_back_on_commit_failure` +
    `test_post_transfer_does_not_partially_persist_when_validation_fails_after_writes`
    PASS; (c) mobile form ≤10s (expense 1.302 ms, income 1.895 ms
    viewport 390×844); (d) regression hijau — backend 210 passed + 1
    deselected (pre-existing flaky `test_get_sort_is_stable_for_same_day`
    di luar scope, tiket housekeeping terpisah), frontend `next build`
    11/11 route + lint + typecheck hijau. Epic AC cross-check: 4/4 PASS
    (mobile form, transfer paired + saldo, view bulanan + tiles, filter
    DB-konsisten). 0 defect baru. Stage H triggered → CI/CD merge
    `release/epic-0003 → main`.
  - Stage 1 DONE (sub-0003-01); Stage 2 DONE (02/03/04); Stage 3 DONE (05/06); Stage 4 DONE (07); Stage 5 DONE (08); Stage H squash-merged [PR #28](https://github.com/01persen/PersonalFinanceTrackerV2/pull/28) (commit `00dc91d1…`). Sub-task: **8/8 DONE**.
  - **Housekeeping carry-over (terbuka)**: flaky test `test_get_sort_is_stable_for_same_day` — assertion yang bergantung pada UUID random; fix pakai `amount_cents`/`occurred_on` deterministic (CDC catatan post-merge PR #22, masih outstanding, di luar scope epic-0003). Sudah di-bypass di CI via `-k 'not …'` dan di-justify di PR #28 comment — bukan blocker tapi harus di-tackle sebelum epic berikutnya yang heavily modify transactions test (epic-0004/0005/0006).
  - **Branch cleanup**: `release/epic-0003` masih hidup (protected=true) — butuh admin override atau unprotect dulu untuk dihapus (CI/CD Engineer stand-by untuk manual delete via API). Bukan blocker.
  - Parent issue: [GRE-24](https://multica/issues/GRE-24) — di-flip ke `done` di turn ini.
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
- v1.7 (2026-07-28) — Tech Leader (autopilot Stage A): sourced
  epic-0003 → IN_PROGRESS. Parent issue [GRE-24](https://multica/issues/GRE-24)
  dibuat + metadata dipin (`squad_id`, `release_branch=release/epic-0003`,
  `epic_doc_url`, `tracker_url`, `prd_url`). Assignee field di-issue
  belum ter-set (workspace policy: private agent tidak bisa assign squad
  dengan private leader — akan di-fix via mention chain saat Stage B mulai).
  epic-0006 + epic-0008 tetap eligible, akan diproses sesuai Stage Plan.
- v1.8 (2026-07-28) — Tech Leader: [GRE-22](https://multica/issues/GRE-22)
  closed. Ruleset `release-branch-protection` (id `19763743`) di-trim dari
  `[deletion, non_fast_forward]` jadi `[deletion]` saja setelah smoke test
  membuktikan `non_fast_forward` memblokir acceptance criterion (b) —
  `--force-with-lease` post-rebase inherent non-FF. CI/CD Engineer apply
  perubahan + smoke test ulang + cleanup, semua 3 AC hijau. Implikasi:
  `release/epic-NNNN` rebase → force-push sekarang works tanpa toggle
  enforcement. `main` branch protection tetap utuh (`allow_force_pushes:
  false`), risiko bounded karena release branch ephemeral (cut → merge →
  delete). Tracker header di-update.
- v1.9 (2026-07-28) — Tech Leader: epic-0003 Stage B complete. SA breakdown
  Epic 0003 jadi 8 sub-task (4 BE + 3 FE + 1 QA) di 5 stage. Sub-issue
  dibuat: GRE-25..32 (Stage 1=todo, sisanya=backlog). Backend Engineer
  triggered untuk sub-0003-01 (Stage 1 kickoff). Tracker header + Catatan
  + Riwayat di-update.
- v2.0 (2026-07-28) — Tech Leader: Stage 1 sub-0003-01 **DONE**. Backend
  implementasi + QA pass + CI/CD merge PR #22 ke `release/epic-0003` (commit
  `6737744a`, pipeline CDC lulus, 153 tests passing). Stage 2 (sub-0003-02/03/04)
  dipromote ke `todo` + Backend Engineer triggered kickoff paralel. Sub-task
  status: 1/8 DONE (Stage 1 complete, Stage 2 in-flight).
- v2.1 (2026-07-28) — Tech Leader: Stage 2 **DONE** (3/3). sub-0003-02
  [PR #23](https://github.com/01persen/PersonalFinanceTrackerV2/pull/23),
  sub-0003-03 [PR #24](https://github.com/01persen/PersonalFinanceTrackerV2/pull/24),
  sub-0003-04 — semua merged ke `release/epic-0003`, CDC clean, QA pass.
  Stage 3 (sub-0003-05 form, sub-0003-06 list) dipromote ke `todo` + Frontend
  Engineer triggered kickoff paralel. Sub-task status: 4/8 DONE (Stage 1+2
  complete, Stage 3 in-flight).
- v2.1 (2026-07-28) — Tech Leader: Stage 2 sub-0003-02 **DONE**. Backend
  implementasi (1 commit `eb0ea48`, +753/−17, migration `e29955254062_add_transactions_deleted_at_for_soft_.py`
  reversible) + QA PASS (semua 3 AC + 6 area risiko termasuk PATCH extra=forbid
  regression, DELETE idempotency 204, list/total pagination consistency,
  audit trail server-side timestamp) + CI/CD merge PR #23 ke
  `release/epic-0003` (squash `793ef73`, pipeline hijau 174 passed + 1
  baseline failure terisolasi sebagai pre-existing flaky `test_get_sort_is_stable_for_same_day`).
  Carry-over: aggregator `balance.py` (sub-0003-04) harus filter `deleted_at IS NULL`
  agar konsisten dengan list exclusion — saya akan Prioritas-1 cek saat
  sub-0003-04 masuk review. Stage 2 partial: sub-0003-03 transfer paired
  + sub-0003-04 summary aggregasi masih in_review. Sub-task status: **2/8 DONE**.
  Stage 3 backlog belum dipromote (perlu Stage 2 fully done).
- v2.0 (2026-07-28) — Tech Leader: epic-0003 Stage 1 DONE. sub-0003-01
  POST + GET list `/transactions` + validasi merged ke `release/epic-0003`
  ([PR #22](https://github.com/01persen/PersonalFinanceTrackerV2/pull/22),
  squash `6737744a`). QA PASS — semua 4 AC hijau, kontrak BE↔FE siap
  untuk sub-0003-05/06. Status sub-issue flip ke `done` (assignee tetap
  QA Tester sampai tracker snapshot, tidak relevan). Stage 2 dipromote:
  sub-0003-02 / sub-0003-03 / sub-0003-04 → `todo` (paralel, Backend
  Engineer triggered). Housekeeping carry-over ke sub-0003-02: fix flaky
  test `test_get_sort_is_stable_for_same_day` (UUID-random tie-breaker).
  Stage 3-5 masih `backlog`, auto-promote saat prior stage done. CDC
  observasi CI push delay ke `release/*` pasca squash-merge — dipantau
  oleh CDC.
- v2.2 (2026-07-28) — Tech Leader: sub-0003-03 **QA PASS**. Backend
  implementasi (`af6aede`) + migration `a1f7c8e2b4d9` (add
  `transfer_group_id` GUID + index) reversible + 19 integration tests + QA
  PASS (semua 3 AC + validation rejection matrix + regresi 172 tests
  hijau). R1 (EXPENSE/INCOME pair) + R2 (group_id == pair_id MVP) + R3
  (monkey-patch fragility) + R5 (concurrent archive race rollback)
  dikonfirmasi valid. CI/CD Engineer   di-trigger untuk Stage F (buka PR
  `feat/sub-0003-03-transfers-paired` → `release/epic-0003`). Sub-task
  status: 2/8 DONE (sub-0003-03 masih `in_review` sampai PR merge).
- v2.3 (2026-07-28) — Tech Leader: sub-0003-03 **DONE**. CI/CD Engineer
  buka PR #24 (`feat/sub-0003-03-transfers-paired` → `release/epic-0003`)
  + squash-merge `c9032b9` (HEAD baru release/epic-0003). Pipeline
  hijau 211 tests, ruff/mypy clean. Status flip `done` + metadata
  `pr_url`/`pr_number=24`/`pipeline_status=passed` dipin.
  Carry-over ke sub-0003-04 (summary aggregator, masih `in_review`
  paralel Stage 2): rebase `feat/sub-0003-04-transactions-summary` ke
  `c9032b9` (ada migration baru `transfer_group_id` + `deleted_at`),
  filter `deleted_at IS NULL` di aggregator (carry-over lama
  sub-0003-02), decide policy transfer 2-row di summary (count
  net-zero atau income/expense terpisah). Sub-task status: **3/8 DONE**.
- v2.4 (2026-07-28) — Tech Leader: Stage 2 fully **DONE** (3/3) — sub-0003-04
  summary aggregator merged ke `release/epic-0003`. Stage 3 dependency
  check: sub-0003-05 description butuh sub-0003-01 + sub-0003-02 (keduanya
  DONE) + Stage 2 done → MET. sub-0003-06 description butuh sub-0003-01
  done → MET. Keduanya dipromote ke `todo` + Frontend Engineer triggered
  untuk kickoff paralel. Tracker header + Catatan + Riwayat di-update.
  Sub-task status: **4/8 DONE**.
- v2.5 (2026-07-29) — Tech Leader: Stage 3 **DONE** (2/2). sub-0003-05
  form transaksi [PR #26](https://github.com/01persen/PersonalFinanceTrackerV2/pull/26)
  (squash `e3f51d9`) + sub-0003-06 list+filter [PR #25](https://github.com/01persen/PersonalFinanceTrackerV2/pull/25)
  merged ke `release/epic-0003`. CDC clean, QA pass. Stage 4 sub-0003-07
  view bulanan dipromote ke `todo` + Frontend Engineer triggered kickoff.
  Sub-task status: **6/8 DONE**.
- v2.5 (2026-07-29) — Tech Leader (autopilot Stage A): sourced
  epic-0006 → **IN_PROGRESS**. Parent issue [GRE-34](https://multica/issues/GRE-34)
  dibuat + metadata dipin (`squad_id`, `release_branch=release/epic-0006`,
  `epic_doc_url`, `tracker_url`, `prd_url`, `github_repo_url`,
  `project_folder`). Branch `release/epic-0006` di-cut dari `main`
  (commit `4a8b1b6`). Assignee field belum ter-set (workspace policy sama
  dengan v1.7 — private leader tidak bisa assign squad, fix via mention
  chain saat Stage B). epic-0003 Stage 3 (FE) tetap in-flight paralel;
  epic-0008 tetap eligible untuk batch berikutnya.
- v2.7 (2026-07-29) — Tech Leader: Stage 4 epic-0003 sub-0003-07 view bulanan **DONE**. Frontend Engineer push `feat/sub-0003-07-view-bulanan@af5658d` (10 file, +1354/−7), quality gate hijau (lint/typecheck/build 5.72 kB / 108 kB First Load JS), QA PASS semua 4 AC + race defense + state UI komplit (3 run QA awal crash runtime `signal: killed`, run ke-4 via re-trigger link sukses dan menghasilkan test report lengkap). [PR #27](https://github.com/01persen/PersonalFinanceTrackerV2/pull/27) di-buka CI/CD Engineer dan squash-merged `d258cbc` ke `release/epic-0003` (2026-07-29T04:40:01Z). Stage 5 dipromote: sub-0003-08 QA Integration + e2e → `todo` + QA Tester triggered kickoff. Sub-task status: **7/8 DONE**. Catatan non-blocking dari CI/CD Engineer: (a) pre-existing flaky test `test_get_sort_is_stable_for_same_day` di `apps/api/tests/test_transactions.py` (di luar scope sub-0003-07 — 10 file FE only) — quarantine terpisah; (b) `ci.yml` belum ter-trigger pada push `release/*` sejak 2026-07-28T06:36:12Z — escalasi ke manusia (DevOps) lewat issue terpisah sebelum Stage H.
- v2.8 (2026-07-29) — Tech Leader: Stage E → H epic-0003 triggered.
  sub-0003-08 **QA PASS** — QA Tester menyelesaikan integration + e2e
  test plan; 4/4 Epic AC hijau + 4/4 sub-0003-08 AC hijau, 12/12
  Playwright e2e mobile form (mobile ≤10s 1.302 ms expense / 1.895 ms
  income), 84/85 pytest transaksi + 210 backend regression (1
  pre-existing flaky `test_get_sort_is_stable_for_same_day` di-out-of-
  scope, tiket housekeeping terpisah), 11/11 FE build + lint +
  typecheck hijau, 0 defect baru. Sub-task flip → `done`. Stage H
  hand-off: @CI/CD Engineer untuk buka PR `release/epic-0003 → main`
  (HEAD `d258cbc`); setelah merge, parent issue close. Catatan
  carry-over tetap non-blocking: CI workflow `ci.yml` belum trigger
  pada push `release/*` (escalasi DevOps terpisah, follow-up epic
  berikutnya). Sub-task status: **8/8 DONE**. epic-0006 tetap
  IN_PROGRESS (Stage B belum mulai); epic-0008 tetap eligible.
- v2.9 (2026-07-29) — Tech Leader: epic-0003 **DONE** (8/8 + Stage H
  merged). CI/CD Engineer squash-merge
  [PR #28](https://github.com/01persen/PersonalFinanceTrackerV2/pull/28)
  `release/epic-0003 → main` (commit `00dc91d1aec86c3f3f3de19573cf4f942a894921`).
  Pipeline run `30439876861`: `web quality` PASS + `api quality` FAIL
  (pre-existing flaky `test_get_sort_is_stable_for_same_day`, waived
  per TL note post-merge PR #22 + QA exclude via `-k 'not …'` + bypass
  di-justify di PR #28 comment). Pipeline status:
  `passed-with-known-flaky-bypass`. Parent metadata pinned:
  `pr_url`/`pr_number=28`/`merge_commit`/`pipeline_url`/`pipeline_status`.
  Parent issue [GRE-24](https://multica/issues/GRE-24) di-flip `done`.
  Branch `release/epic-0003` masih hidup (`protected=true`, GitHub
  `--delete-branch` skip untuk protected branch) — bukan blocker tapi
  flag untuk konsistensi v1.5/v2.5 closing pattern; admin override
  atau unprotect dulu untuk dihapus. Carry-over non-blocking: flaky
  test quarantine (ticket housekeeping terpisah, **harus di-tackle
  sebelum epic-0004/0005/0006** karena modifikasi `transactions` test);
  CI workflow `ci.yml` belum trigger `release/*` (escalate DevOps).
  epic-0003 fully shipped.
- v2.6 (2026-07-29) — Tech Leader: Stage 3 epic-0003 fully **DONE** (2/2).
  sub-0003-05 form tambah/edit transaksi (mobile-first) merged ke
  `release/epic-0003` ([PR #26](https://github.com/01persen/PersonalFinanceTrackerV2/pull/26),
  squash `e3f51d9`, +2481/−152). QA PASS setelah defect loop 3 area:
  sub-cent/round-to-0-cents (`cents > 0` post-conversion + lokale IDR
  koma-only desimal), loading skeleton submit (`TransactionSubmitSkeleton`
  exported di `/transactions/new` & `/transactions/[id]/edit`), dan
  transfer read-only lock di edit page (`typeLocked` prop + sky-500
  accent). Engineer rebase `d8c5c13 → 2111f20` atas `release/epic-0003`
  saat itu (resolve 5 file add/add conflict dengan sub-0003-06, gabung
  eksplisit API client). Stage 4 dipromote: sub-0003-07 view bulanan
  → `todo` + Frontend Engineer triggered kickoff. Stage 5 (sub-0003-08)
  tetap `backlog` (auto-promote setelah Stage 4 done). Sub-task status:
  **5/8 DONE**. Catatan CI: `ci.yml` belum ter-trigger pada push
  `release/epic-0003` (gap di-flag CI/CD, follow-up epic berikutnya,
  tidak blocker — local lint/typecheck/build hijau). Kontrak FE
  `25.000` ditolak client-side didokumentasikan untuk catatan publik
  (lokale IDR: koma = desimal, titik = ribuan).
- v3.0 (2026-07-29) — Tech Leader (autopilot Stage A): sourced
  epic-0004 → **IN_PROGRESS**. Parent issue [GRE-38](https://multica/issues/GRE-38)
  dibuat + metadata dipin (`squad_id`, `release_branch=release/epic-0004`,
  `epic_doc_url`, `tracker_url`, `prd_url`, `github_repo_url`,
  `project_folder`). Branch `release/epic-0004` di-cut dari `main`
  (commit `00dc91d`, post epic-0003 squash-merge PR #28). Tracker
  header v2.9 → v3.0 + table row epic-0004 status flipped +
  Catatan entry epic-0004 + Riwayat entry v3.0 ditambahkan pada branch
  ini. Epic-0004 dipilih karena topmost eligible di tabel setelah
  epic-0003 DONE — hanya butuh `epic-0003` (DONE). epic-0006 tetap
  IN_PROGRESS (Stage B belum mulai); epic-0005/0008/0009 eligible
  (di-handle batch berikutnya); epic-0007 blocked (butuh 0005 + 0006).
  Carry-over housekeeping: flaky test
  `test_get_sort_is_stable_for_same_day` HARUS di-fix sebelum epic-0004
  sub-task search endpoint dimulai (akan modify
  `apps/api/tests/test_transactions.py`) — tiket terpisah tetap
  outstanding, di-flag di Catatan epic-0004.
- v3.1 (2026-07-29) — Tech Leader: epic-0004 Stage B complete. SA
  breakdown Epic Detail Doc jadi **7 sub-task di 5 stage** (5
  high-level + 1 pre-req housekeeping `sub-0004-00` + 1 QA). Sub-issue
  dibuat: [GRE-39](https://multica/issues/GRE-39) (00, Stage 1 todo,
  BE), [GRE-40](https://multica/issues/GRE-40) (01, Stage 1 todo, BE),
  [GRE-41](https://multica/issues/GRE-41) (02, Stage 2 backlog, BE),
  [GRE-42](https://multica/issues/GRE-42) (03, Stage 2 backlog, BE),
  [GRE-43](https://multica/issues/GRE-43) (04, Stage 3 backlog, FE),
  [GRE-44](https://multica/issues/GRE-44) (05, Stage 4 backlog, FE),
  [GRE-45](https://multica/issues/GRE-45) (06, Stage 5 backlog, QA).
  Stage 1 kickoff rest-of-day 2026-07-29 — Backend Engineer di-trigger
  via sub-issue assignment (`todo` + assignee = BE auto-fire) untuk
  paralel sub-0004-00 (pre-req flaky test fix, file
  `apps/api/tests/test_transactions.py`) + sub-0004-01 (categories CRUD
  schema + parent/child hirarki). Stage 2 dipromote setelah Stage 1
  done per Stage Plan di Operating Manual §5.1. Carry-over penting:
  constraint (d) perf < 500 ms butuh index design di sub-0004-03; FE
  sub-task wajib mobile-first viewport 390×844 (sub-0003-05 baseline).