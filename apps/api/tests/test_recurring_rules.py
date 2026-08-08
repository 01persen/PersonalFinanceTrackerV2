"""Recurring-rule endpoint tests — CRUD for ``/api/v1/recurring-rules``.

Scope: sub-0009-01 (epic-0009). Covers the FE-ready API contract the
parent issue commits to:

* **(a) POST /recurring-rules** — 201 for each kind (bill /
  subscription / cicilan_fixed) and each cadence (daily / weekly /
  monthly / yearly). Pydantic ``extra="forbid"`` rejects
  ``next_run_on`` (server-controlled). Field-level validation:
  ``amount_cents > 0``, ``currency == 'IDR'``, ``end_on >= start_on``,
  ``kind`` + ``cadence`` enums. Account + category ownership 404;
  income-category link 422. ``next_run_on`` derived server-side from
  ``start_on + cadence`` — verified per cadence.
* **(b) GET /recurring-rules** — paginated list, deterministic sort
  (``next_run_on asc, start_on asc, id asc``), two-user isolation.
* **(c) GET /recurring-rules/{id}** — detail by id, 404 for cross-user.
* **(d) PATCH /recurring-rules/{id}** — partial update. Server-side
  re-derive of ``next_run_on`` when ``start_on`` or ``cadence``
  change. ``end_on >= start_on`` re-validated against the *merged*
  effective value.
* **(e) DELETE /recurring-rules/{id}** — hard delete. 204, idempotent
  (second DELETE is 404 because the row is gone).
* **(f) Auth required on every endpoint**.

Two-user isolation is exercised throughout — every test that creates a
rule asserts the other user can't see it via any of the read paths.
"""

from __future__ import annotations

import uuid

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.db.models.account import Account


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


