"""Authenticated JSON snapshot and ZIP backup endpoints."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.orm import Session

from app.api.v1.auth import get_current_user
from app.core.config import get_settings
from app.db.models.user import User
from app.db.session import get_session
from app.services.export_snapshot import (
    build_backup_archive,
    build_snapshot,
    canonical_json_bytes,
)

router = APIRouter(prefix="/export", tags=["export"])


def get_db() -> Iterator[Session]:
    yield from get_session()


def _attachment_headers(filename: str) -> dict[str, str]:
    return {"Content-Disposition": f'attachment; filename="{filename}"'}


@router.get(
    "/transactions.json",
    response_class=Response,
    status_code=status.HTTP_200_OK,
    responses={status.HTTP_200_OK: {"content": {"application/json": {}}}},
)
def export_transactions_json(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    exported_at = datetime.now(UTC)
    snapshot = build_snapshot(db=db, user=current_user, exported_at=exported_at)
    filename = f"transactions-{exported_at.date().isoformat()}.json"
    return Response(
        content=canonical_json_bytes(snapshot),
        media_type="application/json",
        headers=_attachment_headers(filename),
    )


@router.get(
    "/backup.zip",
    response_class=Response,
    status_code=status.HTTP_200_OK,
    responses={status.HTTP_200_OK: {"content": {"application/zip": {}}}},
)
def export_backup_zip(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    exported_at = datetime.now(UTC)
    snapshot = build_snapshot(db=db, user=current_user, exported_at=exported_at)
    settings = get_settings()
    archive = build_backup_archive(
        snapshot=snapshot,
        user_id=current_user.id,
        hash_salt=settings.export_hash_salt or settings.jwt_secret,
    )
    filename = f"backup-{exported_at.date().isoformat()}.zip"
    return Response(
        content=archive,
        media_type="application/zip",
        headers=_attachment_headers(filename),
    )
