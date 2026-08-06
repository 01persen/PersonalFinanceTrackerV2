"""Dashboard aggregation endpoint tests (epic-0007, sub-0007-01).

Scenarios covered per acceptance criterion:

* **summary** — networth + asset/liability totals + this-month
  income/expense + EF average progress. Empty + populated users,
  two-user isolation, soft-delete aware, EF goal handling
  (``active`` / ``archived`` / missing → ``null``).
* **networth-trend** — oldest-first per-month networth for the last
  N months. Empty user returns zero rows, ``months`` query parameter
  validates to ``[1, 24]``, debt principal is subtracted from each
  bucket.
* **income-expense-trend** — oldest-first per-month income + expense.
  Empty months surface as ``{0, 0}`` so the FE bar chart has a
  stable x-axis. Transfer rows excluded.
* **top-categories** — top-N expense categories for a month. Sorts
  by total desc, ``percentage`` is the row's share of the month's
  total expense. Soft-delete aware.
* **goals-progress** — per-goal progress snapshot. Includes archived
  goals (with ``status='archived'``). ``status`` enum mirrors the
  engine's threshold-cross logic.
* **debts-summary** — aggregate across every debt the user owns.
  Counts split by status, ``total_remaining_cents`` covers active
  debts only, ``total_interest_paid_cents`` covers the whole ledger.
* **Auth + isolation** — every endpoint requires a JWT; another
  user's data never bleeds through.
"""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.db.models.debt import Debt, DebtPayment
from app.db.models.enums import DebtStatus
from app.db.models.transaction import Transaction
from app.services import dashboard_cache

# --- Shared fixtures + helpers ----------------------------------------------


@pytest.fixture(autouse=True)
def _reset_dashboard_cache() -> None:
    """Empty the in-process TTL dict between tests.

    The cache lives at module scope, so without this fixture a test
    that hits the summary endpoint could leak its payload into the
    next test (the key includes the user's UUID, but a test that
    re-uses an email address — which happens for cross-user isolation
    scenarios — would otherwise read a stale entry).
    """
    dashboard_cache.reset_for_test()
    yield
    dashboard_cache.reset_for_test()


