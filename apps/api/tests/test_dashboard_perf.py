"""Dashboard perf tests (epic-0007, sub-0007-01).

Acceptance criterion: **``summary`` endpoint p95 < 500 ms** against a
5.000-transaction sample dataset (mirrors the epic-0007 AC). The bench
is a smoke test, not a hard perf gate — the budget is generous on the
SQLite test backend (PG is the real target) but a regression here
should still fail CI so we don't quietly ship a 5-second summary.

The test seeds a fresh user with 5.000 transactions spread across
~12 months and measures the ``/dashboard/summary`` round-trip over
20 iterations. We also measure the cache hit path (second iteration
onwards) so the test documents both surfaces.

Note on the test backend: SQLite + StaticPool is materially faster than
PostgreSQL on the same query plan, so the budget here is comfortably
met. The 500 ms budget is the PG target — on SQLite this test
typically finishes in < 100 ms. The test still catches O(n²) regressions
where the dashboard accidentally falls back to a per-row fetch.
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
SEED = 42  # deterministic seed so the bench dataset is reproducible


@pytest.fixture(autouse=True)
def _clean_cache() -> None:
    dashboard_cache.reset_for_test()
    yield
    dashboard_cache.reset_for_test()


def _percentile(samples: list[float], pct: float) -> float:
    """Linear-interpolation percentile (matches numpy's default)."""
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


def _seed_perf_dataset(
    client: TestClient,
    fresh_db: Session,
    *,
    tx_count: int,
    email: str = "perf@example.com",
) -> tuple[User, Account, dict[str, str]]:
    """Register a user through the auth flow + seed ``tx_count`` rows.

    Registers the user via the auth API so the JWT we mint comes from
    a real ``User`` row (the dashboard router will refuse a token
    whose subject doesn't exist in the DB). Once registered, we use
    the same in-memory ``fresh_db`` session to bulk-insert the
    transactions — the test backend uses a single shared SQLite
    connection so the seeded rows are visible to the TestClient's
    request handlers immediately.
    """
    resp = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "Sup3rSecret!"},
    )
    assert resp.status_code == 201, resp.text
    headers = {"Authorization": f"Bearer {resp.json()['access_token']}"}

    user = fresh_db.query(User).filter(User.email == email).one()
    account = Account(
        user_id=user.id,
        name="BCA",
        type=AccountType.BANK,
        currency="IDR",
        opening_balance_cents=10_000_000,
    )
    fresh_db.add(account)
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
    span_days = 365  # 12 months
    rows: list[Transaction] = []
    for _ in range(tx_count):
        rows.append(
            Transaction(
                user_id=user.id,
                account_id=account.id,
                category_id=cat.id,
                type=(TransactionType.INCOME if rng.random() < 0.4 else TransactionType.EXPENSE),
                amount_cents=rng.randint(1_000, 5_000_000),
                currency="IDR",
                occurred_on=today - timedelta(days=rng.randint(0, span_days)),
                deleted_at=None,
            )
        )
    fresh_db.add_all(rows)
    fresh_db.commit()
    return user, account, headers


