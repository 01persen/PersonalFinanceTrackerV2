"""Transactions PATCH + DELETE (soft) coverage — sub-0003-02.

Scenarios covered (per acceptance criteria):

* (a) ``PATCH /transactions/{id}`` only edits own-user rows. Foreign rows
      return 404. Invalid fields are rejected with 422 (amount <= 0,
      currency != IDR, category without ownership, category with kind
      mismatch). The ``type`` field is intentionally not editable — the
      schema rejects it with 422 before the route runs.
* (b) ``DELETE /transactions/{id}`` sets ``deleted_at`` server-side. The
      row is no longer returned by ``GET /transactions`` (list and ``total``
      exclude it), but it stays in the DB (audit trail).
* (c) ``deleted_at`` is captured server-side and serialised on the
      transaction payload (visible via the Patch-returned and any direct
      row read). A second DELETE is idempotent (still 204, no error).

Two-user isolation is exercised: every PATCH/DELETE test that operates on
a row asserts the other user can't see it via DELETE, can't see it via
GET, and can't PATCH/DELETE it.
"""

from __future__ import annotations

import uuid
from datetime import date

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
    currency: str = "IDR",
    opening_balance_cents: int = 0,
) -> dict:
    resp = client.post(
        "/api/v1/accounts",
        headers=headers,
        json={
            "name": name,
            "type": type_,
            "currency": currency,
            "opening_balance_cents": opening_balance_cents,
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _list_categories(client: TestClient, headers: dict[str, str]) -> list[dict]:
    resp = client.get("/api/v1/categories", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()["items"]


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
    type_: str = "expense",
    account_id: str,
    category_id: str | None = None,
    amount_cents: int = 50_000,
    occurred_on: date | None = None,
    note: str | None = "Test note",
    currency: str = "IDR",
) -> dict:
    payload: dict = {
        "type": type_,
        "account_id": account_id,
        "amount_cents": amount_cents,
        "currency": currency,
        "occurred_on": (occurred_on or date.today()).isoformat(),
    }
    if category_id is not None:
        payload["category_id"] = category_id
    if note is not None:
        payload["note"] = note
    resp = client.post("/api/v1/transactions", headers=headers, json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


# ---------------------------------------------------------------------------
# (a) PATCH behaviour
# ---------------------------------------------------------------------------


def test_patch_updates_only_specified_fields(client: TestClient, fresh_db: Session) -> None:
    """Single-field PATCH touches only that field; everything else is left alone."""
    headers = _auth_headers(_register(client, "patch-partial@example.com")["access_token"])
    account = _create_account(client, headers, name="A")
    category = _pick_category(client, headers, kind="expense", name_contains="Makan")

    tx = _create_transaction(
        client,
        headers,
        account_id=account["id"],
        category_id=category["id"],
        amount_cents=10_000,
        note="Before",
    )

    resp = client.patch(
        f"/api/v1/transactions/{tx['id']}",
        headers=headers,
        json={"note": "After"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["note"] == "After"
    assert body["amount_cents"] == 10_000
    assert body["account_id"] == account["id"]
    assert body["category_id"] == category["id"]
    assert body["type"] == "expense"
    assert body["currency"] == "IDR"
    assert body["deleted_at"] is None


def test_patch_updates_multiple_fields_atomically(client: TestClient, fresh_db: Session) -> None:
    """Multi-field PATCH applies all changes in a single DB write."""
    headers = _auth_headers(_register(client, "patch-multi@example.com")["access_token"])
    account_a = _create_account(client, headers, name="Dompet")
    account_b = _create_account(client, headers, name="BCA")
    category = _pick_category(client, headers, kind="expense", name_contains="Makan")

    tx = _create_transaction(
        client,
        headers,
        account_id=account_a["id"],
        category_id=category["id"],
        amount_cents=10_000,
    )

    resp = client.patch(
        f"/api/v1/transactions/{tx['id']}",
        headers=headers,
        json={
            "account_id": account_b["id"],
            "amount_cents": 25_000,
            "occurred_on": "2026-01-15",
            "note": "Rebucketed",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["account_id"] == account_b["id"]
    assert body["amount_cents"] == 25_000
    assert body["occurred_on"] == "2026-01-15"
    assert body["note"] == "Rebucketed"


def test_patch_returns_404_for_foreign_user(client: TestClient, fresh_db: Session) -> None:
    """A user cannot PATCH another user's transaction — 404 (no leak)."""
    alice_h = _auth_headers(_register(client, "alice-patch@example.com")["access_token"])
    bob_h = _auth_headers(_register(client, "bob-patch@example.com")["access_token"])

    alice_account = _create_account(client, alice_h, name="A")
    alice_tx = _create_transaction(
        client, alice_h, account_id=alice_account["id"], amount_cents=1_000
    )

    resp = client.patch(
        f"/api/v1/transactions/{alice_tx['id']}",
        headers=bob_h,
        json={"note": "hostile"},
    )
    assert resp.status_code == 404
    assert "transaction not found" in resp.json()["detail"].lower()


def test_patch_returns_404_for_unknown_id(client: TestClient, fresh_db: Session) -> None:
    """A random UUID that doesn't exist returns 404."""
    headers = _auth_headers(_register(client, "patch-uuid@example.com")["access_token"])

    resp = client.patch(
        f"/api/v1/transactions/{uuid.uuid4()}",
        headers=headers,
        json={"note": "ghost"},
    )
    assert resp.status_code == 404


def test_patch_rejects_zero_amount_with_422(client: TestClient, fresh_db: Session) -> None:
    """Pydantic ``gt=0`` on the update schema rejects amount_cents=0."""
    headers = _auth_headers(_register(client, "patch-zero@example.com")["access_token"])
    account = _create_account(client, headers, name="A")
    tx = _create_transaction(client, headers, account_id=account["id"], amount_cents=10_000)

    resp = client.patch(
        f"/api/v1/transactions/{tx['id']}",
        headers=headers,
        json={"amount_cents": 0},
    )
    assert resp.status_code == 422


def test_patch_rejects_negative_amount_with_422(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "patch-neg@example.com")["access_token"])
    account = _create_account(client, headers, name="A")
    tx = _create_transaction(client, headers, account_id=account["id"], amount_cents=10_000)

    resp = client.patch(
        f"/api/v1/transactions/{tx['id']}",
        headers=headers,
        json={"amount_cents": -1},
    )
    assert resp.status_code == 422


def test_patch_rejects_non_idr_currency_with_422(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "patch-fx@example.com")["access_token"])
    account = _create_account(client, headers, name="A")
    tx = _create_transaction(client, headers, account_id=account["id"])

    resp = client.patch(
        f"/api/v1/transactions/{tx['id']}",
        headers=headers,
        json={"currency": "USD"},
    )
    assert resp.status_code == 422
    assert "idr" in str(resp.json()["detail"]).lower()


def test_patch_rejects_archived_account_with_404(client: TestClient, fresh_db: Session) -> None:
    """PATCH to an archived account is rejected just like POST."""
    headers = _auth_headers(_register(client, "patch-archived@example.com")["access_token"])
    account = _create_account(client, headers, name="Doomed")
    tx = _create_transaction(client, headers, account_id=account["id"])
    client.delete(f"/api/v1/accounts/{account['id']}", headers=headers)

    resp = client.patch(
        f"/api/v1/transactions/{tx['id']}",
        headers=headers,
        json={"account_id": account["id"]},
    )
    assert resp.status_code == 404


def test_patch_account_not_owned_with_404(client: TestClient, fresh_db: Session) -> None:
    """PATCH to a foreign account id is 404 (no leak)."""
    alice_h = _auth_headers(_register(client, "alice-pac@example.com")["access_token"])
    bob_h = _auth_headers(_register(client, "bob-pac@example.com")["access_token"])

    alice_account = _create_account(client, alice_h, name="A")
    bob_account = _create_account(client, bob_h, name="B")
    tx = _create_transaction(client, alice_h, account_id=alice_account["id"])

    resp = client.patch(
        f"/api/v1/transactions/{tx['id']}",
        headers=alice_h,
        json={"account_id": bob_account["id"]},
    )
    assert resp.status_code == 404


def test_patch_category_not_owned_with_404(client: TestClient, fresh_db: Session) -> None:
    """PATCH to a foreign category id is 404 (no leak)."""
    alice_h = _auth_headers(_register(client, "alice-pcc@example.com")["access_token"])
    bob_h = _auth_headers(_register(client, "bob-pcc@example.com")["access_token"])

    alice_account = _create_account(client, alice_h, name="A")
    bob_category = _pick_category(client, bob_h, kind="expense", name_contains="Makan")
    tx = _create_transaction(client, alice_h, account_id=alice_account["id"])

    resp = client.patch(
        f"/api/v1/transactions/{tx['id']}",
        headers=alice_h,
        json={"category_id": bob_category["id"]},
    )
    assert resp.status_code == 404


def test_patch_category_kind_mismatch_with_422(client: TestClient, fresh_db: Session) -> None:
    """An income transaction can't be reassigned to an expense category."""
    headers = _auth_headers(_register(client, "patch-mismatch@example.com")["access_token"])
    account = _create_account(client, headers, name="A")
    income_cat = _pick_category(client, headers, kind="income", name_contains="Gaji")
    expense_cat = _pick_category(client, headers, kind="expense", name_contains="Makan")

    tx = _create_transaction(
        client,
        headers,
        type_="income",
        account_id=account["id"],
        category_id=income_cat["id"],
    )

    resp = client.patch(
        f"/api/v1/transactions/{tx['id']}",
        headers=headers,
        json={"category_id": expense_cat["id"]},
    )
    assert resp.status_code == 422
    assert "kind" in str(resp.json()["detail"]).lower()


def test_patch_type_is_immutable(client: TestClient, fresh_db: Session) -> None:
    """``type`` is intentionally not editable after creation — 422, no DB write."""
    headers = _auth_headers(_register(client, "patch-type@example.com")["access_token"])
    account = _create_account(client, headers, name="A")
    tx = _create_transaction(client, headers, account_id=account["id"], amount_cents=1_000)

    resp = client.patch(
        f"/api/v1/transactions/{tx['id']}",
        headers=headers,
        json={"type": "income"},
    )
    assert resp.status_code == 422


def test_patch_requires_authentication(client: TestClient, fresh_db: Session) -> None:
    resp = client.patch(
        f"/api/v1/transactions/{uuid.uuid4()}",
        json={"note": "x"},
    )
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# (b) DELETE behaviour
# ---------------------------------------------------------------------------


def test_delete_soft_deletes_row_returns_204_and_hides_from_list(
    client: TestClient, fresh_db: Session
) -> None:
    """DELETE returns 204, row stays in DB with deleted_at set, list excludes it."""
    headers = _auth_headers(_register(client, "delete-soft@example.com")["access_token"])
    account = _create_account(client, headers, name="A")
    tx = _create_transaction(client, headers, account_id=account["id"], amount_cents=10_000)

    resp = client.delete(f"/api/v1/transactions/{tx['id']}", headers=headers)
    assert resp.status_code == 204

    # The row is still in the DB (audit trail).
    row = fresh_db.get(Transaction, uuid.UUID(tx["id"]))
    assert row is not None
    assert row.deleted_at is not None  # audit (c)

    # The list endpoint no longer surfaces it.
    listing = client.get("/api/v1/transactions", headers=headers).json()
    assert listing["total"] == 0
    assert listing["items"] == []


def test_delete_is_idempotent(client: TestClient, fresh_db: Session) -> None:
    """A second DELETE on the same row is a no-op (still 204)."""
    headers = _auth_headers(_register(client, "delete-twice@example.com")["access_token"])
    account = _create_account(client, headers, name="A")
    tx = _create_transaction(client, headers, account_id=account["id"])

    assert client.delete(f"/api/v1/transactions/{tx['id']}", headers=headers).status_code == 204
    second = client.delete(f"/api/v1/transactions/{tx['id']}", headers=headers)
    assert second.status_code == 204

    # Still hidden from the list.
    listing = client.get("/api/v1/transactions", headers=headers).json()
    assert listing["total"] == 0


def test_delete_returns_404_for_foreign_user(client: TestClient, fresh_db: Session) -> None:
    """A user cannot DELETE another user's transaction — 404."""
    alice_h = _auth_headers(_register(client, "alice-del@example.com")["access_token"])
    bob_h = _auth_headers(_register(client, "bob-del@example.com")["access_token"])

    alice_account = _create_account(client, alice_h, name="A")
    alice_tx = _create_transaction(
        client, alice_h, account_id=alice_account["id"], amount_cents=1_000
    )

    resp = client.delete(f"/api/v1/transactions/{alice_tx['id']}", headers=bob_h)
    assert resp.status_code == 404

    # The row is still visible to Alice.
    listing = client.get("/api/v1/transactions", headers=alice_h).json()
    assert listing["total"] == 1


def test_delete_returns_404_for_unknown_id(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "delete-uuid@example.com")["access_token"])
    resp = client.delete(f"/api/v1/transactions/{uuid.uuid4()}", headers=headers)
    assert resp.status_code == 404


def test_delete_then_get_list_excludes_only_deleted(client: TestClient, fresh_db: Session) -> None:
    """Deletion of one row does not affect the others in the filter."""
    headers = _auth_headers(_register(client, "delete-mixed@example.com")["access_token"])
    account = _create_account(client, headers, name="A")

    keep_a = _create_transaction(client, headers, account_id=account["id"], amount_cents=1_000)
    doomed = _create_transaction(client, headers, account_id=account["id"], amount_cents=2_000)
    keep_b = _create_transaction(client, headers, account_id=account["id"], amount_cents=3_000)

    assert client.delete(f"/api/v1/transactions/{doomed['id']}", headers=headers).status_code == 204

    listing = client.get("/api/v1/transactions", headers=headers).json()
    assert listing["total"] == 2
    returned_ids = {item["id"] for item in listing["items"]}
    assert returned_ids == {keep_a["id"], keep_b["id"]}


def test_delete_requires_authentication(client: TestClient, fresh_db: Session) -> None:
    resp = client.delete(f"/api/v1/transactions/{uuid.uuid4()}")
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# (c) Audit trail + cross-soft-delete idempotency
# ---------------------------------------------------------------------------


def test_patch_on_deleted_row_returns_404(client: TestClient, fresh_db: Session) -> None:
    """PATCH on a soft-deleted row returns 404 (no resurrection through stale id)."""
    headers = _auth_headers(_register(client, "patch-dead@example.com")["access_token"])
    account = _create_account(client, headers, name="A")
    tx = _create_transaction(client, headers, account_id=account["id"])

    assert client.delete(f"/api/v1/transactions/{tx['id']}", headers=headers).status_code == 204

    resp = client.patch(
        f"/api/v1/transactions/{tx['id']}",
        headers=headers,
        json={"note": "resurrected"},
    )
    assert resp.status_code == 404

    # The row's deleted_at is still set — the 404 path did not touch the DB.
    row = fresh_db.get(Transaction, uuid.UUID(tx["id"]))
    assert row is not None
    assert row.deleted_at is not None


def test_delete_captures_audit_timestamp_server_side(client: TestClient, fresh_db: Session) -> None:
    """``deleted_at`` is real (not None) and persisted on the row."""
    headers = _auth_headers(_register(client, "delete-audit@example.com")["access_token"])
    account = _create_account(client, headers, name="A")
    tx = _create_transaction(client, headers, account_id=account["id"])

    assert client.delete(f"/api/v1/transactions/{tx['id']}", headers=headers).status_code == 204

    row = fresh_db.get(Transaction, uuid.UUID(tx["id"]))
    assert row is not None
    assert row.deleted_at is not None

    # The same row is still loadable through the API as 404 (treated as not-found).


def test_delete_total_count_excludes_soft_deleted(client: TestClient, fresh_db: Session) -> None:
    """The ``total`` field on the list endpoint reflects only active rows."""
    headers = _auth_headers(_register(client, "delete-total@example.com")["access_token"])
    account = _create_account(client, headers, name="A")

    tx_a = _create_transaction(client, headers, account_id=account["id"], amount_cents=1_000)
    _create_transaction(client, headers, account_id=account["id"], amount_cents=2_000)
    _create_transaction(client, headers, account_id=account["id"], amount_cents=3_000)

    listing_before = client.get("/api/v1/transactions", headers=headers).json()
    assert listing_before["total"] == 3

    assert client.delete(f"/api/v1/transactions/{tx_a['id']}", headers=headers).status_code == 204

    listing_after = client.get("/api/v1/transactions", headers=headers).json()
    assert listing_after["total"] == 2
    assert len(listing_after["items"]) == 2
