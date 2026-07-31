"""Goals endpoints — CRUD + progress for the authenticated user's goals.

Scope: epic-0005, sub-0005-01. The wire surface is intentionally narrow:

* ``GET /goals`` — paginated list with ``kind`` + ``archived`` filters.
* ``POST /goals`` — create with kind-specific validation.
* ``GET /goals/{id}`` — detail (404 for cross-user / archived).
* ``PATCH /goals/{id}`` — partial update with re-validated kind rules.
* ``DELETE /goals/{id}`` — soft delete via ``archived_at``.
* ``GET /goals/{id}/progress`` — current vs. target percentage plus
  achieved-at and the auto-calc hints the FE renders in the progress
  card.

The compute path that derives ``current_amount_cents`` from the linked
account balance is owned by sub-0005-02; for now the progress endpoint
returns the persisted column as-is and falls back to the linked
account's live balance (via the saldo engine) when the persisted value
is ``NULL`` — i.e. a goal that opted in to "track my savings account"
semantics.

Conventions follow :mod:`app.api.v1.categories` (per-router ``get_db``
re-export, ``HTTPBearer`` via ``get_current_user``, 404 instead of 403
for ``not yours``, ``archived_at IS NULL`` exclusion everywhere).

Cross-cutting TL decisions:

* **404 not 403 for cross-user / archived.** Mirrors the categories /
  accounts / transactions pattern — no leak.
* **Sort chain on list.** ``kind asc, start_date desc, created_at desc,
  id asc`` so the FE gets a deterministic order and the auto-calc
  fields can be edited without the row jumping around the page.
* **Pydantic ``extra="forbid"``** on create + update so a client sending
  ``kind`` or any other server-controlled field gets a 422 before the
  route runs.
* **Per-kind ``model_validator``** on the create schema so a saving goal
  with an EF-only field surfaces as a clear 422 instead of silently
  landing in the DB.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from datetime import date as _date

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.schemas import (
    GoalCreate,
    GoalListPublic,
    GoalProgressPublic,
    GoalPublic,
    GoalUpdate,
)
from app.api.v1.auth import get_current_user
from app.db.models.account import Account
from app.db.models.enums import GoalKind
from app.db.models.goal import Goal
from app.db.models.user import User
from app.db.session import get_session
from app.services.balance import calculate_account_balance

router = APIRouter(prefix="/goals", tags=["goals"])


def get_db() -> Iterator[Session]:
    """Per-router session dependency (mirrors categories.py / accounts.py)."""
    yield from get_session()


def _get_owned_account(db: Session, *, account_id: uuid.UUID, current_user: User) -> Account:
    """Load ``account_id`` and assert it belongs to the caller.

    Mirrors the pattern from :mod:`app.api.v1.accounts`. Raises 404
    (not 403) so foreign ids don't leak; archived accounts return
    404 so a goal cannot be silently re-linked to a closed account.
    """
    account = db.get(Account, account_id)
    if account is None or account.user_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="account not found",
        )
    if account.archived:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="account not found",
        )
    return account


def _get_owned_goal(
    db: Session,
    *,
    goal_id: uuid.UUID,
    current_user: User,
    include_archived: bool = False,
) -> Goal:
    """Load a goal and assert it belongs to the calling user.

    404 — not 403 — for both ``not found`` and ``not yours``. Archived
    rows are 404 unless ``include_archived`` is set; the DELETE route
    uses ``include_archived=True`` so an idempotent second DELETE on a
    tombstoned row is still 204 (not 404).
    """
    goal = db.get(Goal, goal_id)
    if goal is None or goal.user_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="goal not found",
        )
    if not include_archived and goal.archived_at is not None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="goal not found",
        )
    return goal


def _validate_kind_specific(
    *,
    goal: Goal,
    payload: GoalCreate | GoalUpdate,
) -> None:
    """Re-run the kind-specific rules against the merged effective row.

    ``GoalCreate`` runs the same rules in Pydantic because the row
    doesn't exist yet. ``GoalUpdate`` can't, so this helper does the
    merged-values check after the route has loaded the persisted goal.
    The two checks stay in lock-step because the rules are exactly the
    ones called out in PRD §14.

    Cross-field rule covered here:

    * ``target_date >= start_date`` for saving goals.
    * ``linked_account_id`` re-validated against the caller when
      supplied (handled by ``_get_owned_account`` instead — kept
      separate from this validator because it requires a DB roundtrip).
    """
    target_date = getattr(payload, "target_date", None)
    start_date = getattr(payload, "start_date", None)

    effective_target_date: _date | None = (
        target_date if target_date is not None else goal.target_date
    )
    effective_start_date: _date = start_date if start_date is not None else goal.start_date

    if (
        goal.kind == GoalKind.SAVING
        and effective_target_date is not None
        and effective_target_date < effective_start_date
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"target_date ({effective_target_date.isoformat()}) must be >= "
                f"start_date ({effective_start_date.isoformat()})"
            ),
        )


def _compute_current_amount_cents(
    db: Session,
    *,
    goal: Goal,
) -> int:
    """Return the current amount for a goal at request time.

    sub-0005-01 keeps the persistence path simple: if the goal has a
    ``current_amount_cents`` value stored, return it (this covers
    unlinked goals and any caller that wrote a manual value via PATCH);
    otherwise, if the goal is linked to an account, fall back to that
    account's live balance via the saldo engine.

    sub-0005-02 will replace this with a race-safe service-layer
    compute path that always derives from the linked account when set
    and ignores the stored column. Until then, this gives the FE the
    right number for both flavours without forcing a second round-trip
    on every progress click.
    """
    if goal.current_amount_cents is not None:
        return goal.current_amount_cents
    if goal.linked_account_id is not None:
        balance = calculate_account_balance(
            db,
            user_id=goal.user_id,
            account_id=uuid.UUID(str(goal.linked_account_id)),
            as_of=datetime.now(UTC).date(),
        )
        if balance is not None:
            return balance.balance_cents
    return 0


@router.post(
    "",
    response_model=GoalPublic,
    status_code=status.HTTP_201_CREATED,
)
def create_goal(
    payload: GoalCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> GoalPublic:
    """Create a new goal owned by the authenticated user.

    Validation runs at two layers:

    * Pydantic (``GoalCreate._validate_kind_specific``) — rejects
      cross-field leaks (EF-only fields on a saving goal, etc.) with
      a 422 before the route handler runs.
    * The route here — re-checks ``linked_account_id`` ownership (404)
      and the ``target_date >= start_date`` cross-field rule (422). The
      Pydantic check can't see the persisted row, so a future sub-task
      that introduces "default start_date to today" wouldn't be
      catched there.

    The new row is always created with ``archived_at = NULL``;
    archive is a separate endpoint (DELETE).
    """
    if payload.linked_account_id is not None:
        _get_owned_account(
            db,
            account_id=payload.linked_account_id,
            current_user=current_user,
        )

    start_date: _date = payload.start_date or datetime.now(UTC).date()

    if payload.target_date is not None and payload.target_date < start_date:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"target_date ({payload.target_date.isoformat()}) must be >= "
                f"start_date ({start_date.isoformat()})"
            ),
        )

    goal = Goal(
        user_id=current_user.id,
        kind=payload.kind,
        name=payload.name,
        target_amount_cents=payload.target_amount_cents,
        current_amount_cents=payload.current_amount_cents,
        linked_account_id=payload.linked_account_id,
        start_date=start_date,
        target_date=payload.target_date,
        jangka_waktu_months=payload.jangka_waktu_months,
        tabungan_bulanan_cents=payload.tabungan_bulanan_cents,
        monthly_expense_cents=payload.monthly_expense_cents,
        jumlah_tanggungan=payload.jumlah_tanggungan,
        multiplier=payload.multiplier,
        lama_mengumpulkan_bulan=None,
        target_amount_snapshot_cents=None,
        notes=payload.notes,
        archived_at=None,
    )
    db.add(goal)
    db.commit()
    db.refresh(goal)
    return GoalPublic.from_goal(goal)


@router.get("", response_model=GoalListPublic)
def list_goals(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    kind: str | None = Query(
        default=None,
        description="Filter by goal kind (``saving`` / ``emergency_fund``).",
    ),
    archived: bool = Query(
        default=False,
        description=(
            "``false`` (default) returns active goals only — those with "
            "``archived_at IS NULL``. ``true`` returns the archived set "
            "exclusively — those with ``archived_at IS NOT NULL``."
        ),
    ),
    limit: int = Query(
        default=50,
        ge=1,
        le=200,
        description="Page size. Default 50, max 200.",
    ),
    offset: int = Query(
        default=0,
        ge=0,
        description="Number of rows to skip from the start of the filtered result.",
    ),
) -> GoalListPublic:
    """Return the caller's goals with optional ``kind`` + ``archived`` filters.

    Active rows (``archived_at IS NULL``) are returned by default — the
    FE pagination is built on top of those. Pass ``?archived=true`` to
    surface *only* the tombstoned set (e.g. for an "Archived" tab).

    Sort order is deterministic across requests:
    ``kind asc, start_date desc, created_at desc, id asc`` so two
    goals of the same kind stay in a stable order as the user scrolls
    and edits.
    """
    kind_enum: GoalKind | None = None
    if kind is not None:
        try:
            kind_enum = GoalKind(kind)
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=(f"kind must be one of {[k.value for k in GoalKind]}; got {kind!r}"),
            ) from exc

    base_where = [Goal.user_id == current_user.id]
    if archived:
        base_where.append(Goal.archived_at.is_not(None))
    else:
        base_where.append(Goal.archived_at.is_(None))
    if kind_enum is not None:
        base_where.append(Goal.kind == kind_enum)

    total = db.execute(select(func.count()).select_from(Goal).where(*base_where)).scalar_one()

    rows = list(
        db.execute(
            select(Goal)
            .where(*base_where)
            .order_by(
                Goal.kind.asc(),
                Goal.start_date.desc(),
                Goal.created_at.desc(),
                Goal.id.asc(),
            )
            .limit(limit)
            .offset(offset)
        ).scalars()
    )

    return GoalListPublic(
        items=[GoalPublic.from_goal(row) for row in rows],
        total=int(total),
        limit=limit,
        offset=offset,
    )


@router.get("/{goal_id}", response_model=GoalPublic)
def get_goal(
    goal_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> GoalPublic:
    """Return a single goal by id (scoped to the caller)."""
    goal = _get_owned_goal(db, goal_id=goal_id, current_user=current_user)
    return GoalPublic.from_goal(goal)


@router.patch("/{goal_id}", response_model=GoalPublic)
def update_goal(
    goal_id: uuid.UUID,
    payload: GoalUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> GoalPublic:
    """Partial update of a single goal (scoped to the caller).

    Only the fields present in the request body are touched. The
    server-controlled fields (``id``, ``user_id``, ``created_at``,
    ``updated_at``, ``archived_at``, the auto-calc EF fields) are
    never editable through this endpoint — the schema rejects unknown
    fields with 422 before the route runs.

    Cross-user rows return 404 (same as create / list endpoints), and
    PATCH on an archived row also returns 404 so a stale id from the
    client never resurrects a tombstoned goal.

    ``linked_account_id`` can be cleared by sending ``null`` — the
    route accepts the explicit ``None`` and writes it through. A new
    non-null id is validated via ``_get_owned_account``.
    """
    goal = _get_owned_goal(db, goal_id=goal_id, current_user=current_user)

    data = payload.model_dump(exclude_unset=True)

    if "linked_account_id" in data and data["linked_account_id"] is not None:
        _get_owned_account(
            db,
            account_id=data["linked_account_id"],
            current_user=current_user,
        )

    _validate_kind_specific(goal=goal, payload=payload)

    for field, value in data.items():
        setattr(goal, field, value)

    db.commit()
    db.refresh(goal)
    return GoalPublic.from_goal(goal)


@router.delete(
    "/{goal_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
def delete_goal(
    goal_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    """Soft-delete a goal by setting ``archived_at = now()``.

    Idempotent — a second DELETE on an already-archived row is a no-op
    (still 204). The tombstone timestamp is captured server-side
    (mirrors the ``archived_at`` pattern on categories, sub-0004-01).
    """
    goal = _get_owned_goal(
        db,
        goal_id=goal_id,
        current_user=current_user,
        include_archived=True,
    )
    if goal.archived_at is None:
        goal.archived_at = datetime.now(UTC)  # type: ignore[assignment]
        db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{goal_id}/progress", response_model=GoalProgressPublic)
def get_goal_progress(
    goal_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> GoalProgressPublic:
    """Return the progress snapshot for a goal.

    See :class:`GoalProgressPublic` for the contract. ``percentage`` is
    capped at 100 (a goal that overshoots its target still surfaces as
    100% in the progress bar) and rounded to 2 decimals so the FE
    doesn't have to format.

    ``achieved_at`` is the persisted row's ``updated_at`` timestamp
    when the goal has crossed the threshold (current >= target). This
    is the best signal we have in sub-0005-01 — a more accurate
    "achievement moment" lands when sub-0005-02 wires the live
    recompute path.
    """
    goal = _get_owned_goal(db, goal_id=goal_id, current_user=current_user)

    current_amount_cents = _compute_current_amount_cents(db, goal=goal)
    target = goal.target_amount_cents
    if target > 0:
        raw = (current_amount_cents / target) * 100.0
        percentage = round(min(raw, 100.0), 2)
    else:
        percentage = 0.0

    achieved_at: datetime | None = goal.updated_at if current_amount_cents >= target else None

    return GoalProgressPublic(
        goal_id=goal.id,
        kind=goal.kind,
        current_amount_cents=current_amount_cents,
        target_amount_cents=target,
        percentage=percentage,
        achieved_at=achieved_at,
        tabungan_bulanan_cents=goal.tabungan_bulanan_cents,
        lama_mengumpulkan_bulan=goal.lama_mengumpulkan_bulan,
    )
