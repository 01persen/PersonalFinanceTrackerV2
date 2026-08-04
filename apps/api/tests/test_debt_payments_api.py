"""API contract tests for the debt payment CRUD endpoints (sub-0006-02).

The debt CRUD itself lives in ``test_debts.py``; this module focuses
on the ``/debts/{debt_id}/payments`` surface and the
auto-paid-off transitions it owns.

Coverage:

* Create — happy path, source account nullable, source account
  ownership check (404 for foreign / archived), source account 404
  for unknown id. Atomic status transition (paid_off when the
  payment brings remaining to exactly zero).
* Create — overpayment 422 (principal portion exceeds remaining),
  zero amount 422, zero principal AND zero interest 422,
  amount-split mismatch 422, paid-off debt 422, zero amount 422
  (Pydantic ``gt=0``), negative principal / interest 422.
* List — pagination + sort (newest first by ``occurred_on``, then
  ``created_at`` desc, then ``id`` asc — mirrors the deterministic
  chain on the transactions list endpoint), ownership-scoped
  (Bob can't see Alice's payments).
* Get — happy path + foreign-debt 404 + cross-user 404.
* Patch — happy path, partial fields, atomic status transition
  (paid-off → active on a decrease), overpayment 422, mismatch 422,
  amount-only edit 422, foreign-debt 404, source-account-ownership
  404, clear source account with ``null``.
* Delete — happy path + atomic status transition (paid-off → active
  when the last payment is deleted) + cross-user 404 + foreign-debt
  404.
* Atomicity — monkey-patched ``commit`` failure rolls back the
  payment + status change so the next read sees the pre-call state.
* Auth — every endpoint requires a Bearer token (401 without).
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.db.models.debt import Debt, DebtPayment
from app.db.models.enums import DebtStatus


def _register(client: TestClient, email: str) -> dict[str, object]:
    response = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "Sup3rSecret!"},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _headers(token: object) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_account(
    client: TestClient,
    headers: dict[str, str],
    *,
    name: str = "Bank BCA",
    opening_balance_cents: int = 0,
) -> dict[str, object]:
    response = client.post(
        "/api/v1/accounts",
        headers=headers,
        json={
            "name": name,
            "type": "bank",
            "currency": "IDR",
            "opening_balance_cents": opening_balance_cents,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def _create_debt(
    client: TestClient,
    headers: dict[str, str],
    *,
    principal_cents: int = 1_200_000,
    name: str = "Kredit Rumah",
) -> dict[str, object]:
    response = client.post(
        "/api/v1/debts",
        headers=headers,
        json={
            "name": name,
            "kind": "KPR",
            "principal_cents": principal_cents,
            "bunga_pct": 10,
            "tenor_months": 12,
            "start_date": "2026-08-01",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def _create_payment(
    client: TestClient,
    headers: dict[str, str],
    *,
    debt_id: str,
    principal_portion_cents: int = 100_000,
    interest_portion_cents: int = 10_000,
    source_account_id: str | None = None,
    occurred_on: str = "2026-09-01",
    note: str | None = None,
) -> dict[str, object]:
    payload: dict[str, object] = {
        "occurred_on": occurred_on,
        "amount_cents": principal_portion_cents + interest_portion_cents,
        "principal_portion_cents": principal_portion_cents,
        "interest_portion_cents": interest_portion_cents,
    }
    if source_account_id is not None:
        payload["source_account_id"] = source_account_id
    if note is not None:
        payload["note"] = note
    response = client.post(
        f"/api/v1/debts/{debt_id}/payments",
        headers=headers,
        json=payload,
    )
    assert response.status_code == 201, response.text
    return response.json()


# ---------------------------------------------------------------------------
# Create — happy path + nullable source account
# ---------------------------------------------------------------------------


def test_create_payment_with_source_account_returns_201_and_persists(
    client: TestClient,
    fresh_db: Session,
) -> None:
    auth = _register(client, "dp-create-source@example.com")
    headers = _headers(auth["access_token"])
    account = _create_account(client, headers)
    debt = _create_debt(client, headers)

    body = _create_payment(
        client,
        headers,
        debt_id=debt["id"],
        principal_portion_cents=100_000,
        interest_portion_cents=10_000,
        source_account_id=account["id"],
        note="Cicilan September",
    )

    assert set(body) == {
        "id",
        "debt_id",
        "occurred_on",
        "amount_cents",
        "principal_portion_cents",
        "interest_portion_cents",
        "source_account_id",
        "note",
        "created_at",
        "updated_at",
    }
    assert body["debt_id"] == debt["id"]
    assert body["occurred_on"] == "2026-09-01"
    assert body["amount_cents"] == 110_000
    assert body["principal_portion_cents"] == 100_000
    assert body["interest_portion_cents"] == 10_000
    assert body["source_account_id"] == account["id"]
    assert body["note"] == "Cicilan September"
    assert uuid.UUID(body["id"])

    # Persisted in the DB.
    stored = fresh_db.get(DebtPayment, uuid.UUID(body["id"]))
    assert stored is not None
    assert stored.debt_id == uuid.UUID(debt["id"])
    assert stored.amount_cents == 110_000
    assert stored.source_account_id == uuid.UUID(account["id"])


def test_create_payment_without_source_account_is_allowed(
    client: TestClient,
    fresh_db: Session,
) -> None:
    """Source account is nullable (spec AC) — a cash-in-hand cicilan
    with no linked account is a first-class case."""
    auth = _register(client, "dp-create-cash@example.com")
    headers = _headers(auth["access_token"])
    debt = _create_debt(client, headers)

    body = _create_payment(
        client,
        headers,
        debt_id=debt["id"],
        principal_portion_cents=100_000,
        interest_portion_cents=10_000,
        source_account_id=None,
    )

    assert body["source_account_id"] is None
    assert body["amount_cents"] == 110_000


def test_create_payment_with_full_payoff_flips_debt_status_to_paid_off(
    client: TestClient,
    fresh_db: Session,
) -> None:
    """A payment whose principal portion equals the remaining principal
    triggers the auto-paid-off transition. The status flip is visible
    on the next GET /debts/{id} and is persisted in the DB."""
    auth = _register(client, "dp-create-payoff@example.com")
    headers = _headers(auth["access_token"])
    debt = _create_debt(client, headers, principal_cents=1_200_000)

    _create_payment(
        client,
        headers,
        debt_id=debt["id"],
        principal_portion_cents=1_200_000,
        interest_portion_cents=120_000,
    )

    fetched = client.get(f"/api/v1/debts/{debt['id']}", headers=headers)
    assert fetched.status_code == 200, fetched.text
    assert fetched.json()["status"] == "paid_off"

    stored = fresh_db.get(Debt, uuid.UUID(debt["id"]))
    assert stored is not None
    assert stored.status == DebtStatus.PAID_OFF


# ---------------------------------------------------------------------------
# Create — validation rejections (422)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("payload_override", "expected_field"),
    [
        (
            {"amount_cents": 0, "principal_portion_cents": 0, "interest_portion_cents": 0},
            "amount_cents",
        ),
        (
            {"amount_cents": -100, "principal_portion_cents": -50, "interest_portion_cents": -50},
            "amount_cents",
        ),
        (
            {"amount_cents": 100, "principal_portion_cents": -10, "interest_portion_cents": 110},
            "principal_portion_cents",
        ),
        (
            {"amount_cents": 100, "principal_portion_cents": 90, "interest_portion_cents": -10},
            "interest_portion_cents",
        ),
        (
            {"amount_cents": 100, "principal_portion_cents": 60, "interest_portion_cents": 50},
            "principal_portion_cents",
        ),
    ],
)
def test_create_payment_rejects_invalid_amount_or_portions(
    client: TestClient,
    fresh_db: Session,
    payload_override: dict[str, object],
    expected_field: str,
) -> None:
    auth = _register(client, "dp-create-invalid@example.com")
    headers = _headers(auth["access_token"])
    debt = _create_debt(client, headers)

    payload = {
        "occurred_on": "2026-09-01",
        "amount_cents": 100_000,
        "principal_portion_cents": 90_000,
        "interest_portion_cents": 10_000,
    }
    payload.update(payload_override)
    response = client.post(
        f"/api/v1/debts/{debt['id']}/payments",
        headers=headers,
        json=payload,
    )

    assert response.status_code == 422, response.text
    assert expected_field in response.text
    assert fresh_db.query(DebtPayment).count() == 0


def test_create_payment_rejects_overpayment_with_422(
    client: TestClient,
    fresh_db: Session,
) -> None:
    """A payment whose principal portion exceeds the remaining principal
    is rejected with 422. The principal here is 1_200_000 — the debt's
    full principal — so any value beyond that is overpayment."""
    auth = _register(client, "dp-create-overpay@example.com")
    headers = _headers(auth["access_token"])
    debt = _create_debt(client, headers, principal_cents=1_200_000)

    response = client.post(
        f"/api/v1/debts/{debt['id']}/payments",
        headers=headers,
        json={
            "occurred_on": "2026-09-01",
            "amount_cents": 1_300_000,
            "principal_portion_cents": 1_300_000,
            "interest_portion_cents": 0,
        },
    )

    assert response.status_code == 422, response.text
    assert "exceeds the debt's remaining principal" in response.text
    assert fresh_db.query(DebtPayment).count() == 0


def test_create_payment_rejects_when_debt_is_already_paid_off(
    client: TestClient,
    fresh_db: Session,
) -> None:
    """Payments on a paid-off debt return 422 — the status only flips
    back to active via delete / update."""
    auth = _register(client, "dp-create-paidoff@example.com")
    headers = _headers(auth["access_token"])
    debt = _create_debt(client, headers, principal_cents=1_200_000)

    # Bring the debt to paid_off.
    _create_payment(
        client,
        headers,
        debt_id=debt["id"],
        principal_portion_cents=1_200_000,
        interest_portion_cents=120_000,
    )

    response = client.post(
        f"/api/v1/debts/{debt['id']}/payments",
        headers=headers,
        json={
            "occurred_on": "2026-09-01",
            "amount_cents": 50_000,
            "principal_portion_cents": 50_000,
            "interest_portion_cents": 0,
        },
    )

    assert response.status_code == 422, response.text
    assert "paid_off" in response.text


def test_create_payment_rejects_foreign_source_account_with_404(
    client: TestClient,
    fresh_db: Session,
) -> None:
    """A source_account_id belonging to another user (or unknown /
    archived) surfaces as 404 — same pattern as the transactions /
    accounts routers."""
    alice = _register(client, "dp-create-source-alice@example.com")
    bob = _register(client, "dp-create-source-bob@example.com")
    alice_headers = _headers(alice["access_token"])
    bob_headers = _headers(bob["access_token"])

    bob_account = _create_account(client, bob_headers)
    debt = _create_debt(client, alice_headers)

    # Alice tries to attach Bob's account as the source.
    response = client.post(
        f"/api/v1/debts/{debt['id']}/payments",
        headers=alice_headers,
        json={
            "occurred_on": "2026-09-01",
            "amount_cents": 110_000,
            "principal_portion_cents": 100_000,
            "interest_portion_cents": 10_000,
            "source_account_id": bob_account["id"],
        },
    )

    assert response.status_code == 404, response.text
    assert response.json()["detail"] == "account not found"
    assert fresh_db.query(DebtPayment).count() == 0


def test_create_payment_rejects_archived_source_account_with_404(
    client: TestClient,
    fresh_db: Session,
) -> None:
    auth = _register(client, "dp-create-source-archived@example.com")
    headers = _headers(auth["access_token"])
    account = _create_account(client, headers)
    # Archive the account via the existing DELETE endpoint.
    archive = client.delete(f"/api/v1/accounts/{account['id']}", headers=headers)
    assert archive.status_code == 204, archive.text

    debt = _create_debt(client, headers)
    response = client.post(
        f"/api/v1/debts/{debt['id']}/payments",
        headers=headers,
        json={
            "occurred_on": "2026-09-01",
            "amount_cents": 110_000,
            "principal_portion_cents": 100_000,
            "interest_portion_cents": 10_000,
            "source_account_id": account["id"],
        },
    )
    assert response.status_code == 404, response.text
    assert response.json()["detail"] == "account not found"
    assert fresh_db.query(DebtPayment).count() == 0


def test_create_payment_rejects_unknown_source_account_with_404(
    client: TestClient,
    fresh_db: Session,
) -> None:
    auth = _register(client, "dp-create-source-unknown@example.com")
    headers = _headers(auth["access_token"])
    debt = _create_debt(client, headers)

    response = client.post(
        f"/api/v1/debts/{debt['id']}/payments",
        headers=headers,
        json={
            "occurred_on": "2026-09-01",
            "amount_cents": 110_000,
            "principal_portion_cents": 100_000,
            "interest_portion_cents": 10_000,
            "source_account_id": str(uuid.uuid4()),
        },
    )
    assert response.status_code == 404, response.text
    assert response.json()["detail"] == "account not found"
    assert fresh_db.query(DebtPayment).count() == 0


def test_create_payment_rejects_unknown_debt_with_404(
    client: TestClient,
    fresh_db: Session,
) -> None:
    auth = _register(client, "dp-create-unknown-debt@example.com")
    headers = _headers(auth["access_token"])
    response = client.post(
        f"/api/v1/debts/{uuid.uuid4()}/payments",
        headers=headers,
        json={
            "occurred_on": "2026-09-01",
            "amount_cents": 110_000,
            "principal_portion_cents": 100_000,
            "interest_portion_cents": 10_000,
        },
    )
    assert response.status_code == 404, response.text
    assert response.json()["detail"] == "debt not found"
    assert fresh_db.query(DebtPayment).count() == 0


# ---------------------------------------------------------------------------
# List — pagination + sort + ownership
# ---------------------------------------------------------------------------


def test_list_payments_returns_paginated_and_sorted_by_occurred_on_desc(
    client: TestClient,
    fresh_db: Session,
) -> None:
    auth = _register(client, "dp-list-sort@example.com")
    headers = _headers(auth["access_token"])
    debt = _create_debt(client, headers)

    oldest = _create_payment(client, headers, debt_id=debt["id"], occurred_on="2026-09-01")
    middle = _create_payment(client, headers, debt_id=debt["id"], occurred_on="2026-10-01")
    newest = _create_payment(client, headers, debt_id=debt["id"], occurred_on="2026-11-01")

    response = client.get(
        f"/api/v1/debts/{debt['id']}/payments",
        headers=headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["total"] == 3
    assert body["limit"] == 50
    assert body["offset"] == 0
    assert [row["id"] for row in body["items"]] == [newest["id"], middle["id"], oldest["id"]]


def test_list_payments_supports_limit_and_offset(
    client: TestClient,
    fresh_db: Session,
) -> None:
    auth = _register(client, "dp-list-paginate@example.com")
    headers = _headers(auth["access_token"])
    debt = _create_debt(client, headers, principal_cents=10_000_000)

    for day in range(5):
        _create_payment(
            client,
            headers,
            debt_id=debt["id"],
            principal_portion_cents=100_000,
            interest_portion_cents=10_000,
            occurred_on=f"2026-09-{day + 1:02d}",
        )

    response = client.get(
        f"/api/v1/debts/{debt['id']}/payments?limit=2&offset=0",
        headers=headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["total"] == 5
    assert body["limit"] == 2
    assert body["offset"] == 0
    assert len(body["items"]) == 2

    response = client.get(
        f"/api/v1/debts/{debt['id']}/payments?limit=2&offset=4",
        headers=headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert len(body["items"]) == 1


def test_list_payments_is_scoped_to_owner(
    client: TestClient,
    fresh_db: Session,
) -> None:
    """Bob can't see Alice's payments, and Alice can't see Bob's."""
    alice = _register(client, "dp-list-alice@example.com")
    bob = _register(client, "dp-list-bob@example.com")
    alice_headers = _headers(alice["access_token"])
    bob_headers = _headers(bob["access_token"])

    alice_debt = _create_debt(client, alice_headers)
    bob_debt = _create_debt(client, bob_headers)

    alice_payment = _create_payment(client, alice_headers, debt_id=alice_debt["id"])
    bob_payment = _create_payment(client, bob_headers, debt_id=bob_debt["id"])

    alice_list = client.get(
        f"/api/v1/debts/{alice_debt['id']}/payments",
        headers=alice_headers,
    )
    assert alice_list.status_code == 200
    alice_items = alice_list.json()["items"]
    assert [row["id"] for row in alice_items] == [alice_payment["id"]]

    bob_list = client.get(
        f"/api/v1/debts/{bob_debt['id']}/payments",
        headers=bob_headers,
    )
    assert bob_list.status_code == 200
    assert [row["id"] for row in bob_list.json()["items"]] == [bob_payment["id"]]

    # Alice can't list via Bob's debt id (404 — not 403, no leak).
    cross = client.get(
        f"/api/v1/debts/{bob_debt['id']}/payments",
        headers=alice_headers,
    )
    assert cross.status_code == 404
    assert cross.json()["detail"] == "debt not found"


# ---------------------------------------------------------------------------
# Get
# ---------------------------------------------------------------------------


def test_get_payment_returns_persisted_row(
    client: TestClient,
    fresh_db: Session,
) -> None:
    auth = _register(client, "dp-get-happy@example.com")
    headers = _headers(auth["access_token"])
    debt = _create_debt(client, headers)
    payment = _create_payment(client, headers, debt_id=debt["id"], note="Cicilan test")

    response = client.get(
        f"/api/v1/debts/{debt['id']}/payments/{payment['id']}",
        headers=headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["id"] == payment["id"]
    assert body["note"] == "Cicilan test"


def test_get_payment_returns_404_for_foreign_debt(
    client: TestClient,
    fresh_db: Session,
) -> None:
    alice = _register(client, "dp-get-alice@example.com")
    bob = _register(client, "dp-get-bob@example.com")
    alice_headers = _headers(alice["access_token"])
    bob_headers = _headers(bob["access_token"])
    debt = _create_debt(client, alice_headers)
    payment = _create_payment(client, alice_headers, debt_id=debt["id"])

    response = client.get(
        f"/api/v1/debts/{debt['id']}/payments/{payment['id']}",
        headers=bob_headers,
    )
    assert response.status_code == 404, response.text
    assert response.json()["detail"] == "debt not found"


def test_get_payment_returns_404_when_payment_belongs_to_different_debt(
    client: TestClient,
    fresh_db: Session,
) -> None:
    """A payment id from a different debt of the same user surfaces as
    404 — the path-based debt id is part of the URL, so the FE knows
    the resource it was trying to reach is not visible from here."""
    auth = _register(client, "dp-get-cross-debt@example.com")
    headers = _headers(auth["access_token"])
    first_debt = _create_debt(client, headers, name="First")
    second_debt = _create_debt(client, headers, name="Second")
    payment_on_first = _create_payment(client, headers, debt_id=first_debt["id"])

    # The payment exists, but on a different debt — 404.
    response = client.get(
        f"/api/v1/debts/{second_debt['id']}/payments/{payment_on_first['id']}",
        headers=headers,
    )
    assert response.status_code == 404, response.text
    assert response.json()["detail"] == "payment not found"


# ---------------------------------------------------------------------------
# Patch
# ---------------------------------------------------------------------------


def test_patch_payment_updates_fields_and_recomputes_status(
    client: TestClient,
    fresh_db: Session,
) -> None:
    auth = _register(client, "dp-patch-happy@example.com")
    headers = _headers(auth["access_token"])
    debt = _create_debt(client, headers, principal_cents=1_200_000)
    account = _create_account(client, headers, name="Secondary")
    payment = _create_payment(
        client,
        headers,
        debt_id=debt["id"],
        principal_portion_cents=200_000,
        interest_portion_cents=20_000,
    )

    response = client.patch(
        f"/api/v1/debts/{debt['id']}/payments/{payment['id']}",
        headers=headers,
        json={
            # Send all three (amount + portions) so the schema's
            # split rule fires; the merged-value check on the route
            # also passes when the caller-supplied triple reconciles.
            "amount_cents": 1_320_000,
            "principal_portion_cents": 1_200_000,
            "interest_portion_cents": 120_000,
            "source_account_id": account["id"],
            "note": "Lunas",
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["principal_portion_cents"] == 1_200_000
    assert body["interest_portion_cents"] == 120_000
    assert body["amount_cents"] == 1_320_000
    assert body["source_account_id"] == account["id"]
    assert body["note"] == "Lunas"

    # Status flipped to paid_off because the new principal portion
    # equals the debt's full principal.
    fetched = client.get(f"/api/v1/debts/{debt['id']}", headers=headers)
    assert fetched.json()["status"] == "paid_off"


def test_patch_can_flip_paid_off_back_to_active_by_decreasing_principal(
    client: TestClient,
    fresh_db: Session,
) -> None:
    """A PATCH that decreases the principal portion on the *last*
    payment of a paid-off debt transitions ``status`` back to
    ``active``. The overpayment check uses the
    ``excluding_payment_id`` clause so the edit can succeed
    (otherwise the check would always trip on the last payment — the
    only one whose principal portion can legitimately equal the full
    remaining)."""
    auth = _register(client, "dp-patch-active-back@example.com")
    headers = _headers(auth["access_token"])
    debt = _create_debt(client, headers, principal_cents=1_200_000)
    payment = _create_payment(
        client,
        headers,
        debt_id=debt["id"],
        principal_portion_cents=1_200_000,
        interest_portion_cents=120_000,
    )

    response = client.patch(
        f"/api/v1/debts/{debt['id']}/payments/{payment['id']}",
        headers=headers,
        json={
            "amount_cents": 550_000,
            "principal_portion_cents": 500_000,
            "interest_portion_cents": 50_000,
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["principal_portion_cents"] == 500_000

    fetched = client.get(f"/api/v1/debts/{debt['id']}", headers=headers)
    assert fetched.json()["status"] == "active"


def test_patch_can_clear_source_account_with_null(
    client: TestClient,
    fresh_db: Session,
) -> None:
    auth = _register(client, "dp-patch-clear-source@example.com")
    headers = _headers(auth["access_token"])
    account = _create_account(client, headers)
    debt = _create_debt(client, headers)
    payment = _create_payment(
        client,
        headers,
        debt_id=debt["id"],
        source_account_id=account["id"],
    )
    assert payment["source_account_id"] == account["id"]

    response = client.patch(
        f"/api/v1/debts/{debt['id']}/payments/{payment['id']}",
        headers=headers,
        json={"source_account_id": None},
    )
    assert response.status_code == 200, response.text
    assert response.json()["source_account_id"] is None


def test_patch_rejects_amount_only_edit_with_422(
    client: TestClient,
    fresh_db: Session,
) -> None:
    """An ``amount_cents`` edit without the portions can't silently
    rebalance the split — caller must send both portions."""
    auth = _register(client, "dp-patch-amount-only@example.com")
    headers = _headers(auth["access_token"])
    debt = _create_debt(client, headers)
    payment = _create_payment(
        client,
        headers,
        debt_id=debt["id"],
        principal_portion_cents=100_000,
        interest_portion_cents=10_000,
    )

    response = client.patch(
        f"/api/v1/debts/{debt['id']}/payments/{payment['id']}",
        headers=headers,
        json={"amount_cents": 200_000},
    )

    assert response.status_code == 422, response.text
    assert "amount_cents cannot be updated" in response.text


def test_patch_rejects_split_mismatch_with_422(
    client: TestClient,
    fresh_db: Session,
) -> None:
    """A PATCH whose principal + interest doesn't reconcile with the
    (effective) amount is rejected. The schema catches the all-three
    case; the route catches the partial-portion case via the merged
    effective values."""
    auth = _register(client, "dp-patch-mismatch@example.com")
    headers = _headers(auth["access_token"])
    debt = _create_debt(client, headers)
    payment = _create_payment(
        client,
        headers,
        debt_id=debt["id"],
        principal_portion_cents=100_000,
        interest_portion_cents=10_000,
    )

    # Send all three — schema catches the mismatch.
    response = client.patch(
        f"/api/v1/debts/{debt['id']}/payments/{payment['id']}",
        headers=headers,
        json={
            "amount_cents": 100_000,
            "principal_portion_cents": 60_000,
            "interest_portion_cents": 30_000,
        },
    )
    assert response.status_code == 422, response.text
    assert "must equal amount_cents" in response.text

    # Send only the principal portion — the route catches it because
    # the merged value would be 60k + 10k (existing interest) !=
    # 100k (existing amount).
    response = client.patch(
        f"/api/v1/debts/{debt['id']}/payments/{payment['id']}",
        headers=headers,
        json={"principal_portion_cents": 60_000},
    )
    assert response.status_code == 422, response.text
    assert "effective" in response.text


def test_patch_rejects_overpayment_with_422(
    client: TestClient,
    fresh_db: Session,
) -> None:
    auth = _register(client, "dp-patch-overpay@example.com")
    headers = _headers(auth["access_token"])
    debt = _create_debt(client, headers, principal_cents=1_200_000)
    payment = _create_payment(
        client,
        headers,
        debt_id=debt["id"],
        principal_portion_cents=200_000,
        interest_portion_cents=20_000,
    )

    # Without the excluding_payment_id clause, this would trip because
    # the remaining principal is 1_000_000. With the clause (the
    # payment is conceptually being reversed first), the post-reversal
    # remaining is 1_200_000 — so 1_100_000 should be fine. Send the
    # full triple (amount + portions) so the schema's split rule and
    # the route's overpayment check both see the same effective values.
    response = client.patch(
        f"/api/v1/debts/{debt['id']}/payments/{payment['id']}",
        headers=headers,
        json={
            "amount_cents": 1_210_000,
            "principal_portion_cents": 1_100_000,
            "interest_portion_cents": 110_000,
        },
    )
    assert response.status_code == 200, response.text

    # But 1_300_000 still trips.
    response = client.patch(
        f"/api/v1/debts/{debt['id']}/payments/{payment['id']}",
        headers=headers,
        json={
            "amount_cents": 1_430_000,
            "principal_portion_cents": 1_300_000,
            "interest_portion_cents": 130_000,
        },
    )
    assert response.status_code == 422, response.text
    assert "exceeds" in response.text


def test_patch_rejects_foreign_source_account_with_404(
    client: TestClient,
    fresh_db: Session,
) -> None:
    alice = _register(client, "dp-patch-source-alice@example.com")
    bob = _register(client, "dp-patch-source-bob@example.com")
    alice_headers = _headers(alice["access_token"])
    bob_headers = _headers(bob["access_token"])

    bob_account = _create_account(client, bob_headers)
    debt = _create_debt(client, alice_headers)
    payment = _create_payment(client, alice_headers, debt_id=debt["id"])

    response = client.patch(
        f"/api/v1/debts/{debt['id']}/payments/{payment['id']}",
        headers=alice_headers,
        json={"source_account_id": bob_account["id"]},
    )
    assert response.status_code == 404, response.text


def test_patch_rejects_foreign_debt_with_404(
    client: TestClient,
    fresh_db: Session,
) -> None:
    alice = _register(client, "dp-patch-debt-alice@example.com")
    bob = _register(client, "dp-patch-debt-bob@example.com")
    alice_headers = _headers(alice["access_token"])
    bob_headers = _headers(bob["access_token"])
    debt = _create_debt(client, alice_headers)
    payment = _create_payment(client, alice_headers, debt_id=debt["id"])

    response = client.patch(
        f"/api/v1/debts/{debt['id']}/payments/{payment['id']}",
        headers=bob_headers,
        json={"note": "Forbidden"},
    )
    assert response.status_code == 404, response.text


# ---------------------------------------------------------------------------
# Delete
# ---------------------------------------------------------------------------


def test_delete_payment_returns_204_and_removes_row(
    client: TestClient,
    fresh_db: Session,
) -> None:
    auth = _register(client, "dp-delete-happy@example.com")
    headers = _headers(auth["access_token"])
    debt = _create_debt(client, headers)
    payment = _create_payment(client, headers, debt_id=debt["id"])

    response = client.delete(
        f"/api/v1/debts/{debt['id']}/payments/{payment['id']}",
        headers=headers,
    )
    assert response.status_code == 204, response.text
    assert response.content == b""
    assert fresh_db.get(DebtPayment, uuid.UUID(payment["id"])) is None

    # And the GET now returns 404.
    follow_up = client.get(
        f"/api/v1/debts/{debt['id']}/payments/{payment['id']}",
        headers=headers,
    )
    assert follow_up.status_code == 404


def test_delete_last_payment_flips_paid_off_back_to_active(
    client: TestClient,
    fresh_db: Session,
) -> None:
    """Deleting the last cicilan on a paid-off debt transitions the
    status back to active. Mirrors the same rule the PATCH path
    applies."""
    auth = _register(client, "dp-delete-reactivate@example.com")
    headers = _headers(auth["access_token"])
    debt = _create_debt(client, headers, principal_cents=1_200_000)
    payment = _create_payment(
        client,
        headers,
        debt_id=debt["id"],
        principal_portion_cents=1_200_000,
        interest_portion_cents=120_000,
    )
    # Sanity: the debt is paid_off now.
    fetched = client.get(f"/api/v1/debts/{debt['id']}", headers=headers)
    assert fetched.json()["status"] == "paid_off"

    response = client.delete(
        f"/api/v1/debts/{debt['id']}/payments/{payment['id']}",
        headers=headers,
    )
    assert response.status_code == 204, response.text

    fetched = client.get(f"/api/v1/debts/{debt['id']}", headers=headers)
    assert fetched.json()["status"] == "active"


def test_delete_rejects_foreign_debt_with_404(
    client: TestClient,
    fresh_db: Session,
) -> None:
    alice = _register(client, "dp-delete-alice@example.com")
    bob = _register(client, "dp-delete-bob@example.com")
    alice_headers = _headers(alice["access_token"])
    bob_headers = _headers(bob["access_token"])
    debt = _create_debt(client, alice_headers)
    payment = _create_payment(client, alice_headers, debt_id=debt["id"])

    response = client.delete(
        f"/api/v1/debts/{debt['id']}/payments/{payment['id']}",
        headers=bob_headers,
    )
    assert response.status_code == 404, response.text
    # The payment still exists.
    assert fresh_db.get(DebtPayment, uuid.UUID(payment["id"])) is not None


# ---------------------------------------------------------------------------
# Atomicity — commit failure rolls back payment + status change
# ---------------------------------------------------------------------------


def test_create_payment_rolls_back_on_commit_failure(
    client: TestClient,
    fresh_db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """AC: saldo + status diperbarui atomically (rollback bila gagal).

    Monkey-patches ``Session.commit`` to raise after the route stages
    the payment + status flip. A read of the DB after the patch is
    reverted must see zero payment rows and ``status='active'``.
    """
    from sqlalchemy.orm import Session as OrmSession

    auth = _register(client, "dp-atomic-create@example.com")
    headers = _headers(auth["access_token"])
    debt = _create_debt(client, headers, principal_cents=1_200_000)

    original_commit = OrmSession.commit

    def failing_commit(self: OrmSession) -> None:
        raise RuntimeError("simulated DB failure during commit")

    monkeypatch.setattr(OrmSession, "commit", failing_commit)

    with pytest.raises(RuntimeError, match="simulated DB failure"):
        client.post(
            f"/api/v1/debts/{debt['id']}/payments",
            headers=headers,
            json={
                "occurred_on": "2026-09-01",
                "amount_cents": 1_200_000,
                "principal_portion_cents": 1_200_000,
                "interest_portion_cents": 0,
            },
        )

    # Restore so the post-assertion reads the DB.
    monkeypatch.setattr(OrmSession, "commit", original_commit)

    fresh_db.expire_all()
    payment_rows = (
        fresh_db.query(DebtPayment).filter(DebtPayment.debt_id == uuid.UUID(debt["id"])).all()
    )
    assert payment_rows == [], "atomicity violated — payment persisted despite commit failure"

    debt_row = fresh_db.get(Debt, uuid.UUID(debt["id"]))
    assert debt_row is not None
    assert debt_row.status == DebtStatus.ACTIVE, (
        "atomicity violated — debt status flipped to paid_off despite commit failure"
    )


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "url", "body"),
    [
        (
            "post",
            "/api/v1/debts/{d}/payments",
            {
                "occurred_on": "2026-09-01",
                "amount_cents": 110_000,
                "principal_portion_cents": 100_000,
                "interest_portion_cents": 10_000,
            },
        ),
        ("get", "/api/v1/debts/{d}/payments", None),
        ("get", "/api/v1/debts/{d}/payments/{p}", None),
        ("patch", "/api/v1/debts/{d}/payments/{p}", {"note": "No auth"}),
        ("delete", "/api/v1/debts/{d}/payments/{p}", None),
    ],
)
def test_every_endpoint_requires_auth(
    client: TestClient,
    fresh_db: Session,
    method: str,
    url: str,
    body: dict[str, object] | None,
) -> None:
    formatted = url.format(d=str(uuid.uuid4()), p=str(uuid.uuid4()))
    response = client.request(method, formatted, json=body)
    assert response.status_code == 401, response.text