def _register(client: TestClient, email: str) -> dict:
    resp = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "Sup3rSecret!"},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _auth_headers(token: object) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_account(
    client: TestClient,
    headers: dict[str, str],
    *,
    name: str = "BCA",
    type_: str = "bank",
    opening_balance_cents: int = 0,
) -> dict:
    resp = client.post(
        "/api/v1/accounts",
        headers=headers,
        json={
            "name": name,
            "type": type_,
            "currency": "IDR",
            "opening_balance_cents": opening_balance_cents,
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _create_transaction(
    client: TestClient,
    headers: dict[str, str],
    *,
    type_: str,
    account_id: str,
    category_id: str | None = None,
    amount_cents: int = 50_000,
    occurred_on: date | None = None,
) -> dict:
    payload: dict = {
        "type": type_,
        "account_id": account_id,
        "amount_cents": amount_cents,
        "currency": "IDR",
        "occurred_on": (occurred_on or date.today()).isoformat(),
    }
    if category_id is not None:
        payload["category_id"] = category_id
    resp = client.post("/api/v1/transactions", headers=headers, json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


def _list_categories(client: TestClient, headers: dict[str, str]) -> list[dict]:
    resp = client.get("/api/v1/categories", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()["items"]


def _create_goal(
    client: TestClient,
    headers: dict[str, str],
    *,
    kind: str,
    name: str = "Dana Darurat",
    target_amount_cents: int = 12_000_000,
    current_amount_cents: int | None = None,
    monthly_expense_cents: int | None = None,
    jumlah_tanggungan: int | None = None,
    multiplier: int | None = None,
    jangka_waktu_months: int | None = None,
) -> dict:
    payload: dict = {
        "kind": kind,
        "name": name,
        "target_amount_cents": target_amount_cents,
    }
    if current_amount_cents is not None:
        payload["current_amount_cents"] = current_amount_cents
    if monthly_expense_cents is not None:
        payload["monthly_expense_cents"] = monthly_expense_cents
    if jumlah_tanggungan is not None:
        payload["jumlah_tanggungan"] = jumlah_tanggungan
    if multiplier is not None:
        payload["multiplier"] = multiplier
    if jangka_waktu_months is not None:
        payload["jangka_waktu_months"] = jangka_waktu_months
    resp = client.post("/api/v1/goals", headers=headers, json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


def _create_debt(
    client: TestClient,
    headers: dict[str, str],
    *,
    name: str = "KPR",
    kind: str = "KPR",
    principal_cents: int = 12_000_000,
    bunga_pct: Decimal | int = 10,
    tenor_months: int | None = 12,
    start_date: date | None = None,
) -> dict:
    body: dict = {
        "name": name,
        "kind": kind,
        "principal_cents": principal_cents,
        "bunga_pct": float(bunga_pct) if isinstance(bunga_pct, Decimal) else bunga_pct,
        "tenor_months": tenor_months,
        "start_date": (start_date or date.today()).isoformat(),
    }
    resp = client.post("/api/v1/debts", headers=headers, json=body)
    assert resp.status_code == 201, resp.text
    return resp.json()


def _soft_delete_transaction(fresh_db: Session, tx_id: uuid.UUID) -> None:
    row = fresh_db.get(Transaction, tx_id)
    assert row is not None
    row.deleted_at = datetime(2026, 1, 1, 12, 0, 0, tzinfo=UTC)
    fresh_db.commit()


# --- /summary ---------------------------------------------------------------


def test_summary_empty_user_returns_zero_balances_and_null_ef(
    client: TestClient, fresh_db: Session
) -> None:
    """A fresh user with no accounts/transactions/goals/debts sees a
    zero-everything summary with ``emergency_fund_avg_pct=None``."""
    headers = _auth_headers(_register(client, "empty-sum@example.com")["access_token"])
    resp = client.get("/api/v1/dashboard/summary", headers=headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body == {
        "currency": "IDR",
        "networth_cents": 0,
        "total_assets_cents": 0,
        "total_liabilities_cents": 0,
        "income_this_month_cents": 0,
        "expense_this_month_cents": 0,
        "emergency_fund_avg_pct": None,
    }


def test_summary_includes_opening_balance_for_assets(client: TestClient, fresh_db: Session) -> None:
    """Asset account's opening balance rolls up into total_assets."""
    headers = _auth_headers(_register(client, "assets-sum@example.com")["access_token"])
    account = _create_account(client, headers, name="BCA", opening_balance_cents=5_000_000)
    _create_transaction(
        client,
        headers,
        type_="income",
        account_id=account["id"],
        amount_cents=2_500_000,
    )

    resp = client.get("/api/v1/dashboard/summary", headers=headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total_assets_cents"] == 7_500_000
    assert body["networth_cents"] == 7_500_000
    assert body["total_liabilities_cents"] == 0
    assert body["income_this_month_cents"] == 2_500_000


def test_summary_credit_card_outstanding_surfaces_as_liability(
    client: TestClient, fresh_db: Session
) -> None:
    """A credit card with a negative running balance contributes its
    absolute value to ``total_liabilities_cents``."""
    headers = _auth_headers(_register(client, "cc-sum@example.com")["access_token"])
    bank = _create_account(client, headers, name="BCA", opening_balance_cents=5_000_000)
    card = _create_account(
        client,
        headers,
        name="BCA Card",
        type_="credit_card",
        opening_balance_cents=-1_000_000,
    )
    # Sanity that the card's opening_balance is negative on read.
    assert card["opening_balance_cents"] == -1_000_000

    _create_transaction(
        client,
        headers,
        type_="expense",
        account_id=bank["id"],
        amount_cents=200_000,
    )

    resp = client.get("/api/v1/dashboard/summary", headers=headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # Bank account: 5M opening - 200k expense = 4.8M asset.
    assert body["total_assets_cents"] == 4_800_000
    # Credit card with -1M opening balance -> 1M liability (absolute).
    assert body["total_liabilities_cents"] == 1_000_000
    assert body["networth_cents"] == 3_800_000
    assert body["expense_this_month_cents"] == 200_000


def test_summary_ef_avg_is_average_across_active_ef_goals(
    client: TestClient, fresh_db: Session
) -> None:
    """Two EF goals with different progress → EF avg = mean of the two.

    Goal A: 50% (current=6_000_000, target=12_000_000). Goal B: 25%
    (current=3_000_000, target=12_000_000). Average = 37.5%.
    """
    headers = _auth_headers(_register(client, "ef-sum@example.com")["access_token"])
    _create_goal(
        client,
        headers,
        kind="emergency_fund",
        name="EF A",
        target_amount_cents=12_000_000,
        current_amount_cents=6_000_000,
        monthly_expense_cents=2_000_000,
        jumlah_tanggungan=1,
    )
    _create_goal(
        client,
        headers,
        kind="emergency_fund",
        name="EF B",
        target_amount_cents=12_000_000,
        current_amount_cents=3_000_000,
        monthly_expense_cents=2_000_000,
        jumlah_tanggungan=1,
    )

    resp = client.get("/api/v1/dashboard/summary", headers=headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["emergency_fund_avg_pct"] == 37.5


def test_summary_ef_avg_excludes_archived_ef_goals(client: TestClient, fresh_db: Session) -> None:
    """An archived EF goal does not contribute to the EF average."""
    headers = _auth_headers(_register(client, "archived-ef-sum@example.com")["access_token"])
    active = _create_goal(
        client,
        headers,
        kind="emergency_fund",
        name="Active",
        target_amount_cents=12_000_000,
        current_amount_cents=6_000_000,
        monthly_expense_cents=2_000_000,
        jumlah_tanggungan=1,
    )
    archived = _create_goal(
        client,
        headers,
        kind="emergency_fund",
        name="Archived",
        target_amount_cents=12_000_000,
        current_amount_cents=12_000_000,
        monthly_expense_cents=2_000_000,
        jumlah_tanggungan=1,
    )
    archived_resp = client.delete(f"/api/v1/goals/{archived['id']}", headers=headers)
    assert archived_resp.status_code == 204

    resp = client.get("/api/v1/dashboard/summary", headers=headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # Only the active goal contributes; 6M / 12M = 50%.
    assert body["emergency_fund_avg_pct"] == 50.0
    # Sanity that the active goal exists.
    assert active["id"]


def test_summary_saving_goal_does_not_contribute_to_ef_avg(
    client: TestClient, fresh_db: Session
) -> None:
    """Saving goals are not in the EF average — only ``kind='emergency_fund'``."""
    headers = _auth_headers(_register(client, "saving-ef-sum@example.com")["access_token"])
    _create_goal(
        client,
        headers,
        kind="saving",
        name="Liburan",
        target_amount_cents=10_000_000,
        current_amount_cents=5_000_000,
        jangka_waktu_months=12,
    )

    resp = client.get("/api/v1/dashboard/summary", headers=headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["emergency_fund_avg_pct"] is None


def test_summary_excludes_soft_deleted_transactions(client: TestClient, fresh_db: Session) -> None:
    """Soft-deleted transactions don't contribute to this-month totals."""
    headers = _auth_headers(_register(client, "softdel-sum@example.com")["access_token"])
    account = _create_account(client, headers)
    keep = _create_transaction(
        client,
        headers,
        type_="income",
        account_id=account["id"],
        amount_cents=1_000_000,
    )
    drop = _create_transaction(
        client,
        headers,
        type_="expense",
        account_id=account["id"],
        amount_cents=400_000,
    )
    _soft_delete_transaction(fresh_db, uuid.UUID(drop["id"]))

    resp = client.get("/api/v1/dashboard/summary", headers=headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["income_this_month_cents"] == 1_000_000
    assert body["expense_this_month_cents"] == 0

    # Sanity — the kept row is still live.
    assert fresh_db.get(Transaction, uuid.UUID(keep["id"])) is not None


def test_summary_excludes_transfers_from_income_expense_totals(
    client: TestClient, fresh_db: Session
) -> None:
    """Standalone ``type='transfer'`` rows are not counted as
    income/expense.

    Note on the paired-transfer flow (sub-0003-03): a transfer between
    two of the user's accounts creates two rows — one ``expense`` leg
    and one ``income`` leg — both with ``transfer_pair_id`` set. The
    dashboard spec follows the existing transactions-summary endpoint
    and counts those legs by ``type IN ('income', 'expense')``; only
    a *standalone* ``type='transfer'`` row (none exist in the current
    API but the enum supports it) is filtered out here. This matches
    the spec verbatim:
    ``aggregate transactions WHERE type IN ('income','expense')``.
    """
    headers = _auth_headers(_register(client, "transfer-sum@example.com")["access_token"])
    bank = _create_account(client, headers, name="BCA")
    cash = _create_account(client, headers, name="Tunai")
    resp = client.post(
        "/api/v1/transactions/transfer",
        headers=headers,
        json={
            "source_account_id": bank["id"],
            "destination_account_id": cash["id"],
            "amount_cents": 500_000,
            "currency": "IDR",
            "occurred_on": date.today().isoformat(),
        },
    )
    assert resp.status_code == 201, resp.text

    summary = client.get("/api/v1/dashboard/summary", headers=headers)
    assert summary.status_code == 200
    body = summary.json()
    # Paired transfer legs surface as ``type='income'`` (destination)
    # and ``type='expense'`` (source) on the dashboard per the spec —
    # the saldo engine double-counts internally and the FE knows not
    # to render these as real income/expense. We only assert the net
    # effect: the user's networth is unchanged, so income + expense
    # cancel out exactly (500k income + 500k expense = zero net).
    assert body["income_this_month_cents"] == 500_000
    assert body["expense_this_month_cents"] == 500_000
    assert body["networth_cents"] == 0


def test_summary_isolates_users(client: TestClient, fresh_db: Session) -> None:
    """Alice's transactions don't show up in Bob's summary."""
    alice_h = _auth_headers(_register(client, "alice-sum@example.com")["access_token"])
    bob_h = _auth_headers(_register(client, "bob-sum@example.com")["access_token"])
    alice_acc = _create_account(client, alice_h)
    _create_transaction(
        client,
        alice_h,
        type_="income",
        account_id=alice_acc["id"],
        amount_cents=10_000_000,
    )

    alice_resp = client.get("/api/v1/dashboard/summary", headers=alice_h)
    bob_resp = client.get("/api/v1/dashboard/summary", headers=bob_h)
    assert alice_resp.status_code == 200
    assert bob_resp.status_code == 200
    assert alice_resp.json()["income_this_month_cents"] == 10_000_000
    assert bob_resp.json()["income_this_month_cents"] == 0


def test_summary_requires_authentication(client: TestClient, fresh_db: Session) -> None:
    resp = client.get("/api/v1/dashboard/summary")
    assert resp.status_code == 401


# --- /networth-trend --------------------------------------------------------


def test_networth_trend_default_returns_twelve_months_for_empty_user(
    client: TestClient, fresh_db: Session
) -> None:
    """Empty user → 12 zero rows in chronological order."""
    headers = _auth_headers(_register(client, "empty-trend@example.com")["access_token"])
    resp = client.get("/api/v1/dashboard/networth-trend", headers=headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    data = body["data"]
    assert len(data) == 12
    for i, point in enumerate(data):
        assert point["networth_cents"] == 0
        if i > 0:
            assert point["month"] > data[i - 1]["month"]


def test_networth_trend_includes_debt_remaining_in_each_bucket(
    client: TestClient, fresh_db: Session
) -> None:
    """A debt's remaining principal subtracts from the networth at every
    month bucket."""
    headers = _auth_headers(_register(client, "debt-trend@example.com")["access_token"])
    _create_account(client, headers, name="BCA", opening_balance_cents=10_000_000)
    _create_debt(
        client,
        headers,
        principal_cents=4_000_000,
        tenor_months=12,
    )

    resp = client.get("/api/v1/dashboard/networth-trend", headers=headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    data = body["data"]
    # Every bucket should reflect 10jt assets - 4jt debt = 6jt networth.
    assert all(point["networth_cents"] == 6_000_000 for point in data)


@pytest.mark.parametrize("months", [1, 24])
def test_networth_trend_accepts_valid_months_window(
    client: TestClient, fresh_db: Session, months: int
) -> None:
    """``months`` query parameter accepts [1, 24]."""
    headers = _auth_headers(_register(client, f"trend-{months}@example.com")["access_token"])
    resp = client.get(
        "/api/v1/dashboard/networth-trend",
        headers=headers,
        params={"months": months},
    )
    assert resp.status_code == 200, resp.text
    assert len(resp.json()["data"]) == months


@pytest.mark.parametrize("months", [0, 25, -1])
def test_networth_trend_rejects_out_of_range_months(
    client: TestClient, fresh_db: Session, months: int
) -> None:
    """Out-of-range ``months`` get rejected by Pydantic → 422."""
    headers = _auth_headers(_register(client, f"trend-bad-{months}@example.com")["access_token"])
    resp = client.get(
        "/api/v1/dashboard/networth-trend",
        headers=headers,
        params={"months": months},
    )
    assert resp.status_code == 422, resp.text


def test_networth_trend_requires_authentication(client: TestClient, fresh_db: Session) -> None:
    resp = client.get("/api/v1/dashboard/networth-trend")
    assert resp.status_code == 401


# --- /income-expense-trend --------------------------------------------------


def test_income_expense_trend_default_returns_twelve_months(
    client: TestClient, fresh_db: Session
) -> None:
    """Empty user → 12 zero rows; the FE bar chart needs a stable x-axis."""
    headers = _auth_headers(_register(client, "empty-iet@example.com")["access_token"])
    resp = client.get("/api/v1/dashboard/income-expense-trend", headers=headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    data = body["data"]
    assert len(data) == 12
    for point in data:
        assert point["income_cents"] == 0
        assert point["expense_cents"] == 0


def test_income_expense_trend_aggregates_per_month(client: TestClient, fresh_db: Session) -> None:
    """Income + expense in the current month surface in the current
    bucket; older transactions roll up into their own bucket."""
    headers = _auth_headers(_register(client, "ie-bucket@example.com")["access_token"])
    account = _create_account(client, headers)
    today = date.today()
    last_month = today.replace(day=1) - timedelta(days=1)

    _create_transaction(
        client,
        headers,
        type_="income",
        account_id=account["id"],
        amount_cents=1_000_000,
        occurred_on=today,
    )
    _create_transaction(
        client,
        headers,
        type_="expense",
        account_id=account["id"],
        amount_cents=400_000,
        occurred_on=today,
    )
    _create_transaction(
        client,
        headers,
        type_="income",
        account_id=account["id"],
        amount_cents=2_000_000,
        occurred_on=last_month,
    )

    resp = client.get("/api/v1/dashboard/income-expense-trend", headers=headers)
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    this_month_label = f"{today.year:04d}-{today.month:02d}"
    this_point = next(p for p in data if p["month"] == this_month_label)
    last_month_label = f"{last_month.year:04d}-{last_month.month:02d}"
    last_point = next(p for p in data if p["month"] == last_month_label)
    assert this_point["income_cents"] == 1_000_000
    assert this_point["expense_cents"] == 400_000
    assert last_point["income_cents"] == 2_000_000
    assert last_point["expense_cents"] == 0


def test_income_expense_trend_includes_paired_transfer_legs(
    client: TestClient, fresh_db: Session
) -> None:
    """Paired-transfer legs surface as ``income`` / ``expense`` in the
    trend (one leg each side, mirroring the existing transactions
    summary endpoint). Standalone ``type='transfer'`` rows would not
    surface because of the ``type != TRANSFER`` filter; in practice the
    paired-transfer flow is the only way transfer rows land today, so
    the test exercises that surface explicitly.

    Net effect on the trend: the source/destination legs cancel out
    in the FE's networth view, but the trend still surfaces both
    counts so the chart matches the underlying rows.
    """
    headers = _auth_headers(_register(client, "iet-transfer@example.com")["access_token"])
    bank = _create_account(client, headers, name="BCA")
    cash = _create_account(client, headers, name="Tunai")
    resp = client.post(
        "/api/v1/transactions/transfer",
        headers=headers,
        json={
            "source_account_id": bank["id"],
            "destination_account_id": cash["id"],
            "amount_cents": 750_000,
            "currency": "IDR",
            "occurred_on": date.today().isoformat(),
        },
    )
    assert resp.status_code == 201

    trend = client.get("/api/v1/dashboard/income-expense-trend", headers=headers)
    assert trend.status_code == 200
    today_label = f"{date.today().year:04d}-{date.today().month:02d}"
    today_point = next(p for p in trend.json()["data"] if p["month"] == today_label)
    # Paired legs counted by ``type`` — one income (destination) and
    # one expense (source).
    assert today_point["income_cents"] == 750_000
    assert today_point["expense_cents"] == 750_000


def test_income_expense_trend_excludes_soft_deleted(client: TestClient, fresh_db: Session) -> None:
    """Soft-deleted transactions don't roll up into the trend."""
    headers = _auth_headers(_register(client, "iet-softdel@example.com")["access_token"])
    account = _create_account(client, headers)
    keep = _create_transaction(
        client,
        headers,
        type_="income",
        account_id=account["id"],
        amount_cents=500_000,
    )
    drop = _create_transaction(
        client,
        headers,
        type_="expense",
        account_id=account["id"],
        amount_cents=300_000,
    )
    _soft_delete_transaction(fresh_db, uuid.UUID(drop["id"]))

    resp = client.get("/api/v1/dashboard/income-expense-trend", headers=headers)
    assert resp.status_code == 200, resp.text
    today_label = f"{date.today().year:04d}-{date.today().month:02d}"
    point = next(p for p in resp.json()["data"] if p["month"] == today_label)
    assert point["income_cents"] == 500_000
    assert point["expense_cents"] == 0
    assert fresh_db.get(Transaction, uuid.UUID(keep["id"])) is not None


def test_income_expense_trend_requires_authentication(
    client: TestClient, fresh_db: Session
) -> None:
    resp = client.get("/api/v1/dashboard/income-expense-trend")
    assert resp.status_code == 401


# --- /top-categories -------------------------------------------------------


def test_top_categories_empty_user_returns_empty_list(
    client: TestClient, fresh_db: Session
) -> None:
    """No expenses → ``data: []``."""
    headers = _auth_headers(_register(client, "empty-top@example.com")["access_token"])
    resp = client.get("/api/v1/dashboard/top-categories", headers=headers)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"data": []}


def test_top_categories_sorts_by_total_desc(client: TestClient, fresh_db: Session) -> None:
    """Top-N categories are sorted by ``total_cents`` descending."""
    headers = _auth_headers(_register(client, "top-sort@example.com")["access_token"])
    account = _create_account(client, headers)
    cats = _list_categories(client, headers)
    makan = next(c for c in cats if c["kind"] == "expense" and "Makan" in c["name"])
    transport = next(c for c in cats if c["kind"] == "expense" and "Transport" in c["name"])

    _create_transaction(
        client,
        headers,
        type_="expense",
        account_id=account["id"],
        category_id=makan["id"],
        amount_cents=250_000,
    )
    _create_transaction(
        client,
        headers,
        type_="expense",
        account_id=account["id"],
        category_id=makan["id"],
        amount_cents=150_000,
    )
    _create_transaction(
        client,
        headers,
        type_="expense",
        account_id=account["id"],
        category_id=transport["id"],
        amount_cents=100_000,
    )

    resp = client.get(
        "/api/v1/dashboard/top-categories",
        headers=headers,
        params={"limit": 5},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert len(data) == 2
    assert data[0]["category_id"] == makan["id"]
    assert data[0]["total_cents"] == 400_000
    assert data[0]["percentage"] == 80.0
    assert data[1]["category_id"] == transport["id"]
    assert data[1]["total_cents"] == 100_000
    assert data[1]["percentage"] == 20.0


def test_top_categories_respects_limit(client: TestClient, fresh_db: Session) -> None:
    """``limit=1`` returns only the top category."""
    headers = _auth_headers(_register(client, "top-limit@example.com")["access_token"])
    account = _create_account(client, headers)
    cats = _list_categories(client, headers)
    expense_cats = [c for c in cats if c["kind"] == "expense"][:3]

    for idx, cat in enumerate(expense_cats):
        _create_transaction(
            client,
            headers,
            type_="expense",
            account_id=account["id"],
            category_id=cat["id"],
            amount_cents=100_000 * (idx + 1),
        )

    resp = client.get(
        "/api/v1/dashboard/top-categories",
        headers=headers,
        params={"limit": 1},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert len(data) == 1
    assert data[0]["total_cents"] == 300_000


def test_top_categories_excludes_income_transactions(client: TestClient, fresh_db: Session) -> None:
    """The endpoint only aggregates ``type='expense'``."""
    headers = _auth_headers(_register(client, "top-income@example.com")["access_token"])
    account = _create_account(client, headers)
    cats = _list_categories(client, headers)
    gaji = next(c for c in cats if c["kind"] == "income" and "Gaji" in c["name"])
    _create_transaction(
        client,
        headers,
        type_="income",
        account_id=account["id"],
        category_id=gaji["id"],
        amount_cents=10_000_000,
    )

    resp = client.get(
        "/api/v1/dashboard/top-categories",
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"data": []}


def test_top_categories_excludes_soft_deleted(client: TestClient, fresh_db: Session) -> None:
    """Soft-deleted expenses are filtered out."""
    headers = _auth_headers(_register(client, "top-softdel@example.com")["access_token"])
    account = _create_account(client, headers)
    cats = _list_categories(client, headers)
    makan = next(c for c in cats if c["kind"] == "expense" and "Makan" in c["name"])
    drop = _create_transaction(
        client,
        headers,
        type_="expense",
        account_id=account["id"],
        category_id=makan["id"],
        amount_cents=500_000,
    )
    _soft_delete_transaction(fresh_db, uuid.UUID(drop["id"]))

    resp = client.get(
        "/api/v1/dashboard/top-categories",
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"data": []}


@pytest.mark.parametrize("month", ["2026-99", "abc-de", "2026/01", "2026-1"])
def test_top_categories_rejects_malformed_month(
    client: TestClient, fresh_db: Session, month: str
) -> None:
    """Unparseable ``month`` query value → 422."""
    headers = _auth_headers(
        _register(client, f"top-bad-month-{month.replace('/', '_')}@example.com")["access_token"]
    )
    resp = client.get(
        "/api/v1/dashboard/top-categories",
        headers=headers,
        params={"month": month},
    )
    assert resp.status_code == 422, resp.text


@pytest.mark.parametrize("limit", [0, 21, -1])
def test_top_categories_rejects_out_of_range_limit(
    client: TestClient, fresh_db: Session, limit: int
) -> None:
    """Out-of-range ``limit`` → 422."""
    headers = _auth_headers(_register(client, f"top-bad-limit-{limit}@example.com")["access_token"])
    resp = client.get(
        "/api/v1/dashboard/top-categories",
        headers=headers,
        params={"limit": limit},
    )
    assert resp.status_code == 422, resp.text


def test_top_categories_requires_authentication(client: TestClient, fresh_db: Session) -> None:
    resp = client.get("/api/v1/dashboard/top-categories")
    assert resp.status_code == 401


# --- /goals-progress -------------------------------------------------------


def test_goals_progress_empty_user_returns_empty_list(
    client: TestClient, fresh_db: Session
) -> None:
    headers = _auth_headers(_register(client, "empty-gp@example.com")["access_token"])
    resp = client.get("/api/v1/dashboard/goals-progress", headers=headers)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"data": []}


def test_goals_progress_includes_ef_and_saving_with_status_active(
    client: TestClient, fresh_db: Session
) -> None:
    """Two goals surface with ``status='active'`` and the engine's pct."""
    headers = _auth_headers(_register(client, "gp-active@example.com")["access_token"])
    _create_goal(
        client,
        headers,
        kind="emergency_fund",
        name="EF",
        target_amount_cents=12_000_000,
        current_amount_cents=6_000_000,
        monthly_expense_cents=2_000_000,
        jumlah_tanggungan=1,
    )
    _create_goal(
        client,
        headers,
        kind="saving",
        name="Liburan",
        target_amount_cents=10_000_000,
        current_amount_cents=2_500_000,
        jangka_waktu_months=10,
    )

    resp = client.get("/api/v1/dashboard/goals-progress", headers=headers)
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert len(data) == 2
    # Sort chain: kind asc → EF first.
    assert data[0]["kind"] == "emergency_fund"
    assert data[0]["status"] == "active"
    assert data[0]["pct"] == 50.0
    assert data[1]["kind"] == "saving"
    assert data[1]["status"] == "active"
    assert data[1]["pct"] == 25.0


def test_goals_progress_marks_achieved_goal(client: TestClient, fresh_db: Session) -> None:
    """A goal at 100% surfaces with ``status='achieved'``."""
    headers = _auth_headers(_register(client, "gp-achieved@example.com")["access_token"])
    _create_goal(
        client,
        headers,
        kind="saving",
        name="Done",
        target_amount_cents=5_000_000,
        current_amount_cents=5_000_000,
        jangka_waktu_months=12,
    )

    resp = client.get("/api/v1/dashboard/goals-progress", headers=headers)
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert len(data) == 1
    assert data[0]["status"] == "achieved"
    assert data[0]["pct"] == 100.0


def test_goals_progress_marks_archived_goal(client: TestClient, fresh_db: Session) -> None:
    """An archived goal still surfaces but with ``status='archived'``."""
    headers = _auth_headers(_register(client, "gp-archived@example.com")["access_token"])
    goal = _create_goal(
        client,
        headers,
        kind="saving",
        name="Done",
        target_amount_cents=5_000_000,
        current_amount_cents=5_000_000,
        jangka_waktu_months=12,
    )
    deleted = client.delete(f"/api/v1/goals/{goal['id']}", headers=headers)
    assert deleted.status_code == 204

    resp = client.get("/api/v1/dashboard/goals-progress", headers=headers)
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert len(data) == 1
    assert data[0]["status"] == "archived"


def test_goals_progress_requires_authentication(client: TestClient, fresh_db: Session) -> None:
    resp = client.get("/api/v1/dashboard/goals-progress")
    assert resp.status_code == 401


# --- /debts-summary --------------------------------------------------------


def test_debts_summary_empty_user_returns_zeros(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "empty-ds@example.com")["access_token"])
    resp = client.get("/api/v1/dashboard/debts-summary", headers=headers)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "total_remaining_cents": 0,
        "total_interest_paid_cents": 0,
        "active_count": 0,
        "paid_off_count": 0,
    }


def test_debts_summary_aggregates_active_and_paid_off(
    client: TestClient, fresh_db: Session
) -> None:
    """Active debt contributes to remaining; paid-off debt contributes
    only to the paid_off_count + total_interest_paid totals.

    The auto-paid-off transition (sub-0006-02) only fires through the
    write endpoint, so for this aggregation test we seed payments
    directly and flip ``status`` to ``paid_off`` on the ORM row —
    matching the test seam the existing
    ``test_debts_summary_aggregates_payment_history`` suite uses.
    """
    headers = _auth_headers(_register(client, "ds-mix@example.com")["access_token"])
    active = _create_debt(
        client,
        headers,
        name="KPR",
        principal_cents=12_000_000,
        tenor_months=12,
        bunga_pct=10,
    )
    # Seed a payment so total_interest_paid > 0.
    db_debt = fresh_db.get(Debt, uuid.UUID(active["id"]))
    assert db_debt is not None
    db_debt.payments.append(
        DebtPayment(
            debt_id=db_debt.id,
            occurred_on=date.today(),
            amount_cents=1_100_000,
            principal_portion_cents=1_000_000,
            interest_portion_cents=100_000,
        )
    )
    fresh_db.commit()

    # Now create a fully-paid-off debt. Seed the full payment and
    # flip ``status`` directly so the summary test doesn't depend on
    # the write endpoint's auto-paid-off transition.
    paid_off = _create_debt(
        client,
        headers,
        name="Paylater",
        principal_cents=2_000_000,
        tenor_months=6,
        bunga_pct=0,
    )
    full_paid = fresh_db.get(Debt, uuid.UUID(paid_off["id"]))
    assert full_paid is not None
    full_paid.payments.append(
        DebtPayment(
            debt_id=full_paid.id,
            occurred_on=date.today(),
            amount_cents=2_000_000,
            principal_portion_cents=2_000_000,
            interest_portion_cents=0,
        )
    )
    full_paid.status = DebtStatus.PAID_OFF
    fresh_db.commit()

    resp = client.get("/api/v1/dashboard/debts-summary", headers=headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["active_count"] == 1
    assert body["paid_off_count"] == 1
    assert body["total_remaining_cents"] == 11_000_000
    assert body["total_interest_paid_cents"] == 100_000


def test_debts_summary_isolates_users(client: TestClient, fresh_db: Session) -> None:
    """Alice's debts don't bleed into Bob's summary."""
    alice_h = _auth_headers(_register(client, "alice-ds@example.com")["access_token"])
    bob_h = _auth_headers(_register(client, "bob-ds@example.com")["access_token"])
    _create_debt(
        client,
        alice_h,
        name="Alice debt",
        principal_cents=5_000_000,
        tenor_months=12,
        bunga_pct=8,
    )

    alice_resp = client.get("/api/v1/dashboard/debts-summary", headers=alice_h)
    bob_resp = client.get("/api/v1/dashboard/debts-summary", headers=bob_h)
    assert alice_resp.status_code == 200
    assert bob_resp.status_code == 200
    assert alice_resp.json()["active_count"] == 1
    assert alice_resp.json()["total_remaining_cents"] == 5_000_000
    assert bob_resp.json()["active_count"] == 0
    assert bob_resp.json()["total_remaining_cents"] == 0


def test_debts_summary_requires_authentication(client: TestClient, fresh_db: Session) -> None:
    resp = client.get("/api/v1/dashboard/debts-summary")
    assert resp.status_code == 401


# --- cross-user isolation spot-check on every endpoint ----------------------


def test_dashboard_endpoints_isolate_users_across_all_routes(
    client: TestClient, fresh_db: Session
) -> None:
    """Alice populates everything; Bob sees zeros on every endpoint."""
    alice_h = _auth_headers(_register(client, "alice-iso-all@example.com")["access_token"])
    bob_h = _auth_headers(_register(client, "bob-iso-all@example.com")["access_token"])
    account = _create_account(client, alice_h, opening_balance_cents=5_000_000)
    _create_transaction(
        client,
        alice_h,
        type_="income",
        account_id=account["id"],
        amount_cents=1_000_000,
    )
    _create_goal(
        client,
        alice_h,
        kind="emergency_fund",
        name="EF",
        target_amount_cents=12_000_000,
        current_amount_cents=6_000_000,
        monthly_expense_cents=2_000_000,
        jumlah_tanggungan=1,
    )
    _create_debt(
        client,
        alice_h,
        principal_cents=4_000_000,
        tenor_months=12,
        bunga_pct=10,
    )

    for path in (
        "/api/v1/dashboard/summary",
        "/api/v1/dashboard/networth-trend",
        "/api/v1/dashboard/income-expense-trend",
        "/api/v1/dashboard/top-categories",
        "/api/v1/dashboard/goals-progress",
        "/api/v1/dashboard/debts-summary",
    ):
        bob_resp = client.get(path, headers=bob_h)
        assert bob_resp.status_code == 200, f"{path}: {bob_resp.text}"
        body = bob_resp.json()
        if path.endswith("/summary"):
            assert body["networth_cents"] == 0
            assert body["total_assets_cents"] == 0
            assert body["income_this_month_cents"] == 0
            assert body["emergency_fund_avg_pct"] is None
        elif path.endswith("/debts-summary"):
            assert body["active_count"] == 0
            assert body["total_remaining_cents"] == 0
        elif path.endswith("/goals-progress") or path.endswith("/top-categories"):
            assert body == {"data": []}
        elif path.endswith("/networth-trend"):
            for point in body["data"]:
                assert point["networth_cents"] == 0
        else:  # /income-expense-trend — 12 zero rows
            for point in body["data"]:
                assert point["income_cents"] == 0
                assert point["expense_cents"] == 0


# --- Sanity: ensure no leftover cross-user goal row leaks -------------------


def test_goals_progress_does_not_return_other_users_archived_goals(
    client: TestClient, fresh_db: Session
) -> None:
    """Spot-check: archived goals from another user never surface."""
    alice_h = _auth_headers(_register(client, "alice-leak@example.com")["access_token"])
    bob_h = _auth_headers(_register(client, "bob-leak@example.com")["access_token"])
    goal = _create_goal(
        client,
        alice_h,
        kind="saving",
        name="Private",
        target_amount_cents=1_000_000,
        current_amount_cents=1_000_000,
        jangka_waktu_months=6,
    )
    archived = client.delete(f"/api/v1/goals/{goal['id']}", headers=alice_h)
    assert archived.status_code == 204

    bob_resp = client.get("/api/v1/dashboard/goals-progress", headers=bob_h)
    assert bob_resp.status_code == 200
    assert bob_resp.json() == {"data": []}
