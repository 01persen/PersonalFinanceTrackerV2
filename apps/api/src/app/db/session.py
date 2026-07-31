"""SQLAlchemy engine + session factory.

The engine is created lazily from ``settings.database_url``. For the Alembic
migration path, we expose ``get_engine()`` so ``alembic/env.py`` can pick it up.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import TYPE_CHECKING

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings

if TYPE_CHECKING:
    from app.db.base import Base

_engine: Engine | None = None
_SessionLocal: sessionmaker[Session] | None = None


def _build_engine(url: str | None = None) -> Engine:
    settings = get_settings()
    target = url or settings.database_url
    connect_args: dict[str, object] = {}
    kwargs: dict[str, object] = {"future": True, "connect_args": connect_args}
    if target.startswith("sqlite"):
        connect_args["check_same_thread"] = False
        # sub-0004-06 defect #3 fix: SQLAlchemy 2.0's
        # ``insertmanyvalues`` path raises
        # ``TypeError: 'NoneType' object is not subscriptable``
        # on SQLite when two threads share the same connection
        # (the test fixture uses ``StaticPool`` so the in-memory
        # DB is shared across the two-thread executor). The
        # failure happens at ``engine/default.py:883`` because
        # ``cursor.description`` is ``None`` on the first commit
        # of a fresh DB when the second thread reuses the same
        # cursor. PostgreSQL is unaffected — its insertmanyvalues
        # path uses server-side ``RETURNING`` and the
        # cursor lifecycle is connection-scoped, not cursor-
        # pooled. Disabling ``use_insertmanyvalues`` falls back
        # to the explicit ``cursor.execute`` path which is
        # thread-safe under SQLite + StaticPool.
        kwargs["use_insertmanyvalues"] = False
    return create_engine(target, **kwargs)


def get_engine(url: str | None = None) -> Engine:
    global _engine
    if _engine is None:
        _engine = _build_engine(url)
    return _engine


def get_sessionmaker(url: str | None = None) -> sessionmaker[Session]:
    global _SessionLocal
    if _SessionLocal is None:
        _SessionLocal = sessionmaker(bind=get_engine(url), expire_on_commit=False, autoflush=False)
    return _SessionLocal


def get_session() -> Iterator[Session]:
    """FastAPI dependency: yields a session and ensures close."""
    session = get_sessionmaker()()
    try:
        yield session
    finally:
        session.close()


def reset_for_tests(base: type[Base] | None = None) -> None:
    """Drop cached engine + sessionmaker (used by tests with a temp URL)."""
    global _engine, _SessionLocal
    if _engine is not None:
        _engine.dispose()
    _engine = None
    _SessionLocal = None
