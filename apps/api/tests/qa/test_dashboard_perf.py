"""QA perf bench for `/dashboard/summary` (sub-0007-09, AC 1, AC 2).

Mirrors the budget sub-0004-03 sets on transactions search: the FE
must see KPI numbers within ``p95 < 500 ms`` against a 5.000-tx
sample. The bench is run against the same SQLite+StaticPool test
backend as :mod:`tests.test_dashboard_perf` — SQLite is materially
faster than PostgreSQL so the budget is comfortably met locally, but
the regression-detection value of the test still stands.

Per spec, we use the ``per_endpoint`` query budget: a single aggregate
batch over accounts/transactions (1+1 query) plus the EF average. Any
N+1 regression would push p95 past the budget.
"""

from __future__ import annotations

import random
import statistics
from datetime import date, timedelta
from time import perf_counter

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.db.models.account import Account
from app.db.models.category import Category
from app.db.models.enums import AccountType, CategoryKind, TransactionType
from app.db.models.transaction import Transaction
from app.db.models.user import User
from app.services import dashboard_cache

DEFAULT_TX_COUNT = 5000
DEFAULT_ITERATIONS = 20
DEFAULT_BUDGET_MS = 500.0
SEED = 4242


@pytest.fixture(autouse=True)
def _clean_cache() -> None:
    dashboard_cache.reset_for_test()
    yield
    dashboard_cache.reset_for_test()


def _percentile(samples: list[float], pct: float) -> float:
    if not samples:
        raise ValueError("samples must be non-empty")
    ordered = sorted(samples)
    if len(ordered) == 1:
        return ordered[0]
    rank = (pct / 100.0) * (len(ordered) - 1)
    lower = int(rank)
    upper = min(lower + 1, len(ordered) - 1)
    weight = rank - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def _seed_dataset(
    client: TestClient,
    fresh_db: Session,
    *,
    tx_count: int,
    email: str = "qa-perf@example.com",
) -> tuple[User, list[Account], dict[str, str]]:
    """Register + seed 10 asset + 3 liability accounts + 5.000 tx."""
    resp = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "Sup3rSecret!"},
    )
    assert resp.status_code == 201, resp.text
    headers = {"Authorization": f"Bearer {resp.json()['access_token']}"}

    user = fresh_db.query(User).filter(User.email == email).one()

    accounts: list[Account] = []
    for i in range(10):
        accounts.append(
            Account(
                user_id=user.id,
                name=f"Asset-{i}",
                type=AccountType.BANK,
                currency="IDR",
                opening_balance_cents=10_000_000 + i * 1_000_000,
            )
        )
    for i in range(3):
        accounts.append(
            Account(
                user_id=user.id,
                name=f"Liability-{i}",
                type=AccountType.CREDIT_CARD,
                currency="IDR",
                opening_balance_cents=-2_000_000 - i * 500_000,
            )
        )
    fresh_db.add_all(accounts)
    fresh_db.flush()

    cat = Category(
        user_id=user.id,
        name="Makan",
        kind=CategoryKind.EXPENSE,
        parent_id=None,
    )
    fresh_db.add(cat)
    fresh_db.flush()

    rng = random.Random(SEED)
    today = date.today()
    span_days = 365
    rows: list[Transaction] = []
    for i in range(tx_count):
        rows.append(
            Transaction(
                user_id=user.id,
                account_id=accounts[i % len(accounts)].id,
                category_id=cat.id,
                type=(
                    TransactionType.INCOME
                    if rng.random() < 0.4
                    else TransactionType.EXPENSE
                ),
                amount_cents=rng.randint(1_000, 5_000_000),
                currency="IDR",
                occurred_on=today - timedelta(days=rng.randint(0, span_days)),
                deleted_at=None,
            )
        )
    fresh_db.add_all(rows)
    fresh_db.commit()
    return user, accounts, headers


def test_summary_p95_under_500ms_with_5k_transactions(
    client: TestClient,
    fresh_db: Session,
) -> None:
    """Headline perf AC: p95 < 500 ms against 5.000 tx + 10 asset + 3 liability."""
    _user, _accounts, headers = _seed_dataset(client, fresh_db, tx_count=DEFAULT_TX_COUNT)

    warm = client.get("/api/v1/dashboard/summary", headers=headers)
    assert warm.status_code == 200, warm.text

    samples_ms: list[float] = []
    for _ in range(DEFAULT_ITERATIONS):
        dashboard_cache.reset_for_test()
        t0 = perf_counter()
        resp = client.get("/api/v1/dashboard/summary", headers=headers)
        elapsed = (perf_counter() - t0) * 1000.0
        assert resp.status_code == 200, resp.text
        samples_ms.append(elapsed)

    p95 = _percentile(samples_ms, 95.0)
    median = statistics.median(samples_ms)
    print(
        f"\n[qa dashboard perf] n={len(samples_ms)} "
        f"min={min(samples_ms):.1f}ms median={median:.1f}ms "
        f"mean={statistics.fmean(samples_ms):.1f}ms p95={p95:.1f}ms "
        f"budget={DEFAULT_BUDGET_MS:.0f}ms"
    )
    assert p95 < DEFAULT_BUDGET_MS, (
        f"summary p95 {p95:.1f} ms exceeds {DEFAULT_BUDGET_MS:.0f} ms budget"
    )
