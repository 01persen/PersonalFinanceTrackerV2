# pft-api

Backend API untuk Personal Finance Tracker — FastAPI + SQLAlchemy 2 + Alembic,
dengan JWT-based auth (email + password, hashed via bcrypt).

Lihat epic detail: `docs/product/epics/epic-0001-foundation-auth-and-data-model.md`.

## Requirements

- Python 3.11+
- [`uv`](https://docs.astral.sh/uv/) (dependency manager)
- Postgres (Supabase atau lokal) untuk production; migration test pakai SQLite

## Setup

```bash
cd apps/api
uv sync --extra dev
cp .env.example .env
# edit .env, isi DATABASE_URL (Postgres connection string, psycopg format)
uv run alembic upgrade head       # apply schema
uv run uvicorn app.main:app --reload
```

Server jalan di `http://localhost:8000`. OpenAPI docs di `/docs`, health di
`/health`.

## Auth endpoints

JWT-based, signed dengan `JWT_SECRET` (HS256). Access token dikirim via
`Authorization: Bearer <token>`.

| Method | Path                  | Auth     | Body / Response                          |
|--------|-----------------------|----------|------------------------------------------|
| POST   | `/api/v1/auth/register` | —        | `{email, password}` → `TokenPair`        |
| POST   | `/api/v1/auth/login`    | —        | `{email, password}` → `TokenPair`        |
| POST   | `/api/v1/auth/refresh`  | —        | `{refresh_token}` → `AccessToken`        |
| POST   | `/api/v1/auth/logout`   | Bearer   | — → 204 No Content                       |
| GET    | `/api/v1/auth/me`       | Bearer   | — → `UserPublic` (profil sendiri)        |

Logout MVP-nya stateless — client discard token, server return 204. Token
revocation / blacklist masuk post-MVP.

## Debt endpoints

Semua endpoint debt membutuhkan Bearer token dan hanya mengakses data milik
user aktif. `start_date` memakai format ISO `YYYY-MM-DD`.

| Method | Path | Body / Response |
|--------|------|-----------------|
| POST | `/api/v1/debts` | `DebtCreate` → `DebtPublic` (201) |
| GET | `/api/v1/debts` | — → `DebtPublic[]` |
| GET | `/api/v1/debts/{id}` | — → `DebtPublic` |
| PATCH | `/api/v1/debts/{id}` | `DebtUpdate` → `DebtPublic` |
| DELETE | `/api/v1/debts/{id}` | — → 204 No Content |

`kind` menerima `loan`, `credit_card`, `paylater`, `KTA`, `KKB`, `KPR`, atau
`other`. `principal_cents` wajib positif, `bunga_pct` minimal 0, dan
`tenor_months` wajib positif atau `null`. `monthly_payment_cents` dihitung
server-side memakai bunga flat tahunan: total bunga =
`principal_cents × bunga_pct / 100 × tenor_months / 12`, lalu cicilan bulanan
adalah `(principal_cents + total bunga) / tenor_months` yang dipotong ke integer
cents. Nilainya `null` bila tenor `null`.

## Schema & migrations

ORM models ada di `src/app/db/models/`. Initial migration: `cd96a512ab4a_initial_schema`
membuat 8 tabel (`users`, `accounts`, `categories`, `transactions`,
`category_rules`, `goals`, `debts`, `debt_payments`) dengan index yang sesuai.

```bash
uv run alembic upgrade head        # apply
uv run alembic downgrade -1        # revert 1 step
uv run alembic downgrade base      # revert all
uv run alembic history             # show migration graph
```

Test pakai SQLite otomatis via env override `ALEMBIC_DATABASE_URL` — lihat
`tests/test_migrations.py`.

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
├── main.py                # FastAPI app factory
├── core/
│   ├── config.py          # settings (pydantic-settings)
│   ├── logging.py
│   └── security.py        # bcrypt + JWT helpers
├── api/
│   ├── router.py          # v1 router aggregator
│   ├── schemas.py         # Pydantic request/response models
│   └── v1/
│       └── auth.py        # /auth endpoints
└── db/
    ├── base.py            # DeclarativeBase + naming convention
    ├── session.py         # engine + sessionmaker
    └── models/            # ORM models (User, Account, Category, …)
alembic/                   # Alembic migrations + env.py
├── env.py                 # loads DATABASE_URL from app settings
└── versions/              # migration scripts
```

Sub-issue `sub-0001-08` nambahin default seed saat register.
