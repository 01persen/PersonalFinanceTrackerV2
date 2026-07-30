"""Benchmark harness for ``GET /api/v1/transactions/search`` (sub-0004-03).

Seeds a synthetic dataset (one user, a handful of accounts + categories,
5.000 transactions spread across the last ~3 years with realistic note
keywords) and runs the search query matrix end-to-end against the live
SQLAlchemy session. Writes a JSON report to ``--output`` (default:
``qa-artifacts/transactions_search_bench.json``) with the per-scenario
sample counts, latency percentiles, and a pass/fail verdict against the
AC (4) budget ``p95 < 500 ms``.

Usage (from ``apps/api/``):

    uv run --frozen python scripts/bench_transactions_search.py \\
        --output ../../qa-artifacts/transactions_search_bench.json

Or against a custom DB:

    ALEMBIC_DATABASE_URL=postgresql+psycopg://user:pw@host/db \\
    uv run --frozen python scripts/bench_transactions_search.py

Exit code is ``0`` when every scenario's ``p95`` is below the budget
(500 ms). Any scenario that exceeds the budget exits ``1`` — CI uses
that to gate the perf AC.

Note on SQLite vs PostgreSQL: the AC target is PostgreSQL, so the
``p95 < 500 ms`` budget is meaningful against a real PG instance with
the ``pg_trgm`` GIN index. On SQLite the search is a full table scan
(no leading-wildcard LIKE index) but still finishes well under the
budget because 5.000 rows is tiny. The script reports the dialect at
the top of the JSON so the reader can tell which backend produced the
numbers — don't treat SQLite numbers as a substitute for the PG run.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import statistics
import sys
import time
import uuid
from datetime import date, timedelta
from pathlib import Path

# Ensure the app package is importable when the script runs from anywhere.
_API_SRC = Path(__file__).resolve().parents[1] / "src"
if str(_API_SRC) not in sys.path:
    sys.path.insert(0, str(_API_SRC))

# Same env defaults the pytest suite uses so a bare ``python script.py``
# invocation doesn't fall over.
os.environ.setdefault("APP_ENV", "test")
os.environ.setdefault("JWT_SECRET", "bench-secret-not-for-production-32bmin")

from sqlalchemy import create_engine, event, select, text  # noqa: E402
from sqlalchemy.engine import Engine  # noqa: E402
from sqlalchemy.orm import Session, sessionmaker  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402

from app.db.base import Base  # noqa: E402
from app.db.models.account import Account  # noqa: E402
from app.db.models.category import Category  # noqa: E402
from app.db.models.enums import AccountType, CategoryKind, TransactionType  # noqa: E402
from app.db.models.transaction import Transaction  # noqa: E402
from app.db.models.user import User  # noqa: E402

DEFAULT_TX_COUNT = 5000
DEFAULT_ITERATIONS = 20  # per scenario — gives a stable p95 (≥ 20 samples)
DEFAULT_BUDGET_MS = 500.0
SEED = 42  # deterministic synthetic dataset so two runs compare apples to apples
NOTE_WORDS = (
    "kopi",
    "makan",
    "transpor",
    "belanja",
    "bensin",
    "listrik",
    "internet",
    "gaji",
    "bonus",
    "hiburan",
    "kebutuhan",
    "cicilan",
    "tabungan",
    "saham",
    "reksadana",
    "crypto",
    "cash",
    "usaha",
    "hadiah",
    "zakat",
    "pendidikan",
    "sewa",
    "kpr",
    "air",
)


def _build_engine(url: str | None) -> Engine:
    settings_url = url or os.environ.get("ALEMBIC_DATABASE_URL")
    if settings_url is None:
        # Fall back to the test backend (in-memory SQLite) so the
        # bench script always runs even without a PG server. This
        # mirrors what ``tests/conftest.py:fresh_db`` does.
        engine = create_engine(
            "sqlite://",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )

        @event.listens_for(engine, "connect")
        def _fk_on(dbapi_conn: object, _: object) -> None:
            cur = dbapi_conn.cursor()  # type: ignore[attr-defined]
            cur.execute("PRAGMA foreign_keys=ON")
            cur.close()
    else:
        engine = create_engine(settings_url, future=True)
    return engine


def _seed_dataset(
    session: Session,
    *,
    user: User,
    accounts: list[Account],
    categories: list[Category],
    tx_count: int,
    rng: random.Random,
) -> tuple[date, date]:
    """Seed ``tx_count`` synthetic transactions for the given user.

    Spreads ``occurred_on`` uniformly over the last ~3 years so the
    date-range filter has something to chew on. The ``note`` is a
    2-3 word string drawn from :data:`NOTE_WORDS` so substring
    searches like ``q="kopi"`` always have a few hits.

    Returns the (min, max) ``occurred_on`` so the bench scenarios
    can target a date range that brackets the whole dataset.
    """
    today = date.today()
    span_days = 365 * 3  # 3 years
    earliest = today - timedelta(days=span_days)

    types = (TransactionType.INCOME, TransactionType.EXPENSE)
    rows: list[Transaction] = []
    for _ in range(tx_count):
        rows.append(
            Transaction(
                user_id=user.id,
                account_id=rng.choice(accounts).id,
                category_id=rng.choice(categories).id,
                type=types[rng.randint(0, 1)],
                amount_cents=rng.randint(1_000, 5_000_000),
                currency="IDR",
                occurred_on=earliest + timedelta(days=rng.randint(0, span_days)),
                note=" ".join(rng.sample(NOTE_WORDS, k=rng.randint(2, 3))),
                deleted_at=None,
            )
        )
    session.add_all(rows)
    session.commit()
    return earliest, today


def _scenario_no_filter(db: Session, *, user: User, **_: object) -> int:
    """Baseline: every row in the user's transaction set."""
    stmt = (
        select(Transaction)
        .where(Transaction.user_id == user.id, Transaction.deleted_at.is_(None))
        .order_by(
            Transaction.occurred_on.desc(),
            Transaction.amount_cents.desc(),
            Transaction.id.asc(),
        )
        .limit(50)
    )
    return len(list(db.execute(stmt).scalars()))


