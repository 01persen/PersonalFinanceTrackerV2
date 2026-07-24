# Personal Finance Tracker

Source code untuk project Personal Finance Tracker.

## Layout

```
.
├── apps/
│   ├── api/         # FastAPI backend (sub-0001-01+)
│   └── web/         # Next.js frontend (sub-0001-04+, belum di-init)
├── docs/
│   ├── prd.md
│   ├── product/epics/
│   └── multica/epics.md
└── .multica/        # Multica runtime config
```

Branch strategy lihat `docs/product/epics/epic-0001-foundation-auth-and-data-model.md`.

## Quick start

Backend:

```bash
cd apps/api
uv sync --extra dev
cp .env.example .env
uv run uvicorn app.main:app --reload
```
