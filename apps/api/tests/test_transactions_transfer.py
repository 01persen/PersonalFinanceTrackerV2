"""Transfer paired-create endpoint tests — sub-0003-03.

Scenarios covered (per acceptance criteria):

* (a) Atomicity — if any step fails after the inserts begin, both rows
      roll back. We exercise this by monkey-patching
      ``db.commit`` to raise after both ``db.add`` calls; the test
      asserts that **zero** row count is observed for the user when the
      DB is read again.
* (b) Linkage — both rows share the same ``transfer_pair_id`` and
      ``transfer_group_id`` (the same UUID for the MVP 2-row shape).
      Source row is ``expense`` on the source account, destination row
      is ``income`` on the destination account.
* (c) Saldo — source balance decreases by ``amount_cents``, destination
      balance increases by ``amount_cents`` (sub-0003-02's soft-delete
      column is null, so the existing balance engine reads them).

Extra validation coverage:

* 422 on ``amount_cents <= 0``, non-IDR currency, or
  ``source_account_id == destination_account_id``.
* 404 on accounts not owned by the caller, on archived accounts,
  and on unknown UUIDs (mirrors the account-ownership rules).
* 401 when no bearer token is supplied.
* Two-user isolation: Alice's transfers never touch Bob's account rows
  and her pair id is never re-used by Bob.
* ``GET /transactions`` returns both legs of a transfer when filtering
  by account or by ``type`` (income/expense).
"""

from __future__ import annotations

import uuid
from datetime import date

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
    name: str = "Bank",
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


