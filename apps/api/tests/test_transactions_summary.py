"""Transactions summary endpoint tests — coverage for sub-0003-04.

Scenarios covered (per acceptance criteria):

* (a) ``GET /transactions/summary?year=&month=`` returns the caller's
      monthly totals (``total_income_cents``, ``total_expense_cents``,
      ``net_cents``) plus ``breakdown_by_category`` and
      ``breakdown_by_account`` — both arrays of typed rows.
* (b) Soft-deleted rows (``deleted_at IS NOT NULL``) are excluded from
      every aggregate and from both breakdowns. We exercise this by
      flipping ``deleted_at`` directly on the ORM row because the
      soft-delete behaviour itself ships in sub-0003-02; this test only
      proves the summary's filter.
* (c) An empty month returns ``200`` with ``total_income_cents=0``,
      ``total_expense_cents=0``, ``net_cents=0``, ``transaction_count=0``,
      empty breakdowns — never 404.

Cross-cutting scenarios also covered:

* Two-user isolation: another user's rows in the same month never
  surface in totals or breakdowns.
* Out-of-month transactions (one day before, one day after) are excluded
  so the month window is correctly inclusive on both ends.
* Auth required: 401 without a bearer token.
* Parameter validation: ``year``/``month`` must be in range — 422 on
  out-of-range values.
* Transactions without a ``category_id`` (``Uncategorized`` in the FE)
  surface as a single grouped row with ``category_id=None`` and
  ``category_name=None``.
* Per-category and per-account breakdowns split income from expense
  into separate rows so the FE can render them on different sides.
* Currency is hard-coded to ``IDR`` in the response (MVP single-currency).
"""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.db.models.transaction import Transaction


