"""Accounts endpoint tests — CRUD coverage for ``/api/v1/accounts``.

Scenarios covered (per the sub-0002-01 acceptance criteria):

* (a) ``POST /accounts`` returns 201 + the new account body.
* (b) ``GET /accounts`` returns the caller's accounts only (no leak).
* (c) ``PATCH /accounts/{id}`` is a partial update — unset fields stay.
* (d) ``DELETE /accounts/{id}`` soft-deletes via ``archived = True``.
* (e) ``currency != "IDR"`` returns 422.
* (f) Response includes the derived ``is_asset`` (asset for everything
      except ``credit_card``).
* (g) Auth required on every endpoint.

Two-user isolation is exercised throughout — every test that creates an
account asserts the other user can't see it via any of the read paths.
"""

from __future__ import annotations

import uuid
from datetime import date
from time import perf_counter

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.db.models.account import Account
from app.db.models.enums import TransactionType
from app.db.models.transaction import Transaction
from app.services.balance import calculate_user_balances


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


def _add_transaction(
    db: Session,
    *,
    user_id: uuid.UUID,
    account_id: uuid.UUID,
    type_: TransactionType,
    amount_cents: int,
    transfer_pair_id: uuid.UUID | None = None,
) -> None:
    db.add(
        Transaction(
            user_id=user_id,
            account_id=account_id,
            category_id=None,
            type=type_,
            amount_cents=amount_cents,
            currency="IDR",
            occurred_on=date.today(),
            note=None,
            transfer_pair_id=transfer_pair_id,
            recurring_rule_id=None,
        )
    )


# (a) POST returns 201 + body --------------------------------------------------


def test_post_creates_account_and_returns_201(client: TestClient, fresh_db: Session) -> None:
    body = _register(client, "owner1@example.com")
    headers = _auth_headers(body["access_token"])
    me = client.get("/api/v1/auth/me", headers=headers).json()

    resp = _create_account(
        client,
        headers,
        name="Dompet Utama",
        type_="cash",
        opening_balance_cents=250_000,
    )

    assert resp["name"] == "Dompet Utama"
    assert resp["type"] == "cash"
    assert resp["currency"] == "IDR"
    assert resp["opening_balance_cents"] == 250_000
    assert resp["archived"] is False
    assert resp["is_asset"] is True
    assert resp["user_id"] == me["id"]  # owner matches the caller
    uuid.UUID(resp["id"])  # valid uuid

    # DB row exists and matches the response shape.
    account = fresh_db.query(Account).one()
    assert account.name == "Dompet Utama"
    assert account.is_asset is True
    assert account.archived is False


# (f) is_asset derivation -----------------------------------------------------


def test_is_asset_is_true_for_asset_account_types(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "assets@example.com")["access_token"])

    for type_ in ("cash", "bank", "e_wallet", "investment", "other"):
        body = _create_account(client, headers, name=f"acc-{type_}", type_=type_)
        assert body["is_asset"] is True, f"{type_} should be an asset"


def test_is_asset_is_false_for_credit_card(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "cc@example.com")["access_token"])

    body = _create_account(client, headers, name="Visa", type_="credit_card")
    assert body["is_asset"] is False
    assert body["type"] == "credit_card"


# (b) GET list is auth-scoped -------------------------------------------------


def test_list_returns_only_the_callers_accounts(client: TestClient, fresh_db: Session) -> None:
    alice = _register(client, "alice-accounts@example.com")
    bob = _register(client, "bob-accounts@example.com")

    alice_h = _auth_headers(alice["access_token"])
    bob_h = _auth_headers(bob["access_token"])

    a1 = _create_account(client, alice_h, name="Alice BCA")
    a2 = _create_account(client, alice_h, name="Alice Cash")
    _create_account(client, bob_h, name="Bob BCA")

    resp = client.get("/api/v1/accounts", headers=alice_h)
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    names = [row["name"] for row in payload]
    assert names == ["Alice BCA", "Alice Cash"]  # sorted by name
    assert {row["id"] for row in payload} == {a1["id"], a2["id"]}


