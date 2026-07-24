"""Auth endpoint tests — happy path + invalid credentials + token validation.

The ``client`` fixture is provided by ``conftest.py`` and uses FastAPI's
``TestClient``. These tests are fully self-contained — no external Supabase
call, no Postgres connection. The DB session used by the app falls back to the
default SQLite path because the test env doesn't override ``DATABASE_URL``.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.models import User


@pytest.fixture()
def fresh_db(monkeypatch: pytest.MonkeyPatch) -> Iterator[Session]:
    """Fresh in-memory SQLite with the schema created and the app pointed at it.

    ``StaticPool`` keeps a single shared connection open so every session the
    app opens against this engine sees the same in-memory DB (otherwise each
    new connection would create its own private DB and the schema we'd just
    written would vanish).

    We then swap the module-level ``_engine`` and ``_SessionLocal`` in
    ``app.db.session`` so requests open sessions against our throwaway DB
    instead of whatever ``DATABASE_URL`` points at in the environment.
    """
    engine = create_engine(
        "sqlite://",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )

    @event.listens_for(engine, "connect")
    def _fk_on(dbapi_conn, _):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, expire_on_commit=False)

    from app.db import session as session_module

    monkeypatch.setattr(session_module, "_engine", engine)
    monkeypatch.setattr(session_module, "_SessionLocal", session_factory)

    with session_factory() as session:
        yield session

    Base.metadata.drop_all(engine)
    engine.dispose()


def _register(client: TestClient, email: str, password: str = "Sup3rSecret!") -> dict:
    resp = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": password},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _login(client: TestClient, email: str, password: str = "Sup3rSecret!") -> dict:
    resp = client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": password},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_register_creates_user_and_returns_tokens(client: TestClient, fresh_db: Session) -> None:
    body = _register(client, "alice@example.com")

    assert body["token_type"] == "bearer"
    assert body["access_token"]
    assert body["refresh_token"]
    assert body["expires_in"] > 0

    user = fresh_db.query(User).one()
    assert user.email == "alice@example.com"
    assert user.password_hash and user.password_hash != "Sup3rSecret!"


def test_register_rejects_duplicate_email(client: TestClient, fresh_db: Session) -> None:
    _register(client, "dup@example.com")
    resp = client.post(
        "/api/v1/auth/register",
        json={"email": "dup@example.com", "password": "Sup3rSecret!"},
    )
    assert resp.status_code == 409
    assert "already registered" in resp.json()["detail"].lower()
    assert fresh_db.query(User).count() == 1


def test_register_rejects_short_password(client: TestClient) -> None:
    resp = client.post(
        "/api/v1/auth/register",
        json={"email": "weak@example.com", "password": "short"},
    )
    assert resp.status_code == 422


def test_register_rejects_invalid_email(client: TestClient) -> None:
    resp = client.post(
        "/api/v1/auth/register",
        json={"email": "not-an-email", "password": "Sup3rSecret!"},
    )
    assert resp.status_code == 422


def test_register_normalises_email_case(client: TestClient, fresh_db: Session) -> None:
    _register(client, "MixedCase@Example.COM")
    user = fresh_db.query(User).one()
    assert user.email == "mixedcase@example.com"


def test_login_returns_tokens_and_accepts_them(client: TestClient, fresh_db: Session) -> None:
    _register(client, "bob@example.com", password="Sup3rSecret!")
    body = _login(client, "bob@example.com", password="Sup3rSecret!")

    assert body["token_type"] == "bearer"
    assert body["access_token"]
    assert body["refresh_token"]

    me = client.get(
        "/api/v1/auth/me",
        headers={"Authorization": f"Bearer {body['access_token']}"},
    )
    assert me.status_code == 200, me.text
    payload = me.json()
    assert payload["email"] == "bob@example.com"
    uuid.UUID(payload["id"])  # valid uuid


def test_login_rejects_wrong_password(client: TestClient, fresh_db: Session) -> None:
    _register(client, "carol@example.com", password="Sup3rSecret!")
    resp = client.post(
        "/api/v1/auth/login",
        json={"email": "carol@example.com", "password": "WrongPassword!"},
    )
    assert resp.status_code == 401
    assert "invalid" in resp.json()["detail"].lower()


def test_login_rejects_unknown_email(client: TestClient, fresh_db: Session) -> None:
    resp = client.post(
        "/api/v1/auth/login",
        json={"email": "ghost@example.com", "password": "Sup3rSecret!"},
    )
    assert resp.status_code == 401


def test_me_requires_bearer_token(client: TestClient) -> None:
    resp = client.get("/api/v1/auth/me")
    assert resp.status_code == 403  # HTTPBearer auto_error returns 403 on missing


def test_me_rejects_garbage_token(client: TestClient) -> None:
    resp = client.get(
        "/api/v1/auth/me",
        headers={"Authorization": "Bearer not-a-real-token"},
    )
    assert resp.status_code == 401


def test_me_rejects_refresh_token_used_as_access(client: TestClient, fresh_db: Session) -> None:
    body = _register(client, "dave@example.com")
    resp = client.get(
        "/api/v1/auth/me",
        headers={"Authorization": f"Bearer {body['refresh_token']}"},
    )
    assert resp.status_code == 401


def test_logout_returns_204_and_keeps_endpoint_protected(
    client: TestClient, fresh_db: Session
) -> None:
    body = _register(client, "eve@example.com")
    resp = client.post(
        "/api/v1/auth/logout",
        headers={"Authorization": f"Bearer {body['access_token']}"},
    )
    assert resp.status_code == 204
    assert resp.content == b""


def test_logout_requires_auth(client: TestClient) -> None:
    resp = client.post("/api/v1/auth/logout")
    assert resp.status_code == 403


def test_refresh_returns_new_access_token(client: TestClient, fresh_db: Session) -> None:
    body = _register(client, "frank@example.com")
    resp = client.post(
        "/api/v1/auth/refresh",
        json={"refresh_token": body["refresh_token"]},
    )
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload["access_token"]

    # Use the new access token to hit /me — proves the refresh produced a
    # working credential for the same user.
    me = client.get(
        "/api/v1/auth/me",
        headers={"Authorization": f"Bearer {payload['access_token']}"},
    )
    assert me.status_code == 200
    assert me.json()["email"] == "frank@example.com"


def test_refresh_rejects_access_token(client: TestClient, fresh_db: Session) -> None:
    body = _register(client, "grace@example.com")
    resp = client.post(
        "/api/v1/auth/refresh",
        json={"refresh_token": body["access_token"]},
    )
    assert resp.status_code == 401


def test_refresh_rejects_garbage(client: TestClient) -> None:
    resp = client.post(
        "/api/v1/auth/refresh",
        json={"refresh_token": "garbage"},
    )
    assert resp.status_code == 401


def test_openapi_documents_auth_endpoints(client: TestClient) -> None:
    resp = client.get("/openapi.json")
    assert resp.status_code == 200
    spec = resp.json()
    paths = spec["paths"]
    assert "/api/v1/auth/register" in paths
    assert "/api/v1/auth/login" in paths
    assert "/api/v1/auth/logout" in paths
    assert "/api/v1/auth/refresh" in paths
    assert "/api/v1/auth/me" in paths
