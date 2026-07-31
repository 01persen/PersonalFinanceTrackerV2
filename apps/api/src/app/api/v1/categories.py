"""Categories endpoints — full CRUD for the authenticated user's categories.

Scope: sub-0004-01. This module ships:

* ``GET /categories`` — paginated list (default page_size 100), sorted
  deterministically by ``kind asc, parent_id asc, name asc``. Archived
  rows (``archived_at IS NOT NULL``) are excluded.
* ``POST /categories`` — create with name, kind, optional parent_id.
  Validates parent ownership (404) and prevents cycles (400).
* ``PATCH /categories/{id}`` — partial update. ``extra="forbid"`` keeps
  server-controlled fields server-controlled.
* ``DELETE /categories/{id}`` — soft delete. Idempotent 204. Sets
  ``archived_at`` server-side so the row stops surfacing in the list.
* ``POST /categories/{id}/archive`` — explicit archive with optional
  reason. Same idempotency contract as DELETE.

Cross-cutting TL decisions:

* B — ownership checks surface 404 (not 403) so the endpoint doesn't
  leak the existence of another user's category IDs (same pattern as
  accounts / transactions).
* Soft-delete exclusion mirrors sub-0003-02's ``deleted_at IS NULL``
  pattern on transactions: archived rows are filtered at the list layer
  *and* at every ownership check inside the write endpoints, so a stale
  id from the client can never resurrect a tombstoned row.
* Cycle prevention walks the parent chain on the new parent and rejects
  if the target row (or any of its ancestors) equals the row being
  updated. Bounded by the depth of the caller's tree (in practice
  shallow — PRD §14 ships a 2-level tree at most).
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.api.schemas import (
    CategoryArchiveRequest,
    CategoryCreate,
    CategoryListPublic,
    CategoryPublic,
    CategoryUpdate,
)
from app.api.v1.auth import get_current_user
from app.db.models.category import Category
from app.db.models.enums import CategoryKind
from app.db.models.user import User
from app.db.session import get_session

router = APIRouter(prefix="/categories", tags=["categories"])


def get_db() -> Iterator[Session]:
    """Per-router session dependency (mirrors auth.py's pattern)."""
    yield from get_session()


def _get_owned_category(
    db: Session,
    *,
    category_id: uuid.UUID,
    current_user: User,
    include_archived: bool = False,
) -> Category:
    """Load a category and assert it belongs to the calling user.

    Raises 404 — not 403 — for both ``not found`` and ``not yours`` so the
    endpoint doesn't leak the existence of another user's category IDs.
    Archived rows are 404 unless ``include_archived`` is set (used by the
    write endpoints to look up a row that might be archived — the archive
    endpoint itself is intentionally callable on already-archived rows for
    idempotency).
    """
    category = db.get(Category, category_id)
    if category is None or category.user_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="category not found",
        )
    if not include_archived and category.archived_at is not None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="category not found",
        )
    return category


def _is_descendant(
    db: Session,
    *,
    candidate_parent_id: uuid.UUID,
    of: uuid.UUID,
) -> bool:
    """Return True iff ``candidate_parent_id`` sits inside the subtree of ``of``.

    Walks the parent chain on the *candidate* up to the root, looking for
    ``of``. Bounded by the depth of the caller's tree (in practice the
    seed ships a 2-level tree at most — see ``services/seed.py``), so the
    linear walk is fine.

    A row whose ``parent_id`` equals itself is rejected implicitly: the
    loop sees its own id before reaching the root and returns True.
    """
    current_id: uuid.UUID | None = candidate_parent_id
    visited: set[uuid.UUID] = set()
    while current_id is not None:
        if current_id == of:
            return True
        if current_id in visited:
            # Defensive: a malformed tree (cycle introduced by a buggy
            # earlier migration) would loop forever — bail out so the
            # request returns a clean 400 instead of hanging the worker.
            return True
        visited.add(current_id)
        parent_id = db.execute(
            select(Category.parent_id).where(Category.id == current_id)
        ).scalar_one_or_none()
        current_id = parent_id
    return False


@router.post(
    "",
    response_model=CategoryPublic,
    status_code=status.HTTP_201_CREATED,
)
def create_category(
    payload: CategoryCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CategoryPublic:
    """Create a new category owned by the authenticated user.

    Validation (per AC (2)):

    * ``kind`` is Pydantic-validated to one of the enum values (422
      otherwise, before the route runs).
    * ``parent_id`` (when set) must belong to the caller — 404 otherwise.
    * ``parent_id`` must not create a self-cycle — 400 otherwise (the
      new row has no id yet so the only cycle it could form is the
      trivial self-parent case, which is also rejected here for safety
      even though it can't happen on a CREATE).
    * The parent must be of the same ``kind`` — 400 otherwise (we don't
      allow an income category nested under an expense parent, etc.).

    The new row is always created with ``archived_at = NULL`` and
    ``archived = False`` — archive is a separate endpoint.
    """
    parent: Category | None = None
    if payload.parent_id is not None:
        parent = _get_owned_category(
            db, category_id=payload.parent_id, current_user=current_user
        )
        if parent.kind != payload.kind:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"parent kind {parent.kind.value!r} does not match new category "
                    f"kind {payload.kind.value!r}"
                ),
            )

    category = Category(
        user_id=current_user.id,
        name=payload.name,
        kind=payload.kind,
        parent_id=parent.id if parent is not None else None,
        color=payload.color,
        icon=payload.icon,
        archived=False,
        archived_at=None,
    )
    db.add(category)
    db.commit()
    db.refresh(category)
    return CategoryPublic.model_validate(category)


