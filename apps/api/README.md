# pft-api

Backend API untuk Personal Finance Tracker — FastAPI + SQLAlchemy 2 + Alembic,
dengan Supabase Auth untuk JWT.

Lihat epic detail: `docs/product/epics/epic-0001-foundation-auth-and-data-model.md`.

## Requirements

- Python 3.11+
- [`uv`](https://docs.astral.sh/uv/) (dependency manager)
- Postgres (Supabase atau lokal)

## Setup

```bash
cd apps/api
uv sync --extra dev
cp .env.example .env
# edit .env, isi DATABASE_URL dll.
uv run uvicorn app.main:app --reload
```

Server jalan di `http://localhost:8000`. OpenAPI docs di `/docs`, health di
`/health`.

## Tooling

```bash
uv run ruff check .        # lint
uv run ruff format .       # format
uv run mypy src            # typecheck
uv run pytest              # test
uv run pytest --cov=app    # test + coverage
```

## Layout

```
src/app/
├── main.py            # FastAPI app factory
├── core/
│   ├── config.py      # settings (pydantic-settings)
│   └── logging.py     # structlog setup
└── api/
    └── router.py      # v1 router aggregator
```

Sub-issue berikutnya (`sub-0001-02`) menambahkan `alembic/`, `app/db/`,
dan SQLAlchemy models di sini. Sub-issue `sub-0001-03` nambahin
`app/api/v1/auth.py` yang di-include oleh `router.py`.