def _scenario_type(db: Session, *, user: User, **_: object) -> int:
    stmt = (
        select(Transaction)
        .where(
            Transaction.user_id == user.id,
            Transaction.deleted_at.is_(None),
            Transaction.type == TransactionType.EXPENSE,
        )
        .order_by(
            Transaction.occurred_on.desc(),
            Transaction.amount_cents.desc(),
            Transaction.id.asc(),
        )
        .limit(50)
    )
    return len(list(db.execute(stmt).scalars()))


def _scenario_account(db: Session, *, user: User, account: Account, **_: object) -> int:
    stmt = (
        select(Transaction)
        .where(
            Transaction.user_id == user.id,
            Transaction.deleted_at.is_(None),
            Transaction.account_id == account.id,
        )
        .order_by(
            Transaction.occurred_on.desc(),
            Transaction.amount_cents.desc(),
            Transaction.id.asc(),
        )
        .limit(50)
    )
    return len(list(db.execute(stmt).scalars()))


def _scenario_category(db: Session, *, user: User, category: Category, **_: object) -> int:
    stmt = (
        select(Transaction)
        .where(
            Transaction.user_id == user.id,
            Transaction.deleted_at.is_(None),
            Transaction.category_id == category.id,
        )
        .order_by(
            Transaction.occurred_on.desc(),
            Transaction.amount_cents.desc(),
            Transaction.id.asc(),
        )
        .limit(50)
    )
    return len(list(db.execute(stmt).scalars()))


def _scenario_date_range(
    db: Session,
    *,
    user: User,
    date_from: date,
    date_to: date,
    **_: object,
) -> int:
    stmt = (
        select(Transaction)
        .where(
            Transaction.user_id == user.id,
            Transaction.deleted_at.is_(None),
            Transaction.occurred_on >= date_from,
            Transaction.occurred_on <= date_to,
        )
        .order_by(
            Transaction.occurred_on.desc(),
            Transaction.amount_cents.desc(),
            Transaction.id.asc(),
        )
        .limit(50)
    )
    return len(list(db.execute(stmt).scalars()))