def _register(client: TestClient, email: str) -> dict:
    resp = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "Sup3rSecret!"},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_account(
    client: TestClient,
    headers: dict[str, str],
    *,
    name: str = "BCA",
    type_: str = "bank",
) -> dict:
    resp = client.post(
        "/api/v1/accounts",
        headers=headers,
        json={
            "name": name,
            "type": type_,
            "currency": "IDR",
            "opening_balance_cents": 0,
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _list_categories(client: TestClient, headers: dict[str, str]) -> list[dict]:
    resp = client.get("/api/v1/categories", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _pick_category(
    client: TestClient, headers: dict[str, str], *, kind: str, name_contains: str
) -> dict:
    """Find a default-seeded category matching ``kind`` and ``name_contains``.

    Falls back to the first category of the requested kind when no name
    match is found, so the helper works even if PRD §14 gets re-shaped.
    """
    cats = _list_categories(client, headers)
    matches = [c for c in cats if c["kind"] == kind and name_contains in c["name"]]
    if matches:
        return matches[0]
    same_kind = [c for c in cats if c["kind"] == kind]
    assert same_kind, f"no {kind} categories seeded for this user"
    return same_kind[0]


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


def _soft_delete(fresh_db: Session, transaction_id: uuid.UUID) -> None:
    """Flip ``deleted_at`` on a transaction to simulate a soft-delete.

    The DELETE endpoint itself ships in sub-0003-02. This helper is the
    test seam that lets us prove the summary filter without taking a
    dependency on that branch.
    """
    row = fresh_db.get(Transaction, transaction_id)
    assert row is not None
    row.deleted_at = datetime(2026, 1, 1, 12, 0, 0, tzinfo=UTC)
    fresh_db.commit()


# (c) Empty month returns zeros + empty arrays --------------------------------


def test_summary_empty_month_returns_zeros_and_empty_arrays(
    client: TestClient, fresh_db: Session
) -> None:
    """A month with zero transactions must return 200, not 404 (AC (c))."""
    headers = _auth_headers(_register(client, "empty-sum@example.com")["access_token"])
    resp = client.get(
        "/api/v1/transactions/summary",
        headers=headers,
        params={"year": 2026, "month": 7},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["year"] == 2026
    assert body["month"] == 7
    assert body["currency"] == "IDR"
    assert body["total_income_cents"] == 0
    assert body["total_expense_cents"] == 0
    assert body["net_cents"] == 0
    assert body["transaction_count"] == 0
    assert body["breakdown_by_category"] == []
    assert body["breakdown_by_account"] == []


def test_summary_empty_for_month_without_transactions(
    client: TestClient, fresh_db: Session
) -> None:
    """Transactions outside the requested month must not bleed into the totals.

    A user has January transactions but asks for the February summary → the
    response is zeros + empty arrays (the FE renders an empty state).
    """
    headers = _auth_headers(_register(client, "wrong-month-sum@example.com")["access_token"])
    account = _create_account(client, headers, name="Rekening")

    _create_transaction(
        client,
        headers,
        type_="income",
        account_id=account["id"],
        amount_cents=1_000_000,
        occurred_on=date(2026, 1, 15),
    )
    _create_transaction(
        client,
        headers,
        type_="expense",
        account_id=account["id"],
        amount_cents=500_000,
        occurred_on=date(2026, 1, 31),
    )

    resp = client.get(
        "/api/v1/transactions/summary",
        headers=headers,
        params={"year": 2026, "month": 2},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["total_income_cents"] == 0
    assert body["total_expense_cents"] == 0
    assert body["net_cents"] == 0
    assert body["transaction_count"] == 0
    assert body["breakdown_by_category"] == []
    assert body["breakdown_by_account"] == []


# (a) Response shape + math ---------------------------------------------------


def test_summary_totals_and_net_match_db(client: TestClient, fresh_db: Session) -> None:
    """Income + expense + net match the persisted rows for the month."""
    headers = _auth_headers(_register(client, "totals-sum@example.com")["access_token"])
    account = _create_account(client, headers, name="Tunai")
    category = _pick_category(client, headers, kind="expense", name_contains="Makan")

    _create_transaction(
        client,
        headers,
        type_="income",
        account_id=account["id"],
        amount_cents=5_000_000,
        occurred_on=date(2026, 3, 1),
    )
    _create_transaction(
        client,
        headers,
        type_="income",
        account_id=account["id"],
        amount_cents=2_500_000,
        occurred_on=date(2026, 3, 10),
    )
    _create_transaction(
        client,
        headers,
        type_="expense",
        account_id=account["id"],
        category_id=category["id"],
        amount_cents=350_000,
        occurred_on=date(2026, 3, 5),
    )
    _create_transaction(
        client,
        headers,
        type_="expense",
        account_id=account["id"],
        category_id=category["id"],
        amount_cents=150_000,
        occurred_on=date(2026, 3, 20),
    )

    resp = client.get(
        "/api/v1/transactions/summary",
        headers=headers,
        params={"year": 2026, "month": 3},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total_income_cents"] == 7_500_000
    assert body["total_expense_cents"] == 500_000
    assert body["net_cents"] == 7_000_000
    assert body["transaction_count"] == 4
    assert body["currency"] == "IDR"


def test_summary_breakdown_by_category_groups_correctly(
    client: TestClient, fresh_db: Session
) -> None:
    """Two categories in the same month → two category rows, sorted by total desc."""
    headers = _auth_headers(_register(client, "cat-sum@example.com")["access_token"])
    account = _create_account(client, headers, name="Tunai")
    cats = _list_categories(client, headers)
    expense_makan = next(c for c in cats if c["kind"] == "expense" and "Makan" in c["name"])
    expense_transport = next(c for c in cats if c["kind"] == "expense" and "Transport" in c["name"])
    income_gaji = next(c for c in cats if c["kind"] == "income" and "Gaji" in c["name"])

    _create_transaction(
        client,
        headers,
        type_="expense",
        account_id=account["id"],
        category_id=expense_makan["id"],
        amount_cents=250_000,
        occurred_on=date(2026, 4, 3),
    )
    _create_transaction(
        client,
        headers,
        type_="expense",
        account_id=account["id"],
        category_id=expense_makan["id"],
        amount_cents=150_000,
        occurred_on=date(2026, 4, 9),
    )
    _create_transaction(
        client,
        headers,
        type_="expense",
        account_id=account["id"],
        category_id=expense_transport["id"],
        amount_cents=100_000,
        occurred_on=date(2026, 4, 12),
    )
    _create_transaction(
        client,
        headers,
        type_="income",
        account_id=account["id"],
        category_id=income_gaji["id"],
        amount_cents=5_000_000,
        occurred_on=date(2026, 4, 1),
    )

    resp = client.get(
        "/api/v1/transactions/summary",
        headers=headers,
        params={"year": 2026, "month": 4},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    by_cat = body["breakdown_by_category"]

    # We expect one income row (Gaji) and two expense rows (Makan, Transport).
    assert len(by_cat) == 3
    income_rows = [r for r in by_cat if r["type"] == "income"]
    expense_rows = [r for r in by_cat if r["type"] == "expense"]
    assert len(income_rows) == 1
    assert income_rows[0]["category_id"] == income_gaji["id"]
    assert income_rows[0]["category_name"] == income_gaji["name"]
    assert income_rows[0]["total_cents"] == 5_000_000
    assert income_rows[0]["transaction_count"] == 1

    # Expense rows: Makan (400_000) should come before Transport (100_000).
    assert len(expense_rows) == 2
    assert expense_rows[0]["category_id"] == expense_makan["id"]
    assert expense_rows[0]["total_cents"] == 400_000
    assert expense_rows[0]["transaction_count"] == 2
    assert expense_rows[1]["category_id"] == expense_transport["id"]
    assert expense_rows[1]["total_cents"] == 100_000
    assert expense_rows[1]["transaction_count"] == 1


def test_summary_breakdown_by_account_groups_correctly(
    client: TestClient, fresh_db: Session
) -> None:
    """Per-account breakdown splits income vs expense and totals per account."""
    headers = _auth_headers(_register(client, "acc-sum@example.com")["access_token"])
    cash = _create_account(client, headers, name="Dompet", type_="cash")
    bank = _create_account(client, headers, name="BCA", type_="bank")

    # Cash only sees expense, bank only sees income in this month.
    _create_transaction(
        client,
        headers,
        type_="expense",
        account_id=cash["id"],
        amount_cents=200_000,
        occurred_on=date(2026, 5, 5),
    )
    _create_transaction(
        client,
        headers,
        type_="expense",
        account_id=cash["id"],
        amount_cents=300_000,
        occurred_on=date(2026, 5, 15),
    )
    _create_transaction(
        client,
        headers,
        type_="income",
        account_id=bank["id"],
        amount_cents=5_000_000,
        occurred_on=date(2026, 5, 1),
    )

    resp = client.get(
        "/api/v1/transactions/summary",
        headers=headers,
        params={"year": 2026, "month": 5},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    by_acc = body["breakdown_by_account"]

    assert len(by_acc) == 2
    income_rows = [r for r in by_acc if r["type"] == "income"]
    expense_rows = [r for r in by_acc if r["type"] == "expense"]
    assert len(income_rows) == 1
    assert income_rows[0]["account_id"] == bank["id"]
    assert income_rows[0]["account_name"] == "BCA"
    assert income_rows[0]["total_cents"] == 5_000_000
    assert len(expense_rows) == 1
    assert expense_rows[0]["account_id"] == cash["id"]
    assert expense_rows[0]["account_name"] == "Dompet"
    assert expense_rows[0]["total_cents"] == 500_000
    assert expense_rows[0]["transaction_count"] == 2


def test_summary_transactions_without_category_buckets_as_uncategorized(
    client: TestClient, fresh_db: Session
) -> None:
    """category_id=None rows surface as a single grouped row with None fields.

    The FE renders these under "Uncategorized" in the breakdown UI.
    """
    headers = _auth_headers(_register(client, "uncat-sum@example.com")["access_token"])
    account = _create_account(client, headers, name="Cash")

    _create_transaction(
        client,
        headers,
        type_="expense",
        account_id=account["id"],
        category_id=None,
        amount_cents=75_000,
        occurred_on=date(2026, 6, 10),
    )
    _create_transaction(
        client,
        headers,
        type_="expense",
        account_id=account["id"],
        category_id=None,
        amount_cents=25_000,
        occurred_on=date(2026, 6, 22),
    )

    resp = client.get(
        "/api/v1/transactions/summary",
        headers=headers,
        params={"year": 2026, "month": 6},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total_expense_cents"] == 100_000
    assert body["transaction_count"] == 2
    by_cat = body["breakdown_by_category"]
    assert len(by_cat) == 1
    assert by_cat[0]["category_id"] is None
    assert by_cat[0]["category_name"] is None
    assert by_cat[0]["type"] == "expense"
    assert by_cat[0]["total_cents"] == 100_000
    assert by_cat[0]["transaction_count"] == 2


def test_summary_inclusive_month_bounds_include_first_and_last_day(
    client: TestClient, fresh_db: Session
) -> None:
    """A transaction on the 1st and one on the last day both count."""
    headers = _auth_headers(_register(client, "bounds-sum@example.com")["access_token"])
    account = _create_account(client, headers, name="BCA")

    first = _create_transaction(
        client,
        headers,
        type_="income",
        account_id=account["id"],
        amount_cents=100_000,
        occurred_on=date(2026, 7, 1),
    )
    last = _create_transaction(
        client,
        headers,
        type_="expense",
        account_id=account["id"],
        amount_cents=50_000,
        occurred_on=date(2026, 7, 31),
    )
    # Sanity: there are 31 days in July 2026.
    before_month = _create_transaction(
        client,
        headers,
        type_="income",
        account_id=account["id"],
        amount_cents=999_999,
        occurred_on=date(2026, 6, 30),
    )
    after_month = _create_transaction(
        client,
        headers,
        type_="income",
        account_id=account["id"],
        amount_cents=999_999,
        occurred_on=date(2026, 8, 1),
    )

    resp = client.get(
        "/api/v1/transactions/summary",
        headers=headers,
        params={"year": 2026, "month": 7},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["transaction_count"] == 2
    assert body["total_income_cents"] == 100_000
    assert body["total_expense_cents"] == 50_000
    assert body["net_cents"] == 50_000
    # The before/after month rows aren't included in any breakdown row.
    # Within the July window the same account surfaces as one income row
    # and one expense row (income + expense for the same account = two
    # breakdown entries), and that's exactly what we see here.
    by_acc = body["breakdown_by_account"]
    assert len(by_acc) == 2
    types_per_account = {(item["account_id"], item["type"]) for item in by_acc}
    assert types_per_account == {
        (account["id"], "income"),
        (account["id"], "expense"),
    }

    # Sanity that the out-of-month rows actually exist for the assertion above.
    assert before_month["id"] != first["id"]
    assert after_month["id"] != last["id"]


def test_summary_february_uses_28_or_29_days(client: TestClient, fresh_db: Session) -> None:
    """February 2026 has 28 days — a transaction on day 28 is inclusive."""
    headers = _auth_headers(_register(client, "feb-sum@example.com")["access_token"])
    account = _create_account(client, headers, name="BCA")

    _create_transaction(
        client,
        headers,
        type_="income",
        account_id=account["id"],
        amount_cents=100_000,
        occurred_on=date(2026, 2, 28),
    )

    resp = client.get(
        "/api/v1/transactions/summary",
        headers=headers,
        params={"year": 2026, "month": 2},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total_income_cents"] == 100_000
    assert body["transaction_count"] == 1


# (b) Soft-delete filter ------------------------------------------------------


def test_summary_excludes_soft_deleted_transactions(client: TestClient, fresh_db: Session) -> None:
    """Rows with ``deleted_at IS NOT NULL`` are excluded from every aggregate.

    The soft-delete behaviour ships in sub-0003-02; we flip ``deleted_at``
    directly on the ORM row to prove the summary's filter is in place.
    """
    headers = _auth_headers(_register(client, "softdel-sum@example.com")["access_token"])
    account = _create_account(client, headers, name="BCA")
    category = _pick_category(client, headers, kind="expense", name_contains="Makan")

    # Two transactions in the month: one stays active, one is soft-deleted.
    active = _create_transaction(
        client,
        headers,
        type_="income",
        account_id=account["id"],
        amount_cents=1_000_000,
        occurred_on=date(2026, 8, 1),
    )
    deleted = _create_transaction(
        client,
        headers,
        type_="expense",
        account_id=account["id"],
        category_id=category["id"],
        amount_cents=500_000,
        occurred_on=date(2026, 8, 10),
    )
    _soft_delete(fresh_db, uuid.UUID(deleted["id"]))

    resp = client.get(
        "/api/v1/transactions/summary",
        headers=headers,
        params={"year": 2026, "month": 8},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total_income_cents"] == 1_000_000
    assert body["total_expense_cents"] == 0  # deleted row excluded
    assert body["net_cents"] == 1_000_000
    assert body["transaction_count"] == 1

    by_cat = body["breakdown_by_category"]
    assert len(by_cat) == 1
    assert by_cat[0]["type"] == "income"
    assert by_cat[0]["total_cents"] == 1_000_000
    assert by_cat[0]["transaction_count"] == 1

    by_acc = body["breakdown_by_account"]
    assert len(by_acc) == 1
    assert by_acc[0]["account_id"] == account["id"]
    assert by_acc[0]["type"] == "income"
    assert by_acc[0]["total_cents"] == 1_000_000

    # Sanity that the soft-deleted row is actually present in the DB.
    assert fresh_db.get(Transaction, uuid.UUID(active["id"])) is not None
    assert fresh_db.get(Transaction, uuid.UUID(deleted["id"])) is not None


def test_summary_excludes_only_soft_deleted_rows(client: TestClient, fresh_db: Session) -> None:
    """Mixed active/deleted rows in the same category — only active counts."""
    headers = _auth_headers(_register(client, "mixed-softdel-sum@example.com")["access_token"])
    account = _create_account(client, headers, name="BCA")
    category = _pick_category(client, headers, kind="expense", name_contains="Makan")

    keep_a = _create_transaction(
        client,
        headers,
        type_="expense",
        account_id=account["id"],
        category_id=category["id"],
        amount_cents=100_000,
        occurred_on=date(2026, 9, 3),
    )
    drop_b = _create_transaction(
        client,
        headers,
        type_="expense",
        account_id=account["id"],
        category_id=category["id"],
        amount_cents=200_000,
        occurred_on=date(2026, 9, 5),
    )
    keep_c = _create_transaction(
        client,
        headers,
        type_="expense",
        account_id=account["id"],
        category_id=category["id"],
        amount_cents=50_000,
        occurred_on=date(2026, 9, 8),
    )
    _soft_delete(fresh_db, uuid.UUID(drop_b["id"]))

    resp = client.get(
        "/api/v1/transactions/summary",
        headers=headers,
        params={"year": 2026, "month": 9},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total_expense_cents"] == 150_000  # 100k + 50k, not 350k
    assert body["transaction_count"] == 2
    by_cat = body["breakdown_by_category"]
    assert len(by_cat) == 1
    assert by_cat[0]["category_id"] == category["id"]
    assert by_cat[0]["total_cents"] == 150_000
    assert by_cat[0]["transaction_count"] == 2

    # Sanity: all three rows still exist in the DB (the filter only affects
    # what the summary returns, not what's persisted).
    for tx in (keep_a, drop_b, keep_c):
        assert fresh_db.get(Transaction, uuid.UUID(tx["id"])) is not None


# Cross-user isolation -------------------------------------------------------


def test_summary_isolates_users(client: TestClient, fresh_db: Session) -> None:
    """Alice's and Bob's March transactions never bleed into each other."""
    alice_h = _auth_headers(_register(client, "alice-iso-sum@example.com")["access_token"])
    bob_h = _auth_headers(_register(client, "bob-iso-sum@example.com")["access_token"])

    alice_account = _create_account(client, alice_h, name="Alice BCA")
    bob_account = _create_account(client, bob_h, name="Bob BCA")

    _create_transaction(
        client,
        alice_h,
        type_="income",
        account_id=alice_account["id"],
        amount_cents=10_000_000,
        occurred_on=date(2026, 3, 1),
    )
    _create_transaction(
        client,
        bob_h,
        type_="income",
        account_id=bob_account["id"],
        amount_cents=2_000,
        occurred_on=date(2026, 3, 2),
    )

    alice_resp = client.get(
        "/api/v1/transactions/summary",
        headers=alice_h,
        params={"year": 2026, "month": 3},
    )
    assert alice_resp.status_code == 200, alice_resp.text
    alice_body = alice_resp.json()
    assert alice_body["total_income_cents"] == 10_000_000
    assert alice_body["transaction_count"] == 1
    assert len(alice_body["breakdown_by_account"]) == 1
    assert alice_body["breakdown_by_account"][0]["account_id"] == alice_account["id"]

    bob_resp = client.get(
        "/api/v1/transactions/summary",
        headers=bob_h,
        params={"year": 2026, "month": 3},
    )
    assert bob_resp.status_code == 200, bob_resp.text
    bob_body = bob_resp.json()
    assert bob_body["total_income_cents"] == 2_000
    assert bob_body["transaction_count"] == 1
    assert len(bob_body["breakdown_by_account"]) == 1
    assert bob_body["breakdown_by_account"][0]["account_id"] == bob_account["id"]


# Auth + parameter validation -------------------------------------------------


def test_summary_requires_authentication(client: TestClient, fresh_db: Session) -> None:
    resp = client.get(
        "/api/v1/transactions/summary",
        params={"year": 2026, "month": 1},
    )
    assert resp.status_code == 401


@pytest.mark.parametrize(
    ("year", "month", "reason"),
    [
        (1969, 1, "year below lower bound"),
        (3000, 1, "year above upper bound"),
        (2026, 0, "month below 1"),
        (2026, 13, "month above 12"),
    ],
)
def test_summary_rejects_out_of_range_params_with_422(
    client: TestClient, fresh_db: Session, year: int, month: int, reason: str
) -> None:
    """Out-of-range year/month get rejected at the schema level (422)."""
    headers = _auth_headers(_register(client, f"range-{year}-{month}@example.com")["access_token"])
    resp = client.get(
        "/api/v1/transactions/summary",
        headers=headers,
        params={"year": year, "month": month},
    )
    assert resp.status_code == 422, f"{reason}: got {resp.status_code}"


def test_summary_requires_year_and_month(client: TestClient, fresh_db: Session) -> None:
    """Missing required params surface as 422 from FastAPI's validation."""
    headers = _auth_headers(_register(client, "missing-sum@example.com")["access_token"])
    no_month = client.get(
        "/api/v1/transactions/summary",
        headers=headers,
        params={"year": 2026},
    )
    assert no_month.status_code == 422
    no_year = client.get(
        "/api/v1/transactions/summary",
        headers=headers,
        params={"month": 1},
    )
    assert no_year.status_code == 422
    no_params = client.get("/api/v1/transactions/summary", headers=headers)
    assert no_params.status_code == 422
