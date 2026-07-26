"""Categories endpoints — list the authenticated user's categories.

The actual CRUD (POST/PATCH/DELETE) lands in epic-0004. This module ships the
read side + the seed-on-register behaviour from sub-0001-08.
"""

from __future__ import annotations

from collections.abc import Iterator

from fastapi import APIRouter, Depends
from sqlalchemy import case, select
from sqlalchemy.orm import Session

from app.api.schemas import CategoryPublic
from app.api.v1.auth import get_current_user
from app.db.models.category import Category
from app.db.models.enums import CategoryKind
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

    Ordered by kind (**income first, expense second**) using an explicit
    ``CASE`` so the order doesn't depend on the underlying string sort
    (alphabetical would put ``expense`` before ``income`` and break the FE
    layout). Within a kind we sort by ``name``, with parent rows before their
    leaves so the FE can render a parent → children grouping without a second
    pass.

    The wire format stays flat — the FE builds the tree from ``parent_id``.
    """
    kind_rank = case((Category.kind == CategoryKind.INCOME, 0), else_=1)
    is_parent_first = case((Category.parent_id.is_(None), 0), else_=1)

    stmt = (
        select(Category)
        .where(Category.user_id == current_user.id)
        .order_by(kind_rank, is_parent_first, Category.name)
    )
    return list(db.execute(stmt).scalars())
