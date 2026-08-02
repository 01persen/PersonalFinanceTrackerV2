"""User settings endpoints -- ``GET /users/me/settings`` + ``PATCH /users/me/settings``.

Scope: epic-0005, sub-0005-02. New ``/users/me/settings`` path that
aliases the single-row-per-user ``user_preferences`` table created by
epic-0001. The settings row drives the EF goal-engine's
``emergency_fund_multiplier`` fallback (PRD §14, default 3) and lives
under a per-user namespace so each caller can tune it independently.

The existing ``GET /preferences`` endpoint is left untouched; the new
path uses a different field name on the wire (``ef_multiplier`` vs
``emergency_fund_multiplier``) so the FE can wire the new endpoint
without forcing a coordinated cut-over.

Validation:

* ``ef_multiplier`` must be ``>= 1``. The schema enforces this in
  Pydantic (``Field(ge=1)`` -> 422) before the route runs.
* ``locale`` / ``currency`` / ``theme`` are short strings; lengths
  are bounded by the schema. ``currency`` is *not* locked to
  ``"IDR"`` here -- the preferences row is meant to be the
  single-currency hint for future multi-currency expansion, so
  accepting any 3-char code makes the PATCH forward-compatible
  without making MVP tests stricter.
"""

from __future__ import annotations

from collections.abc import Iterator

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.schemas import UserSettingsPublic, UserSettingsUpdate
from app.api.v1.auth import get_current_user
from app.db.models.user import User
from app.db.models.user_preference import UserPreference
from app.db.session import get_session

router = APIRouter(prefix="/users/me", tags=["users"])


def get_db() -> Iterator[Session]:
    """Per-router session dependency (mirrors preferences.py)."""
    yield from get_session()


def _load_my_settings(db: Session, *, current_user: User) -> UserPreference:
    """Load the caller's preferences row or raise 404.

    Mirror of :func:`app.api.v1.preferences.get_my_preferences` -- the
    settings row is created at registration by the seed module, so a
    404 here is a defect signal (legacy user without a seed pass)
    rather than a normal flow.
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


@router.get("/settings", response_model=UserSettingsPublic)
def get_my_settings(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UserSettingsPublic:
    """Return the caller's settings row.

    See :class:`app.api.schemas.UserSettingsPublic` for the wire shape
    (it renames ``emergency_fund_multiplier`` -> ``ef_multiplier`` to
    keep the FE-facing name pinned at the request side too).
    """
    pref = _load_my_settings(db, current_user=current_user)
    return UserSettingsPublic.from_preference(pref)


@router.patch("/settings", response_model=UserSettingsPublic)
def update_my_settings(
    payload: UserSettingsUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UserSettingsPublic:
    """Partial update of the caller's settings row.

    Only the fields present in the request body are touched; the
    server-controlled fields (``id``, ``user_id``, ``created_at``)
    are never editable through this endpoint. ``extra="forbid"``
    rejects unknown fields with 422 before the route runs.

    The wire name ``ef_multiplier`` is translated to the underlying
    column name ``emergency_fund_multiplier`` so the request schema
    stays decoupled from the storage layer.
    """
    pref = _load_my_settings(db, current_user=current_user)

    data = payload.model_dump(exclude_unset=True)
    if "ef_multiplier" in data:
        pref.emergency_fund_multiplier = int(data["ef_multiplier"])
    for field, value in data.items():
        if field == "ef_multiplier":
            continue  # already handled above
        setattr(pref, field, value)

    db.commit()
    db.refresh(pref)
    return UserSettingsPublic.from_preference(pref)