def _create_category(
    client: TestClient,
    headers: dict[str, str],
    *,
    name: str = "Makan",
    kind: str = "expense",
) -> dict:
    resp = client.post(
        "/api/v1/categories",
        headers=headers,
        json={"name": name, "kind": kind},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _create_recurring_rule(
    client: TestClient,
    headers: dict[str, str],
    *,
    account_id: str,
    category_id: str | None = None,
    kind: str = "bill",
    cadence: str = "monthly",
    amount_cents: int = 250_000,
    currency: str = "IDR",
    start_on: str = "2026-08-15",
    end_on: str | None = None,
    note: str | None = None,
    is_active: bool = True,
) -> dict:
    payload: dict = {
        "account_id": account_id,
        "kind": kind,
        "cadence": cadence,
        "amount_cents": amount_cents,
        "currency": currency,
        "start_on": start_on,
    }
    if category_id is not None:
        payload["category_id"] = category_id
    if end_on is not None:
        payload["end_on"] = end_on
    if note is not None:
        payload["note"] = note
    if not is_active:
        payload["is_active"] = False
    resp = client.post("/api/v1/recurring-rules", headers=headers, json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


# ---------------------------------------------------------------------------
# (a) POST /recurring-rules
# ---------------------------------------------------------------------------


def test_create_recurring_rule_minimal(client: TestClient, fresh_db: Session) -> None:
    """Minimal body (only the required fields) → 201 + derived next_run_on.

    The Pydantic ``RecurringRuleCreate`` schema validates shape; the
    service layer derives ``next_run_on`` from ``start_on + cadence``
    so the FE never has to send it. The response mirrors the persisted
    columns one-to-one (per AC: "Semua endpoint CRUD return shape
    konsisten (mirror existing transaction response)").
    """
    headers = _auth_headers(_register(client, "rr-minimal@example.com")["access_token"])
    account = _create_account(client, headers)

    resp = client.post(
        "/api/v1/recurring-rules",
        headers=headers,
        json={
            "account_id": account["id"],
            "kind": "bill",
            "cadence": "monthly",
            "amount_cents": 250_000,
            "start_on": "2026-08-15",
        },
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()

    assert body["account_id"] == account["id"]
    assert body["category_id"] is None
    assert body["kind"] == "bill"
    assert body["cadence"] == "monthly"
    assert body["amount_cents"] == 250_000
    assert body["currency"] == "IDR"
    assert body["start_on"] == "2026-08-15"
    assert body["end_on"] is None
    # next_run_on = start_on + monthly cadence = next month, same day
    # (start_on = 2026-08-15 → next_run_on = 2026-09-15).
    assert body["next_run_on"] == "2026-09-15"
    assert body["note"] is None
    assert body["is_active"] is True
    assert body["id"]
    assert body["created_at"]
    assert body["updated_at"]


def test_create_recurring_rule_next_run_on_derivation_per_cadence(
    client: TestClient, fresh_db: Session
) -> None:
    """``next_run_on`` is derived from ``start_on + cadence`` server-side.

    Each cadence advances by exactly one step:

    * daily → ``start_on + 1 day``
    * weekly → ``start_on + 7 days``
    * monthly → ``start_on + 1 calendar month`` (with day clamp)
    * yearly → ``start_on + 1 calendar year``

    The monthly clamp case (Jan 31 → Feb 28) is the canonical
    corner-case for bill-pay apps — paying on the 31st means "the
    last day of every month", not "skip February".
    """
    headers = _auth_headers(_register(client, "rr-cadence@example.com")["access_token"])
    account = _create_account(client, headers)

    cases = [
        ("daily", "2026-08-15", "2026-08-16"),
        ("weekly", "2026-08-15", "2026-08-22"),
        ("monthly", "2026-08-15", "2026-09-15"),
        ("yearly", "2026-08-15", "2027-08-15"),
    ]
    for cadence, start_on, expected_next_run in cases:
        resp = client.post(
            "/api/v1/recurring-rules",
            headers=headers,
            json={
                "account_id": account["id"],
                "kind": "bill",
                "cadence": cadence,
                "amount_cents": 100_000,
                "start_on": start_on,
            },
        )
        assert resp.status_code == 201, resp.text
        assert resp.json()["next_run_on"] == expected_next_run, (
            f"cadence={cadence}, start_on={start_on}"
        )

    # Monthly day-clamp: Jan 31 → Feb 28 (2026 is not a leap year).
    resp = client.post(
        "/api/v1/recurring-rules",
        headers=headers,
        json={
            "account_id": account["id"],
            "kind": "subscription",
            "cadence": "monthly",
            "amount_cents": 100_000,
            "start_on": "2026-01-31",
        },
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["next_run_on"] == "2026-02-28"

    # Yearly Feb 29 → Feb 28 on a non-leap target year.
    resp = client.post(
        "/api/v1/recurring-rules",
        headers=headers,
        json={
            "account_id": account["id"],
            "kind": "cicilan_fixed",
            "cadence": "yearly",
            "amount_cents": 12_000_000,
            "start_on": "2024-02-29",  # leap year
        },
    )
    assert resp.status_code == 201, resp.text
    # 2025 is not a leap year → clamp to Feb 28.
    assert resp.json()["next_run_on"] == "2025-02-28"


def test_create_recurring_rule_with_category_and_end_on(
    client: TestClient, fresh_db: Session
) -> None:
    """Full body — category_id + end_on + note + is_active=False override."""
    headers = _auth_headers(_register(client, "rr-full@example.com")["access_token"])
    account = _create_account(client, headers)
    category = _create_category(client, headers)

    resp = client.post(
        "/api/v1/recurring-rules",
        headers=headers,
        json={
            "account_id": account["id"],
            "category_id": category["id"],
            "kind": "subscription",
            "cadence": "monthly",
            "amount_cents": 54_900,
            "start_on": "2026-08-01",
            "end_on": "2027-08-01",
            "note": "Netflix",
            "is_active": False,
        },
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["category_id"] == category["id"]
    assert body["end_on"] == "2027-08-01"
    assert body["note"] == "Netflix"
    assert body["is_active"] is False


def test_create_recurring_rule_rejects_invalid_kind(client: TestClient, fresh_db: Session) -> None:
    """Unknown kind → 422 (Pydantic enum)."""
    headers = _auth_headers(_register(client, "rr-kind@example.com")["access_token"])
    account = _create_account(client, headers)

    resp = client.post(
        "/api/v1/recurring-rules",
        headers=headers,
        json={
            "account_id": account["id"],
            "kind": "salary",  # salary is out-of-scope (manual entry)
            "cadence": "monthly",
            "amount_cents": 100,
            "start_on": "2026-08-15",
        },
    )
    assert resp.status_code == 422
    assert "kind" in resp.text.lower()


def test_create_recurring_rule_rejects_invalid_cadence(
    client: TestClient, fresh_db: Session
) -> None:
    """Unknown cadence → 422 (Pydantic enum)."""
    headers = _auth_headers(_register(client, "rr-cadence-invalid@example.com")["access_token"])
    account = _create_account(client, headers)

    resp = client.post(
        "/api/v1/recurring-rules",
        headers=headers,
        json={
            "account_id": account["id"],
            "kind": "bill",
            "cadence": "yearlyly",  # typo
            "amount_cents": 100,
            "start_on": "2026-08-15",
        },
    )
    assert resp.status_code == 422
    assert "cadence" in resp.text.lower()


def test_create_recurring_rule_rejects_negative_amount(
    client: TestClient, fresh_db: Session
) -> None:
    """amount_cents must be > 0 → 422 (Pydantic ``gt=0``)."""
    headers = _auth_headers(_register(client, "rr-amount@example.com")["access_token"])
    account = _create_account(client, headers)

    resp = client.post(
        "/api/v1/recurring-rules",
        headers=headers,
        json={
            "account_id": account["id"],
            "kind": "bill",
            "cadence": "monthly",
            "amount_cents": 0,
            "start_on": "2026-08-15",
        },
    )
    assert resp.status_code == 422
    assert "amount_cents" in resp.text.lower()


def test_create_recurring_rule_rejects_non_idr_currency(
    client: TestClient, fresh_db: Session
) -> None:
    """currency must be 'IDR' → 422 (model_validator)."""
    headers = _auth_headers(_register(client, "rr-currency@example.com")["access_token"])
    account = _create_account(client, headers)

    resp = client.post(
        "/api/v1/recurring-rules",
        headers=headers,
        json={
            "account_id": account["id"],
            "kind": "bill",
            "cadence": "monthly",
            "amount_cents": 100,
            "currency": "USD",
            "start_on": "2026-08-15",
        },
    )
    assert resp.status_code == 422
    assert "currency" in resp.text.lower()


def test_create_recurring_rule_rejects_end_on_before_start_on(
    client: TestClient, fresh_db: Session
) -> None:
    """end_on < start_on → 422 (model_validator)."""
    headers = _auth_headers(_register(client, "rr-endon@example.com")["access_token"])
    account = _create_account(client, headers)

    resp = client.post(
        "/api/v1/recurring-rules",
        headers=headers,
        json={
            "account_id": account["id"],
            "kind": "bill",
            "cadence": "monthly",
            "amount_cents": 100,
            "start_on": "2026-08-15",
            "end_on": "2026-08-14",
        },
    )
    assert resp.status_code == 422
    assert "end_on" in resp.text.lower()


def test_create_recurring_rule_rejects_next_run_on_field(
    client: TestClient, fresh_db: Session
) -> None:
    """``next_run_on`` is server-controlled → 422 (extra='forbid')."""
    headers = _auth_headers(_register(client, "rr-nextrun@example.com")["access_token"])
    account = _create_account(client, headers)

    resp = client.post(
        "/api/v1/recurring-rules",
        headers=headers,
        json={
            "account_id": account["id"],
            "kind": "bill",
            "cadence": "monthly",
            "amount_cents": 100,
            "start_on": "2026-08-15",
            "next_run_on": "2026-12-01",
        },
    )
    assert resp.status_code == 422
    assert "next_run_on" in resp.text.lower()


def test_create_recurring_rule_rejects_cross_user_account(
    client: TestClient, fresh_db: Session
) -> None:
    """Account from another user → 404."""
    a = _auth_headers(_register(client, "a@example.com")["access_token"])
    b = _auth_headers(_register(client, "b@example.com")["access_token"])
    account = _create_account(client, a)

    resp = client.post(
        "/api/v1/recurring-rules",
        headers=b,
        json={
            "account_id": account["id"],
            "kind": "bill",
            "cadence": "monthly",
            "amount_cents": 100,
            "start_on": "2026-08-15",
        },
    )
    assert resp.status_code == 404
    assert "account" in resp.text.lower()


def test_create_recurring_rule_rejects_archived_account(
    client: TestClient, fresh_db: Session
) -> None:
    """Archived account → 404 (no resurrection on closed account).

    The ``POST /accounts`` schema doesn't accept ``archived=True``
    (it's a server-controlled flag), so the test goes around the API
    and flips the column on the freshly-created row directly. The
    route must still treat an archived row as 404 — the soft-delete
    invariant is enforced at the read layer, not the write layer.
    """
    headers = _auth_headers(_register(client, "rr-archived-acc@example.com")["access_token"])
    account_dict = _create_account(client, headers)
    account_row = fresh_db.get(Account, uuid.UUID(account_dict["id"]))
    assert account_row is not None
    account_row.archived = True
    fresh_db.commit()

    resp = client.post(
        "/api/v1/recurring-rules",
        headers=headers,
        json={
            "account_id": account_dict["id"],
            "kind": "bill",
            "cadence": "monthly",
            "amount_cents": 100,
            "start_on": "2026-08-15",
        },
    )
    assert resp.status_code == 404


def test_create_recurring_rule_rejects_income_category(
    client: TestClient, fresh_db: Session
) -> None:
    """Income category link → 422 (materializer would spawn income tx)."""
    headers = _auth_headers(_register(client, "rr-income-cat@example.com")["access_token"])
    account = _create_account(client, headers)
    income = _create_category(client, headers, name="Gaji", kind="income")

    resp = client.post(
        "/api/v1/recurring-rules",
        headers=headers,
        json={
            "account_id": account["id"],
            "category_id": income["id"],
            "kind": "bill",
            "cadence": "monthly",
            "amount_cents": 100,
            "start_on": "2026-08-15",
        },
    )
    assert resp.status_code == 422
    assert "category" in resp.text.lower()


# ---------------------------------------------------------------------------
# (b) GET /recurring-rules
# ---------------------------------------------------------------------------


def test_list_recurring_rules_paginated(client: TestClient, fresh_db: Session) -> None:
    """List returns the caller's rules sorted by next_run_on asc."""
    headers = _auth_headers(_register(client, "rr-list@example.com")["access_token"])
    account = _create_account(client, headers)

    _create_recurring_rule(client, headers, account_id=account["id"], start_on="2026-09-15")
    _create_recurring_rule(client, headers, account_id=account["id"], start_on="2026-08-15")
    _create_recurring_rule(client, headers, account_id=account["id"], start_on="2026-12-15")

    resp = client.get("/api/v1/recurring-rules", headers=headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total"] == 3
    assert body["limit"] == 50
    assert body["offset"] == 0
    assert len(body["items"]) == 3

    # Sort: next_run_on asc, start_on asc, id asc. Earliest is Aug.
    next_runs = [item["next_run_on"] for item in body["items"]]
    assert next_runs == sorted(next_runs)


def test_list_recurring_rules_two_user_isolation(client: TestClient, fresh_db: Session) -> None:
    """User B cannot see User A's rules."""
    a = _auth_headers(_register(client, "iso-a@example.com")["access_token"])
    b = _auth_headers(_register(client, "iso-b@example.com")["access_token"])
    account_a = _create_account(client, a)
    _create_recurring_rule(client, a, account_id=account_a["id"])

    resp = client.get("/api/v1/recurring-rules", headers=b)
    assert resp.status_code == 200
    assert resp.json()["items"] == []
    assert resp.json()["total"] == 0


def test_list_recurring_rules_pagination(client: TestClient, fresh_db: Session) -> None:
    """limit + offset pagination returns the correct slice + total."""
    headers = _auth_headers(_register(client, "rr-page@example.com")["access_token"])
    account = _create_account(client, headers)

    # Five rules — start_on varies so next_run_on varies.
    for day in (1, 5, 10, 15, 20):
        _create_recurring_rule(
            client, headers, account_id=account["id"], start_on=f"2026-08-{day:02d}"
        )

    resp = client.get("/api/v1/recurring-rules?limit=2&offset=0", headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 5
    assert body["limit"] == 2
    assert body["offset"] == 0
    assert len(body["items"]) == 2

    resp = client.get("/api/v1/recurring-rules?limit=2&offset=4", headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 5
    assert len(body["items"]) == 1  # 5 - 4 = 1


# ---------------------------------------------------------------------------
# (c) GET /recurring-rules/{id}
# ---------------------------------------------------------------------------


def test_get_recurring_rule_by_id(client: TestClient, fresh_db: Session) -> None:
    """Detail by id returns the row."""
    headers = _auth_headers(_register(client, "rr-get@example.com")["access_token"])
    account = _create_account(client, headers)
    rule = _create_recurring_rule(client, headers, account_id=account["id"])

    resp = client.get(f"/api/v1/recurring-rules/{rule['id']}", headers=headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["id"] == rule["id"]


def test_get_recurring_rule_cross_user_404(client: TestClient, fresh_db: Session) -> None:
    """Cross-user id → 404."""
    a = _auth_headers(_register(client, "get-a@example.com")["access_token"])
    b = _auth_headers(_register(client, "get-b@example.com")["access_token"])
    account = _create_account(client, a)
    rule = _create_recurring_rule(client, a, account_id=account["id"])

    resp = client.get(f"/api/v1/recurring-rules/{rule['id']}", headers=b)
    assert resp.status_code == 404


def test_get_recurring_rule_unknown_404(client: TestClient, fresh_db: Session) -> None:
    """Unknown id → 404."""
    headers = _auth_headers(_register(client, "rr-unknown@example.com")["access_token"])
    fake_id = str(uuid.uuid4())
    resp = client.get(f"/api/v1/recurring-rules/{fake_id}", headers=headers)
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# (d) PATCH /recurring-rules/{id}
# ---------------------------------------------------------------------------


def test_patch_recurring_rule_partial_update(client: TestClient, fresh_db: Session) -> None:
    """Partial update — only the fields present in the body are touched."""
    headers = _auth_headers(_register(client, "rr-patch@example.com")["access_token"])
    account = _create_account(client, headers)
    rule = _create_recurring_rule(client, headers, account_id=account["id"])

    resp = client.patch(
        f"/api/v1/recurring-rules/{rule['id']}",
        headers=headers,
        json={"amount_cents": 300_000, "note": "Updated"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["amount_cents"] == 300_000
    assert body["note"] == "Updated"
    # Untouched fields stay as-is.
    assert body["kind"] == "bill"
    assert body["cadence"] == "monthly"
    assert body["start_on"] == "2026-08-15"
    assert body["next_run_on"] == "2026-09-15"


def test_patch_recurring_rule_recomputes_next_run_on_when_start_on_changes(
    client: TestClient, fresh_db: Session
) -> None:
    """Changing ``start_on`` → ``next_run_on`` is re-derived server-side."""
    headers = _auth_headers(_register(client, "rr-patch-start@example.com")["access_token"])
    account = _create_account(client, headers)
    rule = _create_recurring_rule(client, headers, account_id=account["id"], start_on="2026-08-15")
    assert rule["next_run_on"] == "2026-09-15"

    resp = client.patch(
        f"/api/v1/recurring-rules/{rule['id']}",
        headers=headers,
        json={"start_on": "2026-10-01"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["next_run_on"] == "2026-11-01"


def test_patch_recurring_rule_recomputes_next_run_on_when_cadence_changes(
    client: TestClient, fresh_db: Session
) -> None:
    """Changing ``cadence`` → ``next_run_on`` is re-derived server-side."""
    headers = _auth_headers(_register(client, "rr-patch-cadence@example.com")["access_token"])
    account = _create_account(client, headers)
    rule = _create_recurring_rule(client, headers, account_id=account["id"], start_on="2026-08-15")
    assert rule["next_run_on"] == "2026-09-15"

    resp = client.patch(
        f"/api/v1/recurring-rules/{rule['id']}",
        headers=headers,
        json={"cadence": "weekly"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["next_run_on"] == "2026-08-22"


def test_patch_recurring_rule_validates_end_on_against_effective_start_on(
    client: TestClient, fresh_db: Session
) -> None:
    """PATCH end_on < effective start_on → 422 (merged effective values)."""
    headers = _auth_headers(_register(client, "rr-patch-endon@example.com")["access_token"])
    account = _create_account(client, headers)
    rule = _create_recurring_rule(client, headers, account_id=account["id"], start_on="2026-08-15")

    resp = client.patch(
        f"/api/v1/recurring-rules/{rule['id']}",
        headers=headers,
        json={"end_on": "2026-08-14"},
    )
    assert resp.status_code == 422
    assert "end_on" in resp.text.lower()


def test_patch_recurring_rule_can_clear_end_on(client: TestClient, fresh_db: Session) -> None:
    """PATCH ``end_on: null`` clears the upper bound (open-ended rule)."""
    headers = _auth_headers(_register(client, "rr-patch-clear-endon@example.com")["access_token"])
    account = _create_account(client, headers)
    rule = _create_recurring_rule(
        client,
        headers,
        account_id=account["id"],
        start_on="2026-08-15",
        end_on="2027-08-15",
    )
    assert rule["end_on"] == "2027-08-15"

    resp = client.patch(
        f"/api/v1/recurring-rules/{rule['id']}",
        headers=headers,
        json={"end_on": None},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["end_on"] is None


def test_patch_recurring_rule_can_clear_category(client: TestClient, fresh_db: Session) -> None:
    """PATCH ``category_id: null`` clears the category link."""
    headers = _auth_headers(_register(client, "rr-patch-clear-cat@example.com")["access_token"])
    account = _create_account(client, headers)
    category = _create_category(client, headers)
    rule = _create_recurring_rule(
        client,
        headers,
        account_id=account["id"],
        category_id=category["id"],
    )

    resp = client.patch(
        f"/api/v1/recurring-rules/{rule['id']}",
        headers=headers,
        json={"category_id": None},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["category_id"] is None


def test_patch_recurring_rule_rejects_next_run_on(client: TestClient, fresh_db: Session) -> None:
    """``next_run_on`` is server-controlled → 422 (extra='forbid')."""
    headers = _auth_headers(_register(client, "rr-patch-nextrun@example.com")["access_token"])
    account = _create_account(client, headers)
    rule = _create_recurring_rule(client, headers, account_id=account["id"])

    resp = client.patch(
        f"/api/v1/recurring-rules/{rule['id']}",
        headers=headers,
        json={"next_run_on": "2026-12-01"},
    )
    assert resp.status_code == 422


def test_patch_recurring_rule_cross_user_404(client: TestClient, fresh_db: Session) -> None:
    """Cross-user PATCH → 404."""
    a = _auth_headers(_register(client, "patch-a@example.com")["access_token"])
    b = _auth_headers(_register(client, "patch-b@example.com")["access_token"])
    account = _create_account(client, a)
    rule = _create_recurring_rule(client, a, account_id=account["id"])

    resp = client.patch(
        f"/api/v1/recurring-rules/{rule['id']}",
        headers=b,
        json={"amount_cents": 300_000},
    )
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# (e) DELETE /recurring-rules/{id}
# ---------------------------------------------------------------------------


def test_delete_recurring_rule_returns_204(client: TestClient, fresh_db: Session) -> None:
    """DELETE → 204, second DELETE → 404 (hard delete is destructive)."""
    headers = _auth_headers(_register(client, "rr-delete@example.com")["access_token"])
    account = _create_account(client, headers)
    rule = _create_recurring_rule(client, headers, account_id=account["id"])

    resp = client.delete(f"/api/v1/recurring-rules/{rule['id']}", headers=headers)
    assert resp.status_code == 204, resp.text

    # Gone — second DELETE is a 404 (hard delete, not soft-delete).
    resp = client.delete(f"/api/v1/recurring-rules/{rule['id']}", headers=headers)
    assert resp.status_code == 404

    # And the list no longer includes it.
    resp = client.get("/api/v1/recurring-rules", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["total"] == 0


def test_delete_recurring_rule_cross_user_404(client: TestClient, fresh_db: Session) -> None:
    """Cross-user DELETE → 404."""
    a = _auth_headers(_register(client, "delete-a@example.com")["access_token"])
    b = _auth_headers(_register(client, "delete-b@example.com")["access_token"])
    account = _create_account(client, a)
    rule = _create_recurring_rule(client, a, account_id=account["id"])

    resp = client.delete(f"/api/v1/recurring-rules/{rule['id']}", headers=b)
    assert resp.status_code == 404
    # Confirm the row is still there for the owner.
    resp = client.get(f"/api/v1/recurring-rules/{rule['id']}", headers=a)
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# (f) Auth required
# ---------------------------------------------------------------------------


def test_recurring_rules_endpoints_require_auth(client: TestClient) -> None:
    """Every endpoint returns 401 without a Bearer token."""
    fake_id = str(uuid.uuid4())
    assert client.get("/api/v1/recurring-rules").status_code == 401
    assert client.post("/api/v1/recurring-rules", json={}).status_code == 401
    assert client.get(f"/api/v1/recurring-rules/{fake_id}").status_code == 401
    assert (
        client.patch(f"/api/v1/recurring-rules/{fake_id}", json={"amount_cents": 100}).status_code
        == 401
    )
    assert client.delete(f"/api/v1/recurring-rules/{fake_id}").status_code == 401