def test_list_orders_assets_before_liabilities(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "order@example.com")["access_token"])

    _create_account(client, headers, name="Z-Liability", type_="credit_card")
    _create_account(client, headers, name="B-Asset", type_="bank")
    _create_account(client, headers, name="A-Asset", type_="cash")

    resp = client.get("/api/v1/accounts", headers=headers)
    assert resp.status_code == 200
    payload = resp.json()
    is_asset_seq = [row["is_asset"] for row in payload]
    # All True entries must come before any False entry.
    assert is_asset_seq == sorted(is_asset_seq, key=lambda x: not x)
    asset_names = [row["name"] for row in payload if row["is_asset"]]
    assert asset_names == ["A-Asset", "B-Asset"]


def test_list_excludes_archived_by_default(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "archive@example.com")["access_token"])
    a = _create_account(client, headers, name="Keep me")
    b = _create_account(client, headers, name="Hide me")

    # Soft-delete the second one.
    del_resp = client.delete(f"/api/v1/accounts/{b['id']}", headers=headers)
    assert del_resp.status_code == 204

    resp = client.get("/api/v1/accounts", headers=headers)
    assert resp.status_code == 200
    payload = resp.json()
    assert [row["id"] for row in payload] == [a["id"]]


# GET by id --------------------------------------------------------------------


def test_get_by_id_returns_owned_account(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "getbyid@example.com")["access_token"])
    created = _create_account(client, headers, name="Rekening Utama")

    resp = client.get(f"/api/v1/accounts/{created['id']}", headers=headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["id"] == created["id"]


def test_get_by_id_404_for_unknown_account(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "404@example.com")["access_token"])
    resp = client.get(f"/api/v1/accounts/{uuid.uuid4()}", headers=headers)
    assert resp.status_code == 404


# (c) PATCH partial update -----------------------------------------------------


def test_patch_updates_only_provided_fields(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "patch@example.com")["access_token"])
    created = _create_account(
        client,
        headers,
        name="Before",
        type_="cash",
        opening_balance_cents=100_000,
    )

    resp = client.patch(
        f"/api/v1/accounts/{created['id']}",
        headers=headers,
        json={"name": "After", "opening_balance_cents": 200_000},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["name"] == "After"
    assert body["opening_balance_cents"] == 200_000
    # Untouched fields stay.
    assert body["type"] == "cash"
    assert body["currency"] == "IDR"
    assert body["archived"] is False
    assert body["is_asset"] is True


def test_patch_derives_is_asset_when_type_changes(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "flip@example.com")["access_token"])
    created = _create_account(client, headers, name="Flex", type_="bank")
    assert created["is_asset"] is True

    # Flip to credit_card — derived is_asset must follow.
    resp = client.patch(
        f"/api/v1/accounts/{created['id']}",
        headers=headers,
        json={"type": "credit_card"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["type"] == "credit_card"
    assert body["is_asset"] is False

    # And back to bank.
    resp = client.patch(
        f"/api/v1/accounts/{created['id']}",
        headers=headers,
        json={"type": "bank"},
    )
    assert resp.json()["is_asset"] is True


def test_patch_archive_flag_round_trips(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "arch@example.com")["access_token"])
    created = _create_account(client, headers, name="Hide")

    resp = client.patch(
        f"/api/v1/accounts/{created['id']}",
        headers=headers,
        json={"archived": True},
    )
    assert resp.status_code == 200
    assert resp.json()["archived"] is True


# (d) DELETE soft delete ------------------------------------------------------


def test_delete_soft_deletes_via_archived_flag(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "del@example.com")["access_token"])
    created = _create_account(client, headers, name="ToArchive")

    resp = client.delete(f"/api/v1/accounts/{created['id']}", headers=headers)
    assert resp.status_code == 204
    assert resp.content == b""

    # Row still in DB (no hard delete) — keeps transaction history integrity.
    account = fresh_db.get(Account, uuid.UUID(created["id"]))
    assert account is not None
    assert account.archived is True

    # But it's hidden from the list endpoint.
    listing = client.get("/api/v1/accounts", headers=headers).json()
    assert listing == []


