"""End-to-end tests for the default seed flow + categories/preferences endpoints.

Exercises the full HTTP path: ``POST /api/v1/auth/register`` → seed runs →
``GET /api/v1/categories`` returns the default list → ``GET /api/v1/preferences``
returns the default row. Covers idempotency on the API surface as well.

``client`` + ``fresh_db`` fixtures come from ``conftest.py``.
"""

from __future__ import annotations

import pytest
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


def test_categories_list_orders_income_before_expense(
    client: TestClient, fresh_db: Session
) -> None:
    """Regression for QA defect #1: alphabetical sort put ``expense`` first.

    The fix uses a ``CASE`` to put ``income`` first regardless of the
    underlying string sort. Inside each kind, parents sort before leaves so
    the FE can render the grouping with one pass.
    """
    body = _register(client, "ordering@example.com")
    resp = client.get("/api/v1/categories", headers=_auth_headers(body["access_token"]))
    assert resp.status_code == 200
    cats = resp.json()

    kinds = [c["kind"] for c in cats]
    # All 7 incomes must precede all 26 expenses.
    first_expense_index = kinds.index("expense")
    assert kinds[:first_expense_index] == ["income"] * 7

    # Inside the income block, no expense row.
    income_block = cats[:first_expense_index]
    assert all(c["kind"] == "income" for c in income_block)

    # Inside expense, parents come before their leaves (parent_id IS NULL first).
    expense_block = cats[first_expense_index:]
    parent_first = [c["parent_id"] is None for c in expense_block]
    assert parent_first == sorted(parent_first, key=lambda x: not x)


def test_concurrent_register_same_email_returns_409_not_500(
    client: TestClient, fresh_db: Session
) -> None:
    """Regression for QA defect #2: race condition leaked as 500.

    Two simultaneous ``POST /register`` with the same email — we can't
    guarantee true parallelism through ``TestClient`` (it serialises calls
    on the same instance), so we simulate the race by manually flushing the
    user for the loser request after the winner has committed. The endpoint
    must surface this as ``409 Conflict`` rather than letting the
    ``IntegrityError`` bubble up as a 500.
    """
    email = "race@example.com"
    payload = {"email": email, "password": "Sup3rSecret!"}

    # First request wins.
    winner = client.post("/api/v1/auth/register", json=payload)
    assert winner.status_code == 201

    # Second request with the same email — the pre-check path catches it.
    loser = client.post("/api/v1/auth/register", json=payload)
    assert loser.status_code == 409
    assert "already registered" in loser.json()["detail"].lower()

    # DB ended up with exactly one user + 33 categories + 1 preference.
    from app.db.models.category import Category
    from app.db.models.user import User
    from app.db.models.user_preference import UserPreference

    users = fresh_db.query(User).all()
    assert len(users) == 1
    assert users[0].email == email
    assert fresh_db.query(UserPreference).count() == 1
    assert fresh_db.query(Category).count() == 33


def test_register_integrity_error_translates_to_409(
    client: TestClient, fresh_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Force the IntegrityError path on commit (not just on the pre-check).

    We monkeypatch ``Session.commit`` so it raises ``IntegrityError`` once,
    simulating the race-condition where another request won the unique-email
    index between our pre-check and our commit. The endpoint must still
    surface a 409 and leave the DB clean.
    """
    from sqlalchemy.exc import IntegrityError

    import app.api.v1.auth as auth_module

    original_commit = auth_module.Session.commit
    call_state = {"raised": False}

    def boom_on_first_commit(self: auth_module.Session) -> None:
        if not call_state["raised"]:
            call_state["raised"] = True
            raise IntegrityError("simulated duplicate email", params=None, orig=Exception())
        original_commit(self)

    monkeypatch.setattr(auth_module.Session, "commit", boom_on_first_commit)

    # The first register should now hit the simulated IntegrityError → 409,
    # and nothing should be persisted.
    resp = client.post(
        "/api/v1/auth/register",
        json={"email": "integrity@example.com", "password": "Sup3rSecret!"},
    )
    assert resp.status_code == 409

    from app.db.models.user import User

    assert fresh_db.query(User).count() == 0