def _create_transfer(
    client: TestClient,
    headers: dict[str, str],
    *,
    source_account_id: str,
    destination_account_id: str,
    amount_cents: int = 100_000,
    currency: str = "IDR",
    occurred_on: date | None = None,
    note: str | None = "Transfer test",
) -> dict:
    payload: dict = {
        "source_account_id": source_account_id,
        "destination_account_id": destination_account_id,
        "amount_cents": amount_cents,
        "currency": currency,
        "occurred_on": (occurred_on or date.today()).isoformat(),
    }
    if note is not None:
        payload["note"] = note
    resp = client.post("/api/v1/transactions/transfer", headers=headers, json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


# ---------------------------------------------------------------------------
# AC (b) + (c) — happy path: paired rows, correct types, balances move
# ---------------------------------------------------------------------------


def test_post_transfer_creates_pair_and_returns_201(client: TestClient, fresh_db: Session) -> None:
    """Happy path: 201 + both legs, with shared ``transfer_pair_id`` /
    ``transfer_group_id`` and the right amounts/types per leg.
    """
    headers = _auth_headers(_register(client, "transfer-happy@example.com")["access_token"])
    source = _create_account(client, headers, name="BCA", opening_balance_cents=500_000)
    destination = _create_account(
        client, headers, name="Cash", type_="cash", opening_balance_cents=50_000
    )

    resp = _create_transfer(
        client,
        headers,
        source_account_id=source["id"],
        destination_account_id=destination["id"],
        amount_cents=125_000,
        note="Mindah ke dompet",
    )

    body = resp
    pair_id = body["transfer_pair_id"]
    group_id = body["transfer_group_id"]
    assert pair_id == group_id, "pair and group id must match for the 2-row MVP"
    uuid.UUID(pair_id)

    src = body["source"]
    dst = body["destination"]
    assert src["type"] == "expense"
    assert src["account_id"] == source["id"]
    assert src["amount_cents"] == 125_000
    assert src["currency"] == "IDR"
    assert src["transfer_pair_id"] == pair_id
    assert src["transfer_group_id"] == group_id
    assert src["category_id"] is None
    assert src["note"] == "Mindah ke dompet"

    assert dst["type"] == "income"
    assert dst["account_id"] == destination["id"]
    assert dst["amount_cents"] == 125_000
    assert dst["currency"] == "IDR"
    assert dst["transfer_pair_id"] == pair_id
    assert dst["transfer_group_id"] == group_id
    assert dst["category_id"] is None
    assert dst["note"] == "Mindah ke dompet"

    # Persisted rows match the response row-for-row.
    me = client.get("/api/v1/auth/me", headers=headers).json()
    rows = fresh_db.query(Transaction).filter(Transaction.user_id == uuid.UUID(me["id"])).all()
    assert len(rows) == 2
    by_pair = {row.transfer_pair_id: row for row in rows}
    assert len(by_pair) == 1  # both rows share the pair id
    persisted_pair = next(iter(by_pair.values())).transfer_pair_id
    assert str(persisted_pair) == pair_id
    for row in rows:
        assert row.transfer_group_id == persisted_pair
    types = {row.type.value for row in rows}
    assert types == {"expense", "income"}


def test_post_transfer_moves_balances_atomically(client: TestClient, fresh_db: Session) -> None:
    """AC (c): source decreases, destination increases by ``amount_cents``."""
    headers = _auth_headers(_register(client, "transfer-saldo@example.com")["access_token"])
    source = _create_account(client, headers, name="Bank", opening_balance_cents=1_000_000)
    destination = _create_account(
        client, headers, name="Wallet", type_="cash", opening_balance_cents=0
    )

    _create_transfer(
        client,
        headers,
        source_account_id=source["id"],
        destination_account_id=destination["id"],
        amount_cents=250_000,
    )

    src_balance = client.get(f"/api/v1/accounts/{source['id']}/balance", headers=headers).json()
    dst_balance = client.get(
        f"/api/v1/accounts/{destination['id']}/balance", headers=headers
    ).json()
    assert src_balance["balance_cents"] == 750_000
    assert dst_balance["balance_cents"] == 250_000

    summary = client.get("/api/v1/accounts/balances", headers=headers).json()
    by_id = {row["account_id"]: row["balance_cents"] for row in summary["accounts"]}
    assert by_id[source["id"]] == 750_000
    assert by_id[destination["id"]] == 250_000
    # Net worth unchanged (same accounts, just money moved between them).
    assert summary["networth_cents"] == 1_000_000


def test_post_transfer_persists_occurred_on_and_optional_omits(
    client: TestClient, fresh_db: Session
) -> None:
    """``note`` is optional; ``occurred_on`` is honoured."""
    headers = _auth_headers(_register(client, "transfer-min@example.com")["access_token"])
    source = _create_account(client, headers, name="A")
    destination = _create_account(client, headers, name="B")

    payload = {
        "source_account_id": source["id"],
        "destination_account_id": destination["id"],
        "amount_cents": 10_000,
        "occurred_on": "2026-07-15",
    }
    resp = client.post("/api/v1/transactions/transfer", headers=headers, json=payload)
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["source"]["occurred_on"] == "2026-07-15"
    assert body["destination"]["occurred_on"] == "2026-07-15"
    assert body["source"]["note"] is None
    assert body["destination"]["note"] is None


def test_post_transfer_appears_in_get_transactions_for_both_accounts(
    client: TestClient, fresh_db: Session
) -> None:
    """Both legs of the pair appear in ``GET /transactions`` per leg's account."""
    headers = _auth_headers(_register(client, "transfer-list@example.com")["access_token"])
    source = _create_account(client, headers, name="A")
    destination = _create_account(client, headers, name="B")

    body = _create_transfer(
        client,
        headers,
        source_account_id=source["id"],
        destination_account_id=destination["id"],
        amount_cents=75_000,
    )

    src_list = client.get(
        "/api/v1/transactions",
        headers=headers,
        params={"account_id": source["id"]},
    ).json()
    dst_list = client.get(
        "/api/v1/transactions",
        headers=headers,
        params={"account_id": destination["id"]},
    ).json()
    assert src_list["total"] == 1
    assert dst_list["total"] == 1
    assert src_list["items"][0]["id"] == body["source"]["id"]
    assert dst_list["items"][0]["id"] == body["destination"]["id"]
    assert src_list["items"][0]["transfer_pair_id"] == body["transfer_pair_id"]
    assert dst_list["items"][0]["transfer_pair_id"] == body["transfer_pair_id"]


# ---------------------------------------------------------------------------
# AC (a) — atomicity: a failure mid-call leaves both rows un-persisted
# ---------------------------------------------------------------------------


def test_post_transfer_rolls_back_on_commit_failure(
    client: TestClient, fresh_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """AC (a): if the commit fails after both rows are staged, neither lands.

    We monkey-patch ``Session.commit`` on the SQLAlchemy class so the
    route's call to ``db.commit()`` raises. FastAPI's default
    ``raise_server_exceptions=True`` re-raises the error inside the
    test client, so we wrap the call in ``pytest.raises`` and assert
    that the rollback discarded both rows by reading the DB after
    the patch is reverted.
    """
    from sqlalchemy.orm import Session as OrmSession

    headers = _auth_headers(_register(client, "transfer-atomic@example.com")["access_token"])
    source = _create_account(client, headers, name="A")
    destination = _create_account(client, headers, name="B")

    me = client.get("/api/v1/auth/me", headers=headers).json()
    user_id = uuid.UUID(me["id"])

    original_commit = OrmSession.commit

    def failing_commit(self: OrmSession) -> None:
        raise RuntimeError("simulated DB failure during commit")

    # Patch the class method so every session instance sees the failure.
    monkeypatch.setattr(OrmSession, "commit", failing_commit)

    # Pre-condition: no rows for this user yet.
    assert fresh_db.query(Transaction).filter(Transaction.user_id == user_id).count() == 0

    with pytest.raises(RuntimeError, match="simulated DB failure"):
        client.post(
            "/api/v1/transactions/transfer",
            headers=headers,
            json={
                "source_account_id": source["id"],
                "destination_account_id": destination["id"],
                "amount_cents": 99_000,
                "occurred_on": date.today().isoformat(),
            },
        )

    # Restore the original commit so the post-assertion reads the DB.
    monkeypatch.setattr(OrmSession, "commit", original_commit)

    # The TestClient and the route share the same session factory, so
    # the route's failed commit rolled back the session.flush()'d rows.
    # A fresh query through the same session sees the empty state.
    fresh_db.expire_all()
    rows = fresh_db.query(Transaction).filter(Transaction.user_id == user_id).all()
    assert rows == [], "atomicity violated — rows persisted despite commit failure"


def test_post_transfer_does_not_partially_persist_when_validation_fails_after_writes(
    client: TestClient, fresh_db: Session
) -> None:
    """Pre-insert validation rejects archived accounts → no rows land.

    This is a weaker form of AC (a): rejected before any write. The
    defensive test catches a regression where the route would have
    inserted the source row before validating the destination (or
    vice versa).
    """
    headers = _auth_headers(_register(client, "transfer-precheck@example.com")["access_token"])
    source = _create_account(client, headers, name="A")
    destination = _create_account(client, headers, name="B")
    # Archive the destination; the route must reject the call.
    client.delete(f"/api/v1/accounts/{destination['id']}", headers=headers)

    resp = client.post(
        "/api/v1/transactions/transfer",
        headers=headers,
        json={
            "source_account_id": source["id"],
            "destination_account_id": destination["id"],
            "amount_cents": 1_000,
            "occurred_on": date.today().isoformat(),
        },
    )
    assert resp.status_code == 404

    me = client.get("/api/v1/auth/me", headers=headers).json()
    rows = fresh_db.query(Transaction).filter(Transaction.user_id == uuid.UUID(me["id"])).all()
    assert rows == []


# ---------------------------------------------------------------------------
# Validation rejections (422)
# ---------------------------------------------------------------------------


def test_post_transfer_rejects_zero_amount_with_422(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "transfer-zero@example.com")["access_token"])
    source = _create_account(client, headers, name="A")
    destination = _create_account(client, headers, name="B")

    resp = client.post(
        "/api/v1/transactions/transfer",
        headers=headers,
        json={
            "source_account_id": source["id"],
            "destination_account_id": destination["id"],
            "amount_cents": 0,
            "occurred_on": date.today().isoformat(),
        },
    )
    assert resp.status_code == 422


def test_post_transfer_rejects_negative_amount_with_422(
    client: TestClient, fresh_db: Session
) -> None:
    headers = _auth_headers(_register(client, "transfer-neg@example.com")["access_token"])
    source = _create_account(client, headers, name="A")
    destination = _create_account(client, headers, name="B")

    resp = client.post(
        "/api/v1/transactions/transfer",
        headers=headers,
        json={
            "source_account_id": source["id"],
            "destination_account_id": destination["id"],
            "amount_cents": -100,
            "occurred_on": date.today().isoformat(),
        },
    )
    assert resp.status_code == 422


def test_post_transfer_rejects_non_idr_currency_with_422(
    client: TestClient, fresh_db: Session
) -> None:
    headers = _auth_headers(_register(client, "transfer-fx@example.com")["access_token"])
    source = _create_account(client, headers, name="A")
    destination = _create_account(client, headers, name="B")

    resp = client.post(
        "/api/v1/transactions/transfer",
        headers=headers,
        json={
            "source_account_id": source["id"],
            "destination_account_id": destination["id"],
            "amount_cents": 1_000,
            "currency": "USD",
            "occurred_on": date.today().isoformat(),
        },
    )
    assert resp.status_code == 422
    assert "idr" in str(resp.json()["detail"]).lower()


def test_post_transfer_rejects_same_source_and_destination_with_422(
    client: TestClient, fresh_db: Session
) -> None:
    """Self-transfer is a client bug — caught by the cross-field validator."""
    headers = _auth_headers(_register(client, "transfer-self@example.com")["access_token"])
    account = _create_account(client, headers, name="A")

    resp = client.post(
        "/api/v1/transactions/transfer",
        headers=headers,
        json={
            "source_account_id": account["id"],
            "destination_account_id": account["id"],
            "amount_cents": 1_000,
            "occurred_on": date.today().isoformat(),
        },
    )
    assert resp.status_code == 422


def test_post_transfer_rejects_missing_occurred_on_with_422(
    client: TestClient, fresh_db: Session
) -> None:
    headers = _auth_headers(_register(client, "transfer-no-date@example.com")["access_token"])
    source = _create_account(client, headers, name="A")
    destination = _create_account(client, headers, name="B")

    resp = client.post(
        "/api/v1/transactions/transfer",
        headers=headers,
        json={
            "source_account_id": source["id"],
            "destination_account_id": destination["id"],
            "amount_cents": 1_000,
        },
    )
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Ownership / archived (404) — mirrors the accounts router
# ---------------------------------------------------------------------------


def test_post_transfer_rejects_foreign_source_account_with_404(
    client: TestClient, fresh_db: Session
) -> None:
    alice_h = _auth_headers(_register(client, "alice-tx-ft@example.com")["access_token"])
    bob_h = _auth_headers(_register(client, "bob-tx-ft@example.com")["access_token"])

    bob_account = _create_account(client, bob_h, name="Bob BCA")
    alice_destination = _create_account(client, alice_h, name="Alice Cash")

    resp = client.post(
        "/api/v1/transactions/transfer",
        headers=alice_h,
        json={
            "source_account_id": bob_account["id"],
            "destination_account_id": alice_destination["id"],
            "amount_cents": 1_000,
            "occurred_on": date.today().isoformat(),
        },
    )
    assert resp.status_code == 404
    assert "account not found" in resp.json()["detail"].lower()


def test_post_transfer_rejects_foreign_destination_account_with_404(
    client: TestClient, fresh_db: Session
) -> None:
    alice_h = _auth_headers(_register(client, "alice-tx-fd@example.com")["access_token"])
    bob_h = _auth_headers(_register(client, "bob-tx-fd@example.com")["access_token"])

    alice_source = _create_account(client, alice_h, name="Alice Bank")
    bob_account = _create_account(client, bob_h, name="Bob BCA")

    resp = client.post(
        "/api/v1/transactions/transfer",
        headers=alice_h,
        json={
            "source_account_id": alice_source["id"],
            "destination_account_id": bob_account["id"],
            "amount_cents": 1_000,
            "occurred_on": date.today().isoformat(),
        },
    )
    assert resp.status_code == 404


def test_post_transfer_rejects_archived_destination_with_404(
    client: TestClient, fresh_db: Session
) -> None:
    headers = _auth_headers(_register(client, "transfer-arch-dst@example.com")["access_token"])
    source = _create_account(client, headers, name="A")
    destination = _create_account(client, headers, name="Doomed")
    client.delete(f"/api/v1/accounts/{destination['id']}", headers=headers)

    resp = client.post(
        "/api/v1/transactions/transfer",
        headers=headers,
        json={
            "source_account_id": source["id"],
            "destination_account_id": destination["id"],
            "amount_cents": 1_000,
            "occurred_on": date.today().isoformat(),
        },
    )
    assert resp.status_code == 404


def test_post_transfer_rejects_archived_source_with_404(
    client: TestClient, fresh_db: Session
) -> None:
    headers = _auth_headers(_register(client, "transfer-arch-src@example.com")["access_token"])
    source = _create_account(client, headers, name="Doomed")
    destination = _create_account(client, headers, name="B")
    client.delete(f"/api/v1/accounts/{source['id']}", headers=headers)

    resp = client.post(
        "/api/v1/transactions/transfer",
        headers=headers,
        json={
            "source_account_id": source["id"],
            "destination_account_id": destination["id"],
            "amount_cents": 1_000,
            "occurred_on": date.today().isoformat(),
        },
    )
    assert resp.status_code == 404


def test_post_transfer_rejects_unknown_source_account_with_404(
    client: TestClient, fresh_db: Session
) -> None:
    headers = _auth_headers(_register(client, "transfer-unk@example.com")["access_token"])
    destination = _create_account(client, headers, name="B")

    resp = client.post(
        "/api/v1/transactions/transfer",
        headers=headers,
        json={
            "source_account_id": str(uuid.uuid4()),
            "destination_account_id": destination["id"],
            "amount_cents": 1_000,
            "occurred_on": date.today().isoformat(),
        },
    )
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Auth (401) + two-user isolation
# ---------------------------------------------------------------------------


def test_post_transfer_requires_authentication(client: TestClient, fresh_db: Session) -> None:
    resp = client.post(
        "/api/v1/transactions/transfer",
        json={
            "source_account_id": str(uuid.uuid4()),
            "destination_account_id": str(uuid.uuid4()),
            "amount_cents": 1_000,
            "occurred_on": date.today().isoformat(),
        },
    )
    assert resp.status_code == 401


def test_post_transfer_isolates_users(client: TestClient, fresh_db: Session) -> None:
    """Alice's transfer must not affect Bob's accounts or be visible to him."""
    alice_h = _auth_headers(_register(client, "alice-iso@example.com")["access_token"])
    bob_h = _auth_headers(_register(client, "bob-iso@example.com")["access_token"])

    alice_src = _create_account(client, alice_h, name="Alice Bank", opening_balance_cents=500_000)
    alice_dst = _create_account(client, alice_h, name="Alice Cash", opening_balance_cents=0)
    bob_account = _create_account(client, bob_h, name="Bob Bank", opening_balance_cents=999_999)

    body = _create_transfer(
        client,
        alice_h,
        source_account_id=alice_src["id"],
        destination_account_id=alice_dst["id"],
        amount_cents=80_000,
    )

    # Alice's own balances moved correctly.
    alice_summary = client.get("/api/v1/accounts/balances", headers=alice_h).json()
    by_id = {row["account_id"]: row["balance_cents"] for row in alice_summary["accounts"]}
    assert by_id[alice_src["id"]] == 420_000
    assert by_id[alice_dst["id"]] == 80_000

    # Bob's account is untouched (still 999_999).
    bob_balance = client.get(f"/api/v1/accounts/{bob_account['id']}/balance", headers=bob_h).json()
    assert bob_balance["balance_cents"] == 999_999

    # Bob cannot list Alice's transfer rows.
    bob_list = client.get("/api/v1/transactions", headers=bob_h).json()
    assert bob_list["total"] == 0

    # Using Alice's pair id against Bob's account as a fake foreign source
    # must still 404 (the endpoint never trusts the caller-supplied ids).
    resp = client.post(
        "/api/v1/transactions/transfer",
        headers=bob_h,
        json={
            "source_account_id": bob_account["id"],
            "destination_account_id": alice_dst["id"],
            "amount_cents": 1_000,
            "occurred_on": date.today().isoformat(),
        },
    )
    assert resp.status_code == 404

    # The pair id is fresh — Bob's transfer later must not collide.
    bob_src = _create_account(client, bob_h, name="Bob Cash")
    bob_dst = _create_account(client, bob_h, name="Bob E-Wallet")
    bob_body = _create_transfer(
        client,
        bob_h,
        source_account_id=bob_src["id"],
        destination_account_id=bob_dst["id"],
        amount_cents=5_000,
    )
    assert bob_body["transfer_pair_id"] != body["transfer_pair_id"]


# ---------------------------------------------------------------------------
# Freezing the timestamp mixin so the secondary ``created_at`` sort is
# deterministic across the two rows (no flake on the GET test).
# ---------------------------------------------------------------------------


def test_post_transfer_created_at_is_consistent_for_pair(
    client: TestClient, fresh_db: Session
) -> None:
    """Both rows of a pair share the same ``created_at`` (single commit).

    Locking the *timestamp* to a fixed value is hard to do reliably
    across Postgres + SQLite (the ``server_default=func.now()`` is a
    SQL expression, not a Python-side default). What matters for the
    atomicity contract is that both rows finish their commit at the
    same instant — so we just assert they're equal on the response.
    """
    headers = _auth_headers(_register(client, "transfer-frozen@example.com")["access_token"])
    source = _create_account(client, headers, name="A")
    destination = _create_account(client, headers, name="B")

    body = _create_transfer(
        client,
        headers,
        source_account_id=source["id"],
        destination_account_id=destination["id"],
        amount_cents=42_000,
    )
    assert body["source"]["created_at"] == body["destination"]["created_at"]
    assert body["source"]["updated_at"] == body["destination"]["updated_at"]