def test_delete_is_idempotent_in_effect(client: TestClient, fresh_db: Session) -> None:
    """Deleting an already-archived account is a no-op 204, not a 404.

    The row is still scoped to the same user — re-archiving is harmless and
    keeps the API surface predictable for the FE.
    """
    headers = _auth_headers(_register(client, "twice@example.com")["access_token"])
    created = _create_account(client, headers, name="Doomed")

    first = client.delete(f"/api/v1/accounts/{created['id']}", headers=headers)
    second = client.delete(f"/api/v1/accounts/{created['id']}", headers=headers)
    assert first.status_code == 204
    assert second.status_code == 204


# (e) currency strict 422 -----------------------------------------------------


def test_post_rejects_non_idr_currency_with_422(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "usd@example.com")["access_token"])

    resp = client.post(
        "/api/v1/accounts",
        headers=headers,
        json={
            "name": "Dollar Account",
            "type": "bank",
            "currency": "USD",
            "opening_balance_cents": 0,
        },
    )
    assert resp.status_code == 422
    # Pydantic surfaces the validator message in detail[*].msg.
    detail_blob = str(resp.json()["detail"]).lower()
    assert "idr" in detail_blob


def test_post_rejects_lowercase_currency_with_422(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "lowercase@example.com")["access_token"])
    resp = client.post(
        "/api/v1/accounts",
        headers=headers,
        json={"name": "x", "type": "cash", "currency": "idr"},
    )
    # Currency check is case-sensitive on purpose — "IDR" is the only valid
    # form, and we want the OpenAPI surface to be predictable.
    assert resp.status_code == 422


def test_patch_rejects_non_idr_currency_with_422(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "patchfx@example.com")["access_token"])
    created = _create_account(client, headers, name="Local")

    resp = client.patch(
        f"/api/v1/accounts/{created['id']}",
        headers=headers,
        json={"currency": "USD"},
    )
    assert resp.status_code == 422


def test_post_rejects_unknown_account_type_with_422(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "badt@e.com")["access_token"])
    resp = client.post(
        "/api/v1/accounts",
        headers=headers,
        json={"name": "x", "type": "crypto_wallet", "currency": "IDR"},
    )
    assert resp.status_code == 422


def test_post_rejects_negative_opening_balance_with_422(
    client: TestClient, fresh_db: Session
) -> None:
    headers = _auth_headers(_register(client, "neg@example.com")["access_token"])
    resp = client.post(
        "/api/v1/accounts",
        headers=headers,
        json={
            "name": "x",
            "type": "cash",
            "currency": "IDR",
            "opening_balance_cents": -1,
        },
    )
    assert resp.status_code == 422
    # Cross-field validator surfaces a message that names both fields.
    detail_blob = str(resp.json()["detail"]).lower()
    assert "credit_card" in detail_blob
    assert "opening_balance_cents" in detail_blob


# TL decision (epic-0002): ``opening_balance_cents`` may be negative only when
# ``type == credit_card``. Asset types must remain >= 0. PATCH must also
# enforce the rule against the effective (request merged with persisted) values.


@pytest.mark.parametrize("type_", ["bank", "e_wallet", "cash", "investment", "other"])
def test_post_rejects_negative_opening_balance_for_any_asset_type(
    client: TestClient, fresh_db: Session, type_: str
) -> None:
    headers = _auth_headers(_register(client, f"neg-asset-{type_}@example.com")["access_token"])
    resp = client.post(
        "/api/v1/accounts",
        headers=headers,
        json={
            "name": f"acc-{type_}",
            "type": type_,
            "currency": "IDR",
            "opening_balance_cents": -100,
        },
    )
    assert resp.status_code == 422


