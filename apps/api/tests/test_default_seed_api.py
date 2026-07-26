"""End-to-end tests for the default seed flow + categories/preferences endpoints.

Exercises the full HTTP path: ``POST /api/v1/auth/register`` → seed runs →
``GET /api/v1/categories`` returns the default list → ``GET /api/v1/preferences``
returns the default row. Covers idempotency on the API surface as well.

``client`` + ``fresh_db`` fixtures come from ``conftest.py``.
"""

from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session


def _register(client: TestClient, email: str = "seed-flow@example.com") -> dict:
    resp = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "Sup3rSecret!"},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_register_seeds_default_categories_via_api(client: TestClient, fresh_db: Session) -> None:
    body = _register(client)
    headers = _auth_headers(body["access_token"])

    resp = client.get("/api/v1/categories", headers=headers)
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    names = {c["name"] for c in payload}

    # Spot-check a few from each group rather than re-listing the whole tree.
    expected = {
        "Gaji",
        "Gaji Pasangan",
        "Bonus",
        "Hadiah",
        "Pendapatan Lain",
        "Hutang Diterima",
        "Piutang Diterima",
        "Cicilan",
        "Rutinitas",
        "Tabungan & Investasi",
        "Belanja",
        "Sewa/KPR",
        "Listrik",
        "Saham",
        "ReksaDana",
        "Makan",
        "Kebutuhan Anak",
    }
    missing = expected - names
    assert not missing, f"missing default categories after register: {missing}"


def test_register_seeds_default_preferences_via_api(client: TestClient, fresh_db: Session) -> None:
    body = _register(client)
    headers = _auth_headers(body["access_token"])

    resp = client.get("/api/v1/preferences", headers=headers)
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload["locale"] == "id-ID"
    assert payload["currency"] == "IDR"
    assert payload["emergency_fund_multiplier"] == 3
    assert payload["dependents_count"] == 1
    assert payload["theme"] == "system"


def test_categories_are_scoped_to_the_authenticated_user(
    client: TestClient, fresh_db: Session
) -> None:
    alice_body = _register(client, "alice-scope@example.com")
    bob_body = _register(client, "bob-scope@example.com")

    alice_resp = client.get("/api/v1/categories", headers=_auth_headers(alice_body["access_token"]))
    bob_resp = client.get("/api/v1/categories", headers=_auth_headers(bob_body["access_token"]))
    assert alice_resp.status_code == 200
    assert bob_resp.status_code == 200

    # Each user has the same defaults — that is fine — but the rows themselves
    # are different physical rows (different user_id). The endpoint must not
    # leak rows across users.
    alice_cats = alice_resp.json()
    bob_cats = bob_resp.json()
    assert len(alice_cats) == len(bob_cats) > 0
    assert {c["id"] for c in alice_cats}.isdisjoint({c["id"] for c in bob_cats})


def test_categories_hierarchy_has_parent_links(client: TestClient, fresh_db: Session) -> None:
    body = _register(client, "hierarchy@example.com")
    resp = client.get("/api/v1/categories", headers=_auth_headers(body["access_token"]))
    assert resp.status_code == 200

    cats = resp.json()
    cicilan = next(c for c in cats if c["name"] == "Cicilan" and c["parent_id"] is None)
    cicilan_mobil = next(c for c in cats if c["name"] == "Cicilan Mobil")
    assert cicilan_mobil["parent_id"] == cicilan["id"]
    assert cicilan_mobil["kind"] == "expense"


def test_categories_requires_auth(client: TestClient, fresh_db: Session) -> None:
    resp = client.get("/api/v1/categories")
    assert resp.status_code == 401


def test_preferences_requires_auth(client: TestClient, fresh_db: Session) -> None:
    resp = client.get("/api/v1/preferences")
    assert resp.status_code == 401


def test_seed_runs_on_every_register_not_double_seeding(
    client: TestClient, fresh_db: Session
) -> None:
    """Registering twice with different emails must seed two independent sets.

    Same user (email) twice is the 409 path — covered by the auth tests. This
    test instead verifies that two different users each get their own fresh
    default tree (proves the seed scopes per-user, not globally).
    """
    a = _register(client, "first@example.com")
    b = _register(client, "second@example.com")

    a_cats = client.get("/api/v1/categories", headers=_auth_headers(a["access_token"])).json()
    b_cats = client.get("/api/v1/categories", headers=_auth_headers(b["access_token"])).json()

    a_ids = {c["id"] for c in a_cats}
    b_ids = {c["id"] for c in b_cats}

    assert len(a_ids) == 33
    assert len(b_ids) == 33
    assert a_ids.isdisjoint(b_ids)  # no shared rows between users


def test_openapi_documents_new_endpoints(client: TestClient, fresh_db: Session) -> None:
    spec = client.get("/openapi.json").json()
    paths = spec["paths"]
    assert "/api/v1/categories" in paths
    assert "/api/v1/preferences" in paths
    assert "get" in paths["/api/v1/categories"]
    assert "get" in paths["/api/v1/preferences"]