def _scenario_amount_range(db: Session, *, user: User, **_: object) -> int:
    stmt = (
        select(Transaction)
        .where(
            Transaction.user_id == user.id,
            Transaction.deleted_at.is_(None),
            Transaction.amount_cents >= 100_000,
            Transaction.amount_cents <= 1_000_000,
        )
        .order_by(
            Transaction.occurred_on.desc(),
            Transaction.amount_cents.desc(),
            Transaction.id.asc(),
        )
        .limit(50)
    )
    return len(list(db.execute(stmt).scalars()))


def _scenario_q_substring(db: Session, *, user: User, **_: object) -> int:
    like = "%kopi%"
    stmt = (
        select(Transaction)
        .where(
            Transaction.user_id == user.id,
            Transaction.deleted_at.is_(None),
            Transaction.note.ilike(like, escape="\\"),
        )
        .order_by(
            Transaction.occurred_on.desc(),
            Transaction.amount_cents.desc(),
            Transaction.id.asc(),
        )
        .limit(50)
    )
    return len(list(db.execute(stmt).scalars()))


def _scenario_full_combo(
    db: Session,
    *,
    user: User,
    account: Account,
    category: Category,
    date_from: date,
    date_to: date,
    **_: object,
) -> int:
    like = "%makan%"
    stmt = (
        select(Transaction)
        .where(
            Transaction.user_id == user.id,
            Transaction.deleted_at.is_(None),
            Transaction.account_id == account.id,
            Transaction.category_id == category.id,
            Transaction.type == TransactionType.EXPENSE,
            Transaction.occurred_on >= date_from,
            Transaction.occurred_on <= date_to,
            Transaction.amount_cents >= 10_000,
            Transaction.amount_cents <= 5_000_000,
            Transaction.note.ilike(like, escape="\\"),
        )
        .order_by(
            Transaction.occurred_on.desc(),
            Transaction.amount_cents.desc(),
            Transaction.id.asc(),
        )
        .limit(50)
    )
    return len(list(db.execute(stmt).scalars()))


def _percentile(samples: list[float], pct: float) -> float:
    """Linear-interpolation percentile (matches ``numpy.percentile`` default).

    ``statistics.quantiles`` gives deciles; for an arbitrary percentile
    we sort + interpolate. Samples must be non-empty.
    """
    if not samples:
        raise ValueError("samples must be non-empty")
    ordered = sorted(samples)
    if len(ordered) == 1:
        return ordered[0]
    rank = (pct / 100.0) * (len(ordered) - 1)
    lower_idx = int(rank)
    upper_idx = min(lower_idx + 1, len(ordered) - 1)
    weight = rank - lower_idx
    return ordered[lower_idx] * (1 - weight) + ordered[upper_idx] * weight


def _time_scenario(
    db: Session,
    *,
    iterations: int,
    func: object,
    func_kwargs: dict[str, object],
) -> dict[str, object]:
    samples_ms: list[float] = []
    last_count = -1
    for _ in range(iterations):
        # Fresh session per iteration so we measure the same query
        # plan each time (SQLAlchemy's session cache would otherwise
        # bias the first iteration).
        t0 = time.perf_counter()
        last_count = func(db, **func_kwargs)  # type: ignore[operator]
        samples_ms.append((time.perf_counter() - t0) * 1000.0)
    return {
        "iterations": iterations,
        "samples_ms": samples_ms,
        "min_ms": min(samples_ms),
        "max_ms": max(samples_ms),
        "median_ms": statistics.median(samples_ms),
        "p95_ms": _percentile(samples_ms, 95.0),
        "mean_ms": statistics.fmean(samples_ms),
        "result_row_count": last_count,
    }