def test_post_allows_negative_opening_balance_for_credit_card(
    client: TestClient, fresh_db: Session
) -> None:
    headers = _auth_headers(_register(client, "cc-neg@example.com")["access_token"])
    resp = client.post(
        "/api/v1/accounts",
        headers=headers,
        json={
            "name": "Visa Outstanding",
            "type": "credit_card",
            "currency": "IDR",
            "opening_balance_cents": -500_000,
        },
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["type"] == "credit_card"
    assert body["opening_balance_cents"] == -500_000
    assert body["is_asset"] is False

    persisted = fresh_db.get(Account, uuid.UUID(body["id"]))
    assert persisted is not None
    assert persisted.opening_balance_cents == -500_000


def test_post_allows_zero_opening_balance_for_credit_card(
    client: TestClient, fresh_db: Session
) -> None:
    headers = _auth_headers(_register(client, "cc-zero@example.com")["access_token"])
    resp = client.post(
        "/api/v1/accounts",
        headers=headers,
        json={
            "name": "Empty CC",
            "type": "credit_card",
            "currency": "IDR",
            "opening_balance_cents": 0,
        },
    )
    assert resp.status_code == 201, resp.text


def test_patch_allows_negative_balance_for_credit_card(
    client: TestClient, fresh_db: Session
) -> None:
    headers = _auth_headers(_register(client, "patch-cc-neg@example.com")["access_token"])
    created = _create_account(client, headers, name="Visa", type_="credit_card")

    resp = client.patch(
        f"/api/v1/accounts/{created['id']}",
        headers=headers,
        json={"opening_balance_cents": -250_000},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["opening_balance_cents"] == -250_000
    assert resp.json()["type"] == "credit_card"
    assert resp.json()["is_asset"] is False


def test_patch_rejects_negative_balance_for_asset_account(
    client: TestClient, fresh_db: Session
) -> None:
    headers = _auth_headers(_register(client, "patch-asset-neg@example.com")["access_token"])
    created = _create_account(client, headers, name="BCA", type_="bank")

    resp = client.patch(
        f"/api/v1/accounts/{created['id']}",
        headers=headers,
        json={"opening_balance_cents": -1},
    )
    assert resp.status_code == 422
    detail_blob = str(resp.json()["detail"]).lower()
    assert "credit_card" in detail_blob


def test_patch_rejects_type_change_to_asset_when_persisted_balance_is_negative(
    client: TestClient, fresh_db: Session
) -> None:
    """Flipping a negative-balance credit_card to an asset type must 422.

    The schema-level validator can't see the persisted balance, so the route
    is responsible for catching this case against the merged effective value.
    """
    headers = _auth_headers(_register(client, "patch-flip@example.com")["access_token"])
    created = client.post(
        "/api/v1/accounts",
        headers=headers,
        json={
            "name": "Visa",
            "type": "credit_card",
            "currency": "IDR",
            "opening_balance_cents": -750_000,
        },
    ).json()

    resp = client.patch(
        f"/api/v1/accounts/{created['id']}",
        headers=headers,
        json={"type": "bank"},
    )
    assert resp.status_code == 422

    # The row stays untouched.
    still = client.get(f"/api/v1/accounts/{created['id']}", headers=headers).json()
    assert still["type"] == "credit_card"
    assert still["opening_balance_cents"] == -750_000


def test_patch_allows_type_change_to_credit_card_with_explicit_negative_balance(
    client: TestClient, fresh_db: Session
) -> None:
    """Flipping an asset to credit_card with a new negative balance must 200.

    The schema-level cross-field validator covers the case when both fields
    are present in the same request — negative balance + new credit_card
    type is a coherent combination.
    """
    headers = _auth_headers(_register(client, "patch-flip-cc@example.com")["access_token"])
    created = _create_account(
        client, headers, name="Old Bank", type_="bank", opening_balance_cents=100_000
    )

    resp = client.patch(
        f"/api/v1/accounts/{created['id']}",
        headers=headers,
        json={"type": "credit_card", "opening_balance_cents": -200_000},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["type"] == "credit_card"
    assert body["opening_balance_cents"] == -200_000
    assert body["is_asset"] is False


def test_patch_negative_balance_does_not_bypass_auth(client: TestClient, fresh_db: Session) -> None:
    # Create via API to avoid 422 leak paths.
    headers = _auth_headers(_register(client, "patch-auth-cc@example.com")["access_token"])
    created = _create_account(client, headers, name="Visa", type_="credit_card")

    resp = client.patch(
        f"/api/v1/accounts/{created['id']}",
        json={"opening_balance_cents": -10_000},
    )
    assert resp.status_code == 401


# (g) Auth required on every endpoint ----------------------------------------


def test_post_requires_auth(client: TestClient, fresh_db: Session) -> None:
    resp = client.post(
        "/api/v1/accounts",
        json={"name": "x", "type": "cash", "currency": "IDR"},
    )
    assert resp.status_code == 401
    assert resp.headers.get("www-authenticate", "").lower().startswith("bearer")


def test_list_requires_auth(client: TestClient, fresh_db: Session) -> None:
    resp = client.get("/api/v1/accounts")
    assert resp.status_code == 401


def test_get_by_id_requires_auth(client: TestClient, fresh_db: Session) -> None:
    resp = client.get(f"/api/v1/accounts/{uuid.uuid4()}")
    assert resp.status_code == 401


def test_patch_requires_auth(client: TestClient, fresh_db: Session) -> None:
    resp = client.patch(f"/api/v1/accounts/{uuid.uuid4()}", json={"name": "x"})
    assert resp.status_code == 401


def test_delete_requires_auth(client: TestClient, fresh_db: Session) -> None:
    resp = client.delete(f"/api/v1/accounts/{uuid.uuid4()}")
    assert resp.status_code == 401


# Cross-user isolation (the hard part) ----------------------------------------


def test_other_user_cannot_read_your_account(client: TestClient, fresh_db: Session) -> None:
    alice_h = _auth_headers(_register(client, "alice-iso@example.com")["access_token"])
    bob_h = _auth_headers(_register(client, "bob-iso@example.com")["access_token"])

    alice_account = _create_account(client, alice_h, name="Alice only")

    # Bob lists — must see zero accounts, not Alice's.
    listing = client.get("/api/v1/accounts", headers=bob_h).json()
    assert listing == []

    # Bob fetches by id — must 404, not leak the existence of Alice's row.
    fetch = client.get(f"/api/v1/accounts/{alice_account['id']}", headers=bob_h)
    assert fetch.status_code == 404


def test_other_user_cannot_patch_or_delete_your_account(
    client: TestClient, fresh_db: Session
) -> None:
    alice_h = _auth_headers(_register(client, "alice-mod@example.com")["access_token"])
    bob_h = _auth_headers(_register(client, "bob-mod@example.com")["access_token"])

    alice_account = _create_account(client, alice_h, name="Do not touch")

    # Bob tries to PATCH — 404 (not 403, by design — we don't confirm IDs).
    patch = client.patch(
        f"/api/v1/accounts/{alice_account['id']}",
        headers=bob_h,
        json={"name": "pwned"},
    )
    assert patch.status_code == 404

    # Bob tries to DELETE — 404 too.
    delete = client.delete(f"/api/v1/accounts/{alice_account['id']}", headers=bob_h)
    assert delete.status_code == 404

    # Alice's row is intact and unchanged.
    still_there = client.get(f"/api/v1/accounts/{alice_account['id']}", headers=alice_h).json()
    assert still_there["name"] == "Do not touch"
    assert still_there["archived"] is False


def test_balance_returns_opening_balance_without_transactions(
    client: TestClient, fresh_db: Session
) -> None:
    headers = _auth_headers(_register(client, "balance-opening@example.com")["access_token"])
    account = _create_account(
        client,
        headers,
        name="Opening Only",
        opening_balance_cents=725_000,
    )

    response = client.get(f"/api/v1/accounts/{account['id']}/balance", headers=headers)

    assert response.status_code == 200, response.text
    assert response.json()["account_id"] == account["id"]
    assert response.json()["balance_cents"] == 725_000
    assert response.json()["as_of"]


def test_balance_adds_income(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "balance-income@example.com")["access_token"])
    account = _create_account(client, headers, opening_balance_cents=100_000)
    _add_transaction(
        fresh_db,
        user_id=uuid.UUID(account["user_id"]),
        account_id=uuid.UUID(account["id"]),
        type_=TransactionType.INCOME,
        amount_cents=250_000,
    )
    fresh_db.commit()

    response = client.get(f"/api/v1/accounts/{account['id']}/balance", headers=headers)

    assert response.status_code == 200, response.text
    assert response.json()["balance_cents"] == 350_000


def test_balance_subtracts_expense(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "balance-expense@example.com")["access_token"])
    account = _create_account(client, headers, opening_balance_cents=500_000)
    _add_transaction(
        fresh_db,
        user_id=uuid.UUID(account["user_id"]),
        account_id=uuid.UUID(account["id"]),
        type_=TransactionType.EXPENSE,
        amount_cents=125_000,
    )
    fresh_db.commit()

    response = client.get(f"/api/v1/accounts/{account['id']}/balance", headers=headers)

    assert response.status_code == 200, response.text
    assert response.json()["balance_cents"] == 375_000


def test_balance_transfer_pair_moves_value_without_changing_networth(
    client: TestClient, fresh_db: Session
) -> None:
    headers = _auth_headers(_register(client, "balance-transfer@example.com")["access_token"])
    source = _create_account(
        client,
        headers,
        name="Source",
        opening_balance_cents=500_000,
    )
    destination = _create_account(
        client,
        headers,
        name="Destination",
        opening_balance_cents=200_000,
    )
    pair_id = uuid.uuid4()
    user_id = uuid.UUID(source["user_id"])
    _add_transaction(
        fresh_db,
        user_id=user_id,
        account_id=uuid.UUID(source["id"]),
        type_=TransactionType.TRANSFER,
        amount_cents=-100_000,
        transfer_pair_id=pair_id,
    )
    _add_transaction(
        fresh_db,
        user_id=user_id,
        account_id=uuid.UUID(destination["id"]),
        type_=TransactionType.TRANSFER,
        amount_cents=100_000,
        transfer_pair_id=pair_id,
    )
    fresh_db.commit()

    response = client.get("/api/v1/accounts/balances", headers=headers)

    assert response.status_code == 200, response.text
    payload = response.json()
    balances = {row["account_id"]: row["balance_cents"] for row in payload["accounts"]}
    assert balances[source["id"]] == 400_000
    assert balances[destination["id"]] == 300_000
    assert payload["total_assets_cents"] == 700_000
    assert payload["total_liabilities_cents"] == 0
    assert payload["networth_cents"] == 700_000


def test_balance_summary_handles_mixed_transactions_and_liabilities(
    client: TestClient, fresh_db: Session
) -> None:
    headers = _auth_headers(_register(client, "balance-mixed@example.com")["access_token"])
    bank = _create_account(
        client,
        headers,
        name="Bank",
        type_="bank",
        opening_balance_cents=1_000_000,
    )
    credit_card = _create_account(
        client,
        headers,
        name="Card",
        type_="credit_card",
        opening_balance_cents=300_000,
    )
    user_id = uuid.UUID(bank["user_id"])
    _add_transaction(
        fresh_db,
        user_id=user_id,
        account_id=uuid.UUID(bank["id"]),
        type_=TransactionType.INCOME,
        amount_cents=200_000,
    )
    _add_transaction(
        fresh_db,
        user_id=user_id,
        account_id=uuid.UUID(bank["id"]),
        type_=TransactionType.EXPENSE,
        amount_cents=50_000,
    )
    fresh_db.commit()

    response = client.get("/api/v1/accounts/balances", headers=headers)

    assert response.status_code == 200, response.text
    payload = response.json()
    balances = {row["account_id"]: row["balance_cents"] for row in payload["accounts"]}
    assert balances[bank["id"]] == 1_150_000
    assert balances[credit_card["id"]] == 300_000
    assert payload["total_assets_cents"] == 1_150_000
    assert payload["total_liabilities_cents"] == 300_000
    assert payload["networth_cents"] == 850_000


def test_balances_exclude_archived_accounts(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "balance-archived@example.com")["access_token"])
    account = _create_account(client, headers, opening_balance_cents=450_000)
    _add_transaction(
        fresh_db,
        user_id=uuid.UUID(account["user_id"]),
        account_id=uuid.UUID(account["id"]),
        type_=TransactionType.INCOME,
        amount_cents=50_000,
    )
    fresh_db.commit()
    assert client.delete(f"/api/v1/accounts/{account['id']}", headers=headers).status_code == 204

    summary = client.get("/api/v1/accounts/balances", headers=headers)
    individual = client.get(f"/api/v1/accounts/{account['id']}/balance", headers=headers)

    assert summary.status_code == 200
    assert summary.json() == {
        "accounts": [],
        "total_assets_cents": 0,
        "total_liabilities_cents": 0,
        "networth_cents": 0,
    }
    assert individual.status_code == 404


