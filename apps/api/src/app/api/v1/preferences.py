"""User preferences endpoints — read the current user's preferences row.

The single-row-per-user preferences table is created at registration by the
seed module and exposed here for the FE. Write endpoints land in epic-0008
(Export, Backup & Settings) — for sub-0001-08 we only ship the GET.
"""

from __future__ import annotations

from collections.abc import Iterator

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.schemas import UserPreferencePublic
from app.api.v1.auth import get_current_user
from app.db.models.user import User
from app.db.models.user_preference import UserPreference
from app.db.session import get_session

router = APIRouter(prefix="/preferences", tags=["preferences"])


def get_db() -> Iterator[Session]:
    """Per-router session dependency (mirrors auth.py's pattern)."""
    yield from get_session()


@router.get("", response_model=UserPreferencePublic)
def get_my_preferences(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UserPreference:
    """Return the current user's preferences row.

    Looked up by ``user_id`` (the table has both an ``id`` PK and a unique
    ``user_id``). The 404 path is the safety net for users who registered
    before the seed ran (e.g. legacy rows from a sub-0001-02 dry-run DB).
    """
    pref = db.execute(
        select(UserPreference).where(UserPreference.user_id == current_user.id)
    ).scalar_one_or_none()
    if pref is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="preferences not initialised for this user",
        )
    return pref