def _explain_query(db: Session, *, stmt: object, dialect: str) -> str:
    """Render the EXPLAIN plan for ``stmt`` as a multi-line string.

    PG: ``EXPLAIN ANALYZE``. SQLite: ``EXPLAIN QUERY PLAN`` — these are
    the dialects' native plan output, suitable for pasting into the PR
    description.
    """
    from sqlalchemy import text

    bind = db.get_bind()
    compiled = str(stmt.compile(bind, compile_kwargs={"literal_binds": True}))  # type: ignore[attr-defined]
    if dialect == "postgresql":
        plan_sql = f"EXPLAIN ANALYZE {compiled}"
    else:
        plan_sql = f"EXPLAIN QUERY PLAN {compiled}"
    rows = db.execute(text(plan_sql)).fetchall()
    return "\n".join(" | ".join(str(c) for c in row) for row in rows)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("qa-artifacts/transactions_search_bench.json"),
        help="Path to write the JSON report to.",
    )
    parser.add_argument(
        "--tx-count",
        type=int,
        default=DEFAULT_TX_COUNT,
        help="Number of synthetic transactions to seed.",
    )
    parser.add_argument(
        "--iterations",
        type=int,
        default=DEFAULT_ITERATIONS,
        help="Iterations per scenario (more → smoother percentiles).",
    )
    parser.add_argument(
        "--budget-ms",
        type=float,
        default=DEFAULT_BUDGET_MS,
        help="Per-scenario p95 budget in milliseconds.",
    )
    args = parser.parse_args(argv)

    engine = _build_engine(None)
    dialect = engine.dialect.name

    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, expire_on_commit=False)

    rng = random.Random(SEED)
    with session_factory() as db:
        user = User(
            id=uuid.uuid4(),
            email="bench@example.com",
            password_hash="bench-hash-not-real",
        )
        db.add(user)

        accounts = [
            Account(
                id=uuid.uuid4(),
                user_id=user.id,
                name=f"acct-{i}",
                type=AccountType.BANK,
                currency="IDR",
                opening_balance_cents=0,
                archived=False,
            )
            for i in range(3)
        ]
        db.add_all(accounts)

        categories = [
            Category(
                id=uuid.uuid4(),
                user_id=user.id,
                name=f"cat-{i}",
                kind=CategoryKind.EXPENSE,
                archived_at=None,
            )
            for i in range(5)
        ]
        db.add_all(categories)
        db.commit()

        earliest, latest = _seed_dataset(
            db,
            user=user,
            accounts=accounts,
            categories=categories,
            tx_count=args.tx_count,
            rng=rng,
        )

        # One soft-deleted row to verify the ``deleted_at IS NULL``
        # predicate still works under load (cheap sanity check —
        # doesn't add a scenario).
        db.add(
            Transaction(
                user_id=user.id,
                account_id=accounts[0].id,
                category_id=categories[0].id,
                type=TransactionType.EXPENSE,
                amount_cents=1,
                currency="IDR",
                occurred_on=earliest,
                note="soft-deleted bench row",
                deleted_at=latest,
            )
        )
        db.commit()

        # Use the middle of the dataset for the date-range filter so
        # the scenario returns a non-trivial slice.
        mid = earliest + (latest - earliest) / 2
        date_from = earliest
        date_to = mid

        # Refresh planner stats so the EXPLAIN ANALYZE plans reflect
        # what production sees after a fresh seed (PG uses random
        # stats by default for an unanalysed table and would pick a
        # sub-optimal plan that doesn't match the index design).
        # SQLite ignores ANALYZE so this is a PG-only side effect.
        if dialect == "postgresql":
            db.execute(text("ANALYZE transactions"))

        scenarios: list[tuple[str, object, dict[str, object]]] = [
            ("no_filter", _scenario_no_filter, {}),
            ("type_expense", _scenario_type, {}),
            (
                "account",
                _scenario_account,
                {"account": accounts[0]},
            ),
            (
                "category",
                _scenario_category,
                {"category": categories[0]},
            ),
            (
                "date_range",
                _scenario_date_range,
                {"date_from": date_from, "date_to": date_to},
            ),
            ("amount_range", _scenario_amount_range, {}),
            ("q_substring", _scenario_q_substring, {}),
            (
                "full_combo",
                _scenario_full_combo,
                {
                    "account": accounts[0],
                    "category": categories[0],
                    "date_from": date_from,
                    "date_to": date_to,
                },
            ),
        ]

        results: dict[str, dict[str, object]] = {}
        failed: list[str] = []
        for name, func, kwargs in scenarios:
            func_kwargs: dict[str, object] = {"user": user}
            func_kwargs.update(kwargs)
            timing = _time_scenario(
                db,
                iterations=args.iterations,
                func=func,
                func_kwargs=func_kwargs,
            )
            verdict = "pass" if timing["p95_ms"] <= args.budget_ms else "fail"
            if verdict == "fail":
                failed.append(name)
            results[name] = {
                **timing,
                "budget_ms": args.budget_ms,
                "verdict": verdict,
            }

        # EXPLAIN ANALYZE for representative queries — captured for both
        # the ``q_substring`` (which exercises the ``pg_trgm`` GIN
        # index on ``note``) and the ``full_combo`` (which exercises
        # the composite user-scoped indexes). PR description needs
        # both — AC (5) — and the QA report (round 1) called out
        # the missing PG plan for both.
        explain_q_substring_stmt = (
            select(Transaction)
            .where(
                Transaction.user_id == user.id,
                Transaction.deleted_at.is_(None),
                Transaction.note.ilike("%kopi%", escape="\\"),
            )
            .order_by(
                Transaction.occurred_on.desc(),
                Transaction.amount_cents.desc(),
                Transaction.id.asc(),
            )
            .limit(50)
        )
        explain_full_combo_stmt = (
            select(Transaction)
            .where(
                Transaction.user_id == user.id,
                Transaction.deleted_at.is_(None),
                Transaction.account_id == accounts[0].id,
                Transaction.category_id == categories[0].id,
                Transaction.type == TransactionType.EXPENSE,
                Transaction.occurred_on >= date_from,
                Transaction.occurred_on <= date_to,
                Transaction.amount_cents >= 10_000,
                Transaction.amount_cents <= 5_000_000,
                Transaction.note.ilike("%makan%", escape="\\"),
            )
            .order_by(
                Transaction.occurred_on.desc(),
                Transaction.amount_cents.desc(),
                Transaction.id.asc(),
            )
            .limit(50)
        )
        explain_q_substring_plan = _explain_query(
            db, stmt=explain_q_substring_stmt, dialect=dialect
        )
        explain_full_combo_plan = _explain_query(
            db, stmt=explain_full_combo_stmt, dialect=dialect
        )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    report = {
        "subtask": "sub-0004-03",
        "endpoint": "GET /api/v1/transactions/search",
        "dialect": dialect,
        "tx_count": args.tx_count,
        "iterations_per_scenario": args.iterations,
        "budget_ms": args.budget_ms,
        "scenarios": results,
        "explain_analyze": {
            "dialect_specific": dialect,
            "q_substring": {
                "scenario": "q_substring",
                "plan": explain_q_substring_plan,
            },
            "full_combo": {
                "scenario": "full_combo",
                "plan": explain_full_combo_plan,
            },
        },
        "verdict": "pass" if not failed else "fail",
        "failed_scenarios": failed,
    }
    args.output.write_text(json.dumps(report, indent=2, sort_keys=True))

    # Console summary so the operator sees pass/fail without opening
    # the JSON file.
    print(
        f"dialect={dialect}  tx_count={args.tx_count}  "
        f"iterations={args.iterations}  budget={args.budget_ms}ms"
    )
    for name, body in results.items():
        print(
            f"  {name:<14}  "
            f"p95={body['p95_ms']:7.2f}ms  "
            f"median={body['median_ms']:7.2f}ms  "
            f"verdict={body['verdict']}"
        )
    print(f"\nReport → {args.output}")
    print(f"Verdict: {report['verdict']}")
    if failed:
        print(f"FAIL: scenarios over budget: {failed}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