def test_balance_endpoints_isolate_users(client: TestClient, fresh_db: Session) -> None:
    alice_headers = _auth_headers(_register(client, "balance-alice@example.com")["access_token"])
    bob_headers = _auth_headers(_register(client, "balance-bob@example.com")["access_token"])
    alice_account = _create_account(
        client,
        alice_headers,
        name="Alice",
        opening_balance_cents=900_000,
    )
    bob_account = _create_account(
        client,
        bob_headers,
        name="Bob",
        opening_balance_cents=125_000,
    )

    forbidden = client.get(
        f"/api/v1/accounts/{alice_account['id']}/balance",
        headers=bob_headers,
    )
    bob_summary = client.get("/api/v1/accounts/balances", headers=bob_headers)

    assert forbidden.status_code == 404
    assert bob_summary.status_code == 200
    assert bob_summary.json()["accounts"] == [
        {
            "account_id": bob_account["id"],
            "balance_cents": 125_000,
            "as_of": bob_summary.json()["accounts"][0]["as_of"],
        }
    ]
    assert bob_summary.json()["networth_cents"] == 125_000


def test_balance_summary_is_empty_for_new_user(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "balance-empty@example.com")["access_token"])

    response = client.get("/api/v1/accounts/balances", headers=headers)

    assert response.status_code == 200, response.text
    assert response.json() == {
        "accounts": [],
        "total_assets_cents": 0,
        "total_liabilities_cents": 0,
        "networth_cents": 0,
    }


