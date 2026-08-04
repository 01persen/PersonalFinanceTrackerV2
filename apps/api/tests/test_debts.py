from __future__ import annotations

import uuid
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.db.models.debt import Debt


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
    payload: dict[str, object] = {
        "name": "Kredit Rumah",
        "kind": "KPR",
        "principal_cents": 12_000_000,
        "bunga_pct": 10,
        "tenor_months": 12,
        "start_date": "2026-08-01",
    }
    payload.update(overrides)
    return payload


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


@pytest.mark.parametrize(
    "kind",
    ["loan", "credit_card", "paylater", "KTA", "KKB", "KPR", "other"],
)
def test_create_supports_every_debt_kind(
    client: TestClient,
    fresh_db: Session,
    kind: str,
) -> None:
    email_kind = kind.lower().replace("_", "-")
    auth = _register(client, f"debt-kind-{email_kind}@example.com")
    response = client.post(
        "/api/v1/debts",
        headers=_headers(auth["access_token"]),
        json=_payload(kind=kind, note="Kontrak tetap"),
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert set(body) == {
        "id",
        "user_id",
        "name",
        "kind",
        "principal_cents",
        "bunga_pct",
        "tenor_months",
        "start_date",
        "monthly_payment_cents",
        "note",
        "status",
        "created_at",
        "updated_at",
    }
    assert body["kind"] == kind
    assert body["principal_cents"] == 12_000_000
    assert body["bunga_pct"] == 10.0
    assert body["tenor_months"] == 12
    assert body["start_date"] == "2026-08-01"
    assert body["monthly_payment_cents"] == 1_100_000
    assert body["note"] == "Kontrak tetap"
    assert body["status"] == "active"
    assert uuid.UUID(body["id"])
    assert uuid.UUID(body["user_id"])


def test_create_with_null_tenor_returns_null_monthly_payment(
    client: TestClient,
    fresh_db: Session,
) -> None:
    auth = _register(client, "debt-null-tenor@example.com")
    body = _create(
        client,
        _headers(auth["access_token"]),
        tenor_months=None,
        bunga_pct=7.5,
    )

    assert body["tenor_months"] is None
    assert body["monthly_payment_cents"] is None
    stored = fresh_db.get(Debt, uuid.UUID(str(body["id"])))
    assert stored is not None
    assert stored.bunga_pct == Decimal("7.5000")
    assert stored.monthly_payment_cents is None


@pytest.mark.parametrize(
    ("overrides", "field"),
    [
        ({"kind": "mortgage"}, "kind"),
        ({"principal_cents": 0}, "principal_cents"),
        ({"principal_cents": -1}, "principal_cents"),
        ({"bunga_pct": -0.0001}, "bunga_pct"),
        ({"tenor_months": 0}, "tenor_months"),
        ({"tenor_months": -1}, "tenor_months"),
        ({"start_date": "not-a-date"}, "start_date"),
        ({"status": "closed"}, "status"),
    ],
)
def test_create_rejects_invalid_fields(
    client: TestClient,
    fresh_db: Session,
    overrides: dict[str, object],
    field: str,
) -> None:
    auth = _register(client, "debt-invalid@example.com")
    response = client.post(
        "/api/v1/debts",
        headers=_headers(auth["access_token"]),
        json=_payload(**overrides),
    )

    assert response.status_code == 422, response.text
    assert field in response.text
    assert fresh_db.query(Debt).count() == 0


def test_create_rejects_server_owned_monthly_payment(
    client: TestClient,
    fresh_db: Session,
) -> None:
    auth = _register(client, "debt-owned-monthly@example.com")
    response = client.post(
        "/api/v1/debts",
        headers=_headers(auth["access_token"]),
        json=_payload(monthly_payment_cents=1),
    )

    assert response.status_code == 422, response.text
    assert "monthly_payment_cents" in response.text


def test_list_and_get_are_scoped_to_owner_and_deterministic(
    client: TestClient,
    fresh_db: Session,
) -> None:
    alice = _register(client, "debt-alice@example.com")
    bob = _register(client, "debt-bob@example.com")
    alice_headers = _headers(alice["access_token"])
    bob_headers = _headers(bob["access_token"])

    older = _create(
        client,
        alice_headers,
        name="Older",
        start_date="2026-01-01",
    )
    newer = _create(
        client,
        alice_headers,
        name="Newer",
        start_date="2026-08-01",
    )
    _create(client, bob_headers, name="Bob only")

    alice_list = client.get("/api/v1/debts", headers=alice_headers)
    bob_list = client.get("/api/v1/debts", headers=bob_headers)
    assert alice_list.status_code == 200, alice_list.text
    assert [row["id"] for row in alice_list.json()] == [newer["id"], older["id"]]
    assert [row["name"] for row in bob_list.json()] == ["Bob only"]

    owned = client.get(f"/api/v1/debts/{older['id']}", headers=alice_headers)
    foreign = client.get(f"/api/v1/debts/{older['id']}", headers=bob_headers)
    assert owned.status_code == 200, owned.text
    assert owned.json()["id"] == older["id"]
    assert foreign.status_code == 404, foreign.text
    assert foreign.json()["detail"] == "debt not found"


def test_patch_updates_fields_and_recalculates_monthly_payment(
    client: TestClient,
    fresh_db: Session,
) -> None:
    auth = _register(client, "debt-patch@example.com")
    headers = _headers(auth["access_token"])
    debt = _create(client, headers)

    response = client.patch(
        f"/api/v1/debts/{debt['id']}",
        headers=headers,
        json={
            "name": "Kredit Kendaraan",
            "kind": "KKB",
            "principal_cents": 24_000_000,
            "bunga_pct": 12,
            "tenor_months": 24,
            "start_date": "2026-09-01",
            "note": "Diperbarui",
            "status": "paid_off",
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"] == "Kredit Kendaraan"
    assert body["kind"] == "KKB"
    assert body["principal_cents"] == 24_000_000
    assert body["bunga_pct"] == 12.0
    assert body["tenor_months"] == 24
    assert body["start_date"] == "2026-09-01"
    assert body["monthly_payment_cents"] == 1_240_000
    assert body["note"] == "Diperbarui"
    assert body["status"] == "paid_off"


def test_patch_can_clear_and_restore_nullable_tenor(
    client: TestClient,
    fresh_db: Session,
) -> None:
    auth = _register(client, "debt-patch-null@example.com")
    headers = _headers(auth["access_token"])
    debt = _create(client, headers, note="Optional")

    cleared = client.patch(
        f"/api/v1/debts/{debt['id']}",
        headers=headers,
        json={"tenor_months": None, "note": None},
    )
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["tenor_months"] is None
    assert cleared.json()["monthly_payment_cents"] is None
    assert cleared.json()["note"] is None

    restored = client.patch(
        f"/api/v1/debts/{debt['id']}",
        headers=headers,
        json={"tenor_months": 6},
    )
    assert restored.status_code == 200, restored.text
    assert restored.json()["monthly_payment_cents"] == 2_100_000


@pytest.mark.parametrize(
    "field",
    ["name", "kind", "principal_cents", "bunga_pct", "start_date", "status"],
)
def test_patch_rejects_null_for_required_fields(
    client: TestClient,
    fresh_db: Session,
    field: str,
) -> None:
    auth = _register(client, "debt-patch-null-required@example.com")
    headers = _headers(auth["access_token"])
    debt = _create(client, headers)

    response = client.patch(
        f"/api/v1/debts/{debt['id']}",
        headers=headers,
        json={field: None},
    )

    assert response.status_code == 422, response.text
    assert field in response.text


@pytest.mark.parametrize(
    "payload",
    [
        {"principal_cents": 0},
        {"bunga_pct": -1},
        {"tenor_months": 0},
        {"kind": "mortgage"},
        {"start_date": "2026-02-31"},
        {"monthly_payment_cents": 1},
        {"user_id": "11111111-1111-1111-1111-111111111111"},
    ],
)
def test_patch_rejects_invalid_or_server_owned_fields(
    client: TestClient,
    fresh_db: Session,
    payload: dict[str, object],
) -> None:
    auth = _register(client, "debt-patch-invalid@example.com")
    headers = _headers(auth["access_token"])
    debt = _create(client, headers)

    response = client.patch(
        f"/api/v1/debts/{debt['id']}",
        headers=headers,
        json=payload,
    )

    assert response.status_code == 422, response.text


def test_patch_and_delete_return_404_for_foreign_debt(
    client: TestClient,
    fresh_db: Session,
) -> None:
    alice = _register(client, "debt-write-alice@example.com")
    bob = _register(client, "debt-write-bob@example.com")
    alice_headers = _headers(alice["access_token"])
    bob_headers = _headers(bob["access_token"])
    debt = _create(client, alice_headers)

    patch = client.patch(
        f"/api/v1/debts/{debt['id']}",
        headers=bob_headers,
        json={"name": "Forbidden"},
    )
    delete = client.delete(f"/api/v1/debts/{debt['id']}", headers=bob_headers)

    assert patch.status_code == 404, patch.text
    assert delete.status_code == 404, delete.text
    unchanged = client.get(f"/api/v1/debts/{debt['id']}", headers=alice_headers)
    assert unchanged.status_code == 200, unchanged.text
    assert unchanged.json()["name"] == "Kredit Rumah"


def test_delete_removes_owned_debt(
    client: TestClient,
    fresh_db: Session,
) -> None:
    auth = _register(client, "debt-delete@example.com")
    headers = _headers(auth["access_token"])
    debt = _create(client, headers)

    response = client.delete(f"/api/v1/debts/{debt['id']}", headers=headers)

    assert response.status_code == 204, response.text
    assert response.content == b""
    assert fresh_db.get(Debt, uuid.UUID(str(debt["id"]))) is None
    assert client.get(f"/api/v1/debts/{debt['id']}", headers=headers).status_code == 404


def test_unknown_debt_returns_404_for_all_item_operations(
    client: TestClient,
    fresh_db: Session,
) -> None:
    auth = _register(client, "debt-unknown@example.com")
    headers = _headers(auth["access_token"])
    debt_id = uuid.uuid4()

    assert client.get(f"/api/v1/debts/{debt_id}", headers=headers).status_code == 404
    assert (
        client.patch(
            f"/api/v1/debts/{debt_id}",
            headers=headers,
            json={"name": "Missing"},
        ).status_code
        == 404
    )
    assert client.delete(f"/api/v1/debts/{debt_id}", headers=headers).status_code == 404


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("post", "/api/v1/debts", _payload()),
        ("get", "/api/v1/debts", None),
        ("get", f"/api/v1/debts/{uuid.uuid4()}", None),
        ("patch", f"/api/v1/debts/{uuid.uuid4()}", {"name": "No auth"}),
        ("delete", f"/api/v1/debts/{uuid.uuid4()}", None),
    ],
)
def test_every_endpoint_requires_auth(
    client: TestClient,
    fresh_db: Session,
    method: str,
    path: str,
    body: dict[str, object] | None,
) -> None:
    response = client.request(method, path, json=body)
    assert response.status_code == 401, response.text
