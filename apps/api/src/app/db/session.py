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
    if target.startswith("sqlite"):
        connect_args["check_same_thread"] = False
    return create_engine(target, future=True, connect_args=connect_args)


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
