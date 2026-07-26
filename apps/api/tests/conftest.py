"""Shared pytest fixtures.

The ``fresh_db`` fixture points the app at a fresh in-memory SQLite DB per test.
We swap the module-level ``_engine`` and ``_SessionLocal`` in ``app.db.session``
so requests open sessions against our throwaway DB instead of whatever
``DATABASE_URL`` points at in the environment (which is Postgres in dev/CI and
would explode when there's no server reachable).

The original test_auth.py had this fixture inline — centralising it here means
any test that touches the DB can opt in without copy-pasting the boilerplate.
"""

from __future__ import annotations

import os
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

os.environ.setdefault("APP_ENV", "test")
# 32+ bytes so pyjwt doesn't complain the HMAC key is too short for SHA256.
os.environ.setdefault("JWT_SECRET", "test-secret-not-for-production-32b-min")

from app.db.base import Base
from app.main import create_app


@pytest.fixture
def client() -> Iterator[TestClient]:
    app = create_app()
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def fresh_db(monkeypatch: pytest.MonkeyPatch) -> Iterator[Session]:
    """Fresh in-memory SQLite with the schema created and the app pointed at it.

    ``StaticPool`` keeps a single shared connection open so every session the
    app opens against this engine sees the same in-memory DB (otherwise each
    new connection would create its own private DB and the schema we'd just
    written would vanish).
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
