# Personal Finance Tracker

Source code untuk project Personal Finance Tracker.

<!-- CI trigger smoke test: sub-0004-07 C1 verification (2026-07-31) -->

## Layout

```
.
├── apps/
│   ├── api/         # FastAPI backend (sub-0001-01+)
│   └── web/         # Next.js frontend (sub-0001-04+)
├── docs/
│   ├── prd.md
│   ├── product/epics/
│   └── multica/epics.md
├── .githooks/       # Git hooks (pre-commit) — local quality gate
├── .github/
│   └── workflows/   # GitHub Actions (advisory only, tidak block merge)
└── .multica/        # Multica runtime config
```

Branch strategy lihat `docs/product/epics/epic-0001-foundation-auth-and-data-model.md`.

## Quick start

### 1. Setup git hooks (WAJIB, sekali per clone)

```bash
./scripts/setup-hooks.sh
```

Hook `.githooks/pre-commit` jalan otomatis sebelum commit:
- Deteksi perubahan di `apps/api/` → `ruff check` + `mypy src` + `pytest`
- Deteksi perubahan di `apps/web/` → `npm ci` + `lint` + `typecheck` + `build`
- Kalau gagal, **commit ditolak**.

### 2. Backend

```bash
cd apps/api
uv sync --extra dev
cp .env.example .env
uv run uvicorn app.main:app --reload
```

### 3. Frontend

```bash
cd apps/web
npm install
npm run dev
```

## Quality gates

| Layer | Enforcement |
|---|---|
| **Pre-commit (lokal)** | Wajib — `.githooks/pre-commit`. Commit ditolak kalau gagal. |
| **GitHub Actions** | Advisory — matrix api+web untuk visibility. Tidak block merge. |
| **Branch protection `release/*`** | Linear history + no force push + no deletion. |
| **Auto-merge ke `release/*`** | Aktif saat label `epic-ready` terpasang. Disabled saat label dilepas. |

GitHub Actions CI di `.github/workflows/ci.yml` jalan otomatis di push/PR tapi **tidak memblokir merge** — sifatnya advisory untuk transparansi PR status. Enforcements sebenarnya adalah pre-commit hook lokal (cepat, deterministik, no infra flake).