def test_summary_endpoint_p95_under_500ms_with_5k_transactions(
    client: TestClient,
    fresh_db: Session,
) -> None:
    """The headline epic-0007 perf AC.

    Seeds 5.000 transactions for a single user, then runs 20 calls of
    ``GET /dashboard/summary``. Asserts the p95 latency is below
    500 ms — the same budget the sub-task spec calls out.

    Cache state:
    * First call = cache miss, real compute (the slowest iteration).
    * Subsequent calls = cache hits (microseconds, ~0 ms each).
    * p95 is dominated by the cache miss path; the cache-hit runs are
      essentially free.
    """
    user, _account, headers = _seed_perf_dataset(client, fresh_db, tx_count=DEFAULT_TX_COUNT)
    assert user.id

    # Warm up — first call is cache miss + endpoint registration cost.
    warm = client.get("/api/v1/dashboard/summary", headers=headers)
    assert warm.status_code == 200, warm.text

    samples_ms: list[float] = []
    for _ in range(DEFAULT_ITERATIONS):
        # Reset cache between iterations so every iteration is a real
        # compute — that's what the spec measures (no cache benefit on
        # the read path under load). This isolates the *compute* path
        # so a regression in the aggregate query is observable.
        dashboard_cache.reset_for_test()
        t0 = perf_counter()
        resp = client.get("/api/v1/dashboard/summary", headers=headers)
        elapsed = (perf_counter() - t0) * 1000.0
        assert resp.status_code == 200, resp.text
        samples_ms.append(elapsed)

    p95 = _percentile(samples_ms, 95.0)
    median = statistics.median(samples_ms)
    mean = statistics.fmean(samples_ms)
    print(
        f"\n[dashboard perf] n={len(samples_ms)} "
        f"min={min(samples_ms):.1f}ms median={median:.1f}ms "
        f"mean={mean:.1f}ms p95={p95:.1f}ms budget={DEFAULT_BUDGET_MS:.0f}ms"
    )
    assert p95 < DEFAULT_BUDGET_MS, (
        f"summary p95 {p95:.1f} ms exceeds {DEFAULT_BUDGET_MS:.0f} ms budget"
    )


def test_summary_cache_hit_path_is_sub_5ms(
    client: TestClient,
    fresh_db: Session,
) -> None:
    """Per the sub-task AC: ``Cache: hit kedua dalam < 5 ms``.

    Two consecutive ``/dashboard/summary`` calls — first computes and
    caches; second hits the cache. The second call's elapsed time
    should comfortably fit in a 5 ms budget (TTL dict lookup is
    microseconds).
    """
    _user, _account, headers = _seed_perf_dataset(
        client, fresh_db, tx_count=500, email="perf-cache@example.com"
    )

    first = client.get("/api/v1/dashboard/summary", headers=headers)
    assert first.status_code == 200, first.text

    # Take the median over 10 cache-hit reads so the test doesn't
    # flake on a single noisy sample.
    samples_ms: list[float] = []
    for _ in range(10):
        t0 = perf_counter()
        cached = client.get("/api/v1/dashboard/summary", headers=headers)
        elapsed = (perf_counter() - t0) * 1000.0
        assert cached.status_code == 200, cached.text
        samples_ms.append(elapsed)

    median = statistics.median(samples_ms)
    print(
        f"\n[dashboard cache hit] n={len(samples_ms)} "
        f"median={median:.2f}ms min={min(samples_ms):.2f}ms"
    )
    assert median < 5.0, f"cache-hit median {median:.2f} ms exceeds 5 ms budget"


def test_summary_invalidates_after_write_so_subsequent_call_is_fresh(
    client: TestClient,
    fresh_db: Session,
) -> None:
    """A transaction POST invalidates the summary cache; the next read
    reflects the new transaction.

    Per the sub-task AC: ``invalidation post-POST tx fresh``. We verify
    the same here without measuring latency — the contract is just
    "the cache shows fresh data after the invalidation hook fires".
    """
    _user, account, headers = _seed_perf_dataset(
        client, fresh_db, tx_count=100, email="perf-invalidate@example.com"
    )

    # Prime the cache.
    first = client.get("/api/v1/dashboard/summary", headers=headers)
    assert first.status_code == 200, first.text
    baseline_income = first.json()["income_this_month_cents"]

    # Post a transaction — invalidates the cache via the write hook.
    post = client.post(
        "/api/v1/transactions",
        headers=headers,
        json={
            "type": "income",
            "account_id": str(account.id),
            "amount_cents": 999_999,
            "currency": "IDR",
            "occurred_on": date.today().isoformat(),
        },
    )
    assert post.status_code == 201, post.text

    # Re-read — the cache must have been invalidated.
    second = client.get("/api/v1/dashboard/summary", headers=headers)
    assert second.status_code == 200, second.text
    assert second.json()["income_this_month_cents"] == baseline_income + 999_999
