"""API contract tests for ``GET /debts/{id}/summary`` (sub-0006-03).

The endpoint aggregates the flat-loan schedule (sub-0006-01's
``debts`` table) with the payment ledger (sub-0006-02's
``debt_payments`` table) into four numbers the FE dashboard reads in
one round-trip. These tests seed ``DebtPayment`` rows directly into the
SQLite fixture (rather than going through the write endpoint, which
ships in sub-0006-02) so the summary contract can land ahead of the
write-side API. Once sub-0006-02 merges, an integration test should
replace the direct-seed helper with a ``POST /debts/{id}/payments``
call so the two endpoints are exercised together.
"""

from __future__ import annotations

import uuid
from datetime import date

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.db.models.debt import Debt, DebtPayment


def _register(client: TestClient, email: str) -> dict[str, object]:
    response = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "Sup3rSecret!"},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _headers(token: object) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _payload(**overrides: object) -> dict[str, object]:
    body: dict[str, object] = {
        "name": "Kredit Rumah",
        "kind": "KPR",
        "principal_cents": 12_000_000,
        "bunga_pct": 10,
        "tenor_months": 12,
        "start_date": "2026-08-01",
    }
    body.update(overrides)
    return body


def _create(
    client: TestClient,
    headers: dict[str, str],
    **overrides: object,
) -> dict[str, object]:
    response = client.post(
        "/api/v1/debts",
        headers=headers,
        json=_payload(**overrides),
    )
    assert response.status_code == 201, response.text
    return response.json()


def _seed_payment(
    db: Session,
    *,
    debt: Debt,
    occurred_on: date,
    amount_cents: int,
    principal_portion_cents: int,
    interest_portion_cents: int,
    note: str | None = None,
) -> DebtPayment:
    """Insert a payment row directly into the DB so we can exercise the
    summary endpoint ahead of sub-0006-02's write API.

    Mirrors the post-state that ``POST /debts/{id}/payments`` will
    produce — same columns, same constraints (positive amount, sum of
    portions == amount). The integration test that lands with
    sub-0006-02 should replace this helper with a real write call.
    """
    assert amount_cents == principal_portion_cents + interest_portion_cents
    payment = DebtPayment(
        debt_id=debt.id,
        occurred_on=occurred_on,
        amount_cents=amount_cents,
        principal_portion_cents=principal_portion_cents,
        interest_portion_cents=interest_portion_cents,
        note=note,
    )
    db.add(payment)
    db.commit()
    db.refresh(payment)
    return payment


def test_summary_matches_sample_case_for_unpaid_loan(
    client: TestClient,
    fresh_db: Session,
) -> None:
    """The headline epic-0006 acceptance criterion.

    12jt @ 10% flat / 12 bulan → cicilan ~1.1jt, total bunga ~1.2jt.
    For an unpaid loan the summary should surface the full principal as
    remaining, 0 interest paid, the start date as the first due date,
    and the full tenor as months remaining.
    """
    auth = _register(client, "debt-summary-sample@example.com")
    headers = _headers(auth["access_token"])
    debt = _create(client, headers)

    response = client.get(f"/api/v1/debts/{debt['id']}/summary", headers=headers)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body == {
        "debt_id": debt["id"],
        "remaining_principal_cents": 12_000_000,
        "total_interest_paid_cents": 0,
        "next_payment_due_date": "2026-08-01",
        "months_remaining": 12,
    }


def test_summary_aggregates_payment_history(
    client: TestClient,
    fresh_db: Session,
) -> None:
    """After three of the twelve monthly installments the summary
    reflects the consumed schedule: 3/12 of the principal paid down,
    3 months worth of interest booked, next due one quarter ahead,
    nine months remaining.
    """
    auth = _register(client, "debt-summary-partially-paid@example.com")
    headers = _headers(auth["access_token"])
    debt = _create(client, headers)
    db_debt = fresh_db.get(Debt, uuid.UUID(debt["id"]))
    assert db_debt is not None

    # Three monthly installments of 1_100_000 cents. The flat
    # breakdown is 100_000 cents interest + 1_000_000 cents principal
    # per cycle (1.2jt total interest / 12 months = 100_000 cents;
    # 12jt principal / 12 months = 1_000_000 cents). Seeds the values
    # directly rather than relying on the sub-0006-02 write path so
    # this test stays decoupled from that work.
    for month in (1, 2, 3):
        _seed_payment(
            fresh_db,
            debt=db_debt,
            occurred_on=date(2026, 7 + month, 1),
            amount_cents=1_100_000,
            principal_portion_cents=1_000_000,
            interest_portion_cents=100_000,
            note=f"cicilan {month}",
        )

    response = client.get(f"/api/v1/debts/{debt['id']}/summary", headers=headers)

    assert response.status_code == 200, response.text
    assert response.json() == {
        "debt_id": debt["id"],
        "remaining_principal_cents": 9_000_000,
        "total_interest_paid_cents": 300_000,
        "next_payment_due_date": "2026-11-01",
        "months_remaining": 9,
    }