@router.get("", response_model=CategoryListPublic)
def list_categories(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    limit: int = Query(
        default=100,
        ge=1,
        le=500,
        description="Page size. Default 100, max 500.",
    ),
    offset: int = Query(
        default=0,
        ge=0,
        description="Number of rows to skip from the start of the filtered result.",
    ),
) -> CategoryListPublic:
    """Return the caller's *active* categories (paginated, sorted).

    Archived rows (``archived_at IS NOT NULL``) are excluded so the FE
    never has to filter them out client-side. Deterministic ordering
    (AC: ``kind asc, parent_id asc, name asc``) — ``kind`` is sorted via
    an explicit ``CASE`` so ``expense`` doesn't accidentally land
    before ``income`` on alphabetical sort, and ``parent_id`` groups
    leaves under their parents so the FE can render an indented tree
    without a second pass. ``name`` is the final tiebreaker so the
    result is stable across requests.
    """
    kind_rank = case((Category.kind == CategoryKind.INCOME, 0), else_=1)

    base_where = [
        Category.user_id == current_user.id,
        Category.archived_at.is_(None),
    ]

    total = db.execute(
        select(func.count()).select_from(Category).where(*base_where)
    ).scalar_one()

    rows = list(
        db.execute(
            select(Category)
            .where(*base_where)
            .order_by(kind_rank, Category.parent_id.asc(), Category.name.asc())
            .limit(limit)
            .offset(offset)
        ).scalars()
    )

    return CategoryListPublic(
        items=[CategoryPublic.model_validate(row) for row in rows],
        total=int(total),
        limit=limit,
        offset=offset,
    )


@router.patch("/{category_id}", response_model=CategoryPublic)
def update_category(
    category_id: uuid.UUID,
    payload: CategoryUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CategoryPublic:
    """Partial update of a single category (scoped to the caller).

    Only the fields present in the request body are touched. The
    server-controlled fields (``id``, ``user_id``, ``archived``,
    ``archived_at``, timestamps) are never editable through this
    endpoint — the schema rejects them with 422 before the route runs.

    Cycle prevention (AC (3)): when ``parent_id`` is set, we reject:

    * a self-parent (``parent_id == category_id``) — 400,
    * a parent that is a descendant of the row being updated — 400,
    * a parent that belongs to another user — 404 (no leak).

    Kind matching: when both ``kind`` and ``parent_id`` are set, the
    effective kind must match the parent's kind (the same rule as
    CREATE). Cross-user rows return 404 and PATCH on an archived row
    also returns 404 so a stale id from the client never resurrects a
    tombstoned row.
    """
    category = _get_owned_category(
        db, category_id=category_id, current_user=current_user
    )

    data = payload.model_dump(exclude_unset=True)

    effective_kind: CategoryKind = data.get("kind", category.kind)

    if "parent_id" in data:
        new_parent_id = data["parent_id"]
        if new_parent_id is None:
            data["parent_id"] = None
        else:
            if new_parent_id == category.id:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="category cannot be its own parent",
                )
            parent = _get_owned_category(
                db, category_id=new_parent_id, current_user=current_user
            )
            if parent.kind != effective_kind:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=(
                        f"parent kind {parent.kind.value!r} does not match effective "
                        f"category kind {effective_kind.value!r}"
                    ),
                )
            if _is_descendant(
                db, candidate_parent_id=new_parent_id, of=category.id
            ):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=(
                        "parent_id cannot be a descendant of the category being updated "
                        "(cycle detected)"
                    ),
                )

    for field, value in data.items():
        setattr(category, field, value)

    db.commit()
    db.refresh(category)
    return CategoryPublic.model_validate(category)


@router.delete(
    "/{category_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
def delete_category(
    category_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    """Soft-delete a category by setting ``archived_at = now()``.

    Idempotent (AC (4)): a second DELETE on an already-archived row is
    a no-op (still 204). The tombstone timestamp is captured
    server-side — clients never supply ``archived_at`` — so the list
    endpoint can rely on ``archived_at IS NULL`` to surface active rows
    deterministically. The row stays in the DB for audit / history
    integrity (mirrors the sub-0003-02 soft-delete pattern on
    transactions).

    Children of an archived category are NOT auto-archived: the FE
    tree-builder can still show them under their (now-archived)
    parent. The category-rule engine (sub-0004-02) is responsible for
    skipping archived categories at match time.
    """
    category = _get_owned_category(
        db,
        category_id=category_id,
        current_user=current_user,
        include_archived=True,
    )
    if category.archived_at is None:
        category.archived = True
        category.archived_at = datetime.now(UTC)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/{category_id}/archive",
    response_model=CategoryPublic,
)
def archive_category(
    category_id: uuid.UUID,
    payload: CategoryArchiveRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CategoryPublic:
    """Explicit archive with optional reason.

    Alias for DELETE that also returns the archived row so the FE can
    update its local state without a follow-up GET. ``reason`` is
    accepted (reserved for the audit-trail sub-task) but currently
    discarded — the response shape and the persisted timestamp are
    stable across that future change.

    Idempotent: archiving an already-archived row returns the row with
    the existing ``archived_at`` (no overwriting of the original
    timestamp).
    """
    _ = payload  # explicit "currently unused" — see docstring above.
    category = _get_owned_category(
        db,
        category_id=category_id,
        current_user=current_user,
        include_archived=True,
    )
    if category.archived_at is None:
        category.archived = True
        category.archived_at = datetime.now(UTC)
    db.commit()
    db.refresh(category)
    return CategoryPublic.model_validate(category)
