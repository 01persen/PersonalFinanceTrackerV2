"""Categories endpoints — list the authenticated user's categories.

The actual CRUD (POST/PATCH/DELETE) lands in epic-0004. This module ships the
read side + the seed-on-register behaviour from sub-0001-08.
"""

from __future__ import annotations

from collections.abc import Iterator

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.schemas import CategoryPublic
from app.api.v1.auth import get_current_user
from app.db.models.category import Category
from app.db.models.user import User
from app.db.session import get_session

router = APIRouter(prefix="/categories", tags=["categories"])


def get_db() -> Iterator[Session]:
    """Per-router session dependency (mirrors auth.py's pattern)."""
    yield from get_session()


@router.get("", response_model=list[CategoryPublic])
def list_categories(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[Category]:
    """Return all of the current user's categories (root + leaves).

    Ordered by kind (income first, expense second), then by name. The FE can
    build the parent/child tree itself from the ``parent_id`` field — we keep
    the wire format flat for now and revisit if it becomes a hot path.
    """
    stmt = (
        select(Category)
        .where(Category.user_id == current_user.id)
        .order_by(Category.kind, Category.name)
    )
    return list(db.execute(stmt).scalars())