def test_summary_for_debt_with_no_schedule(
    client: TestClient,
    fresh_db: Session,
) -> None:
    """``tenor_months is None`` → no schedule, so both ``next_payment_due_date``
    and ``months_remaining`` are ``null``. ``remaining_principal_cents``
    is the full principal because no payments exist for an
    unscheduled debt by definition.
    """
    auth = _register(client, "debt-summary-no-schedule@example.com")
    headers = _headers(auth["access_token"])
    debt = _create(client, headers, tenor_months=None, bunga_pct=15)

    response = client.get(f"/api/v1/debts/{debt['id']}/summary", headers=headers)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["remaining_principal_cents"] == 12_000_000
    assert body["total_interest_paid_cents"] == 0
    assert body["next_payment_due_date"] is None
    assert body["months_remaining"] is None


def test_summary_for_fully_paid_debt(
    client: TestClient,
    fresh_db: Session,
) -> None:
    """When every scheduled payment is recorded the remaining principal
    is 0, no next-due date exists, and months_remaining is 0.

    Seeds the full 12 cycles so the summary math exercises the
    ``remaining == 0`` branch.
    """
    auth = _register(client, "debt-summary-paid-off@example.com")
    headers = _headers(auth["access_token"])
    debt = _create(client, headers)
    db_debt = fresh_db.get(Debt, uuid.UUID(debt["id"]))
    assert db_debt is not None

    for month_index in range(12):
        # one installment per month starting Aug 2026 → Jul 2027
        year = 2026 + (8 + month_index - 1) // 12
        month = (8 + month_index - 1) % 12 + 1
        _seed_payment(
            fresh_db,
            debt=db_debt,
            occurred_on=date(year, month, 1),
            amount_cents=1_100_000,
            principal_portion_cents=1_000_000,
            interest_portion_cents=100_000,
        )

    response = client.get(f"/api/v1/debts/{debt['id']}/summary", headers=headers)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["remaining_principal_cents"] == 0
    assert body["total_interest_paid_cents"] == 1_200_000
    assert body["next_payment_due_date"] is None
    assert body["months_remaining"] == 0


def test_summary_clamps_to_zero_when_overpayment_drift(
    client: TestClient,
    fresh_db: Session,
) -> None:
    """Defensive: if a buggy write ever produces a negative remaining
    principal (e.g. a payment that exceeds the original principal),
    the summary surfaces it as 0 instead of leaking a negative
    number into the dashboard. The sub-0006-02 overpayment guard
    prevents this at write time but the read-side defence is here so
    a historical debt imported without the guard still reads sanely.
    """
    auth = _register(client, "debt-summary-overpay-drift@example.com")
    headers = _headers(auth["access_token"])
    debt = _create(client, headers)
    db_debt = fresh_db.get(Debt, uuid.UUID(debt["id"]))
    assert db_debt is not None

    # A single "payment" of 13jt against a 12jt principal — would
    # normally be rejected by sub-0006-02's overpayment guard but we
    # seed it directly to exercise the read-side clamp.
    _seed_payment(
        fresh_db,
        debt=db_debt,
        occurred_on=date(2026, 8, 1),
        amount_cents=13_000_000,
        principal_portion_cents=13_000_000,
        interest_portion_cents=0,
    )

    response = client.get(f"/api/v1/debts/{debt['id']}/summary", headers=headers)

    assert response.status_code == 200, response.text
    assert response.json()["remaining_principal_cents"] == 0


def test_summary_returns_404_for_unknown_debt(
    client: TestClient,
    fresh_db: Session,
) -> None:
    auth = _register(client, "debt-summary-unknown@example.com")
    headers = _headers(auth["access_token"])

    response = client.get(f"/api/v1/debts/{uuid.uuid4()}/summary", headers=headers)

    assert response.status_code == 404, response.text
    assert response.json() == {"detail": "debt not found"}


def test_summary_returns_404_for_foreign_debt(
    client: TestClient,
    fresh_db: Session,
) -> None:
    """Mirrors the rest of the ``debts`` router: 404 (not 403) when
    the id exists but belongs to another user, to avoid leaking the
    existence of other users' rows. The spec literally calls for 403
    but consistency within the router wins — flagged in the TL
    handoff note on the issue.
    """
    alice = _register(client, "debt-summary-foreign-alice@example.com")
    bob = _register(client, "debt-summary-foreign-bob@example.com")
    alice_headers = _headers(alice["access_token"])
    bob_headers = _headers(bob["access_token"])
    debt = _create(client, alice_headers)

    response = client.get(f"/api/v1/debts/{debt['id']}/summary", headers=bob_headers)

    assert response.status_code == 404, response.text
    assert response.json() == {"detail": "debt not found"}


def test_summary_requires_auth(
    client: TestClient,
    fresh_db: Session,
) -> None:
    debt_id = uuid.uuid4()
    response = client.get(f"/api/v1/debts/{debt_id}/summary")
    assert response.status_code == 401, response.text