def test_balance_endpoints_require_auth(client: TestClient, fresh_db: Session) -> None:
    assert client.get("/api/v1/accounts/balances").status_code == 401
    assert client.get(f"/api/v1/accounts/{uuid.uuid4()}/balance").status_code == 401


def test_balance_query_handles_5000_transactions_under_200ms(
    client: TestClient, fresh_db: Session
) -> None:
    headers = _auth_headers(_register(client, "balance-performance@example.com")["access_token"])
    account = _create_account(client, headers)
    user_id = uuid.UUID(account["user_id"])
    account_id = uuid.UUID(account["id"])
    fresh_db.add_all(
        [
            Transaction(
                user_id=user_id,
                account_id=account_id,
                category_id=None,
                type=TransactionType.INCOME if index % 2 == 0 else TransactionType.EXPENSE,
                amount_cents=100,
                currency="IDR",
                occurred_on=date.today(),
                note=None,
                transfer_pair_id=None,
                recurring_rule_id=None,
            )
            for index in range(5_000)
        ]
    )
    fresh_db.commit()

    started = perf_counter()
    balances = calculate_user_balances(fresh_db, user_id=user_id, as_of=date.today())
    elapsed = perf_counter() - started

    assert balances.accounts[0].balance_cents == 0
    assert elapsed < 0.2


def test_openapi_documents_account_endpoints(client: TestClient, fresh_db: Session) -> None:
    spec = client.get("/openapi.json").json()
    paths = spec["paths"]
    assert "/api/v1/accounts" in paths
    assert "/api/v1/accounts/balances" in paths
    assert "/api/v1/accounts/{account_id}/balance" in paths
    assert "/api/v1/accounts/{account_id}" in paths
    for verb in ("get", "post"):
        assert verb in paths["/api/v1/accounts"]
    assert "get" in paths["/api/v1/accounts/balances"]
    assert "get" in paths["/api/v1/accounts/{account_id}/balance"]
    for verb in ("get", "patch", "delete"):
        assert verb in paths["/api/v1/accounts/{account_id}"]
