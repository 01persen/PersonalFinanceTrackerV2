"""Goals endpoints -- CRUD + progress for the authenticated user's goals.

Scope: epic-0005, sub-0005-01 (CRUD + endpoint progress) + sub-0005-02
(engine: live-derive current from linked account, EF target snapshot
frozen at creation, saving tabungan_bulanan auto-calc, achieved_at
column + recompute hook fired from the transactions router).

Wire surface:

* ``GET /goals`` -- paginated list with ``kind`` + ``archived`` filters.
* ``POST /goals`` -- create with kind-specific validation; sub-0005-02
  adds the EF ``target_amount_snapshot_cents`` auto-calc and the
  saving ``tabungan_bulanan_cents`` auto-calc as server-side writes
  the FE cannot bypass.
* ``GET /goals/{id}`` -- detail (404 for cross-user / archived).
* ``PATCH /goals/{id}`` -- partial update; sub-0005-02 keeps the EF
  snapshot frozen (TL decision -- patch does NOT re-derive the EF
  formula) and re-runs the saving tabungan_bulanan auto-calc +
  ``lama_mengumpulkan_bulan`` when inputs change.
* ``DELETE /goals/{id}`` -- soft delete via ``archived_at``.
* ``GET /goals/{id}/progress`` -- pure read; sub-0005-02 builds the
  payload via
  :func:`app.services.goal_engine.compute_goal_progress` so linked
  vs unlinked semantics + clamp + percentage rounding stay in one
  place, and ``achieved_at`` is the *persisted* column set by the
  recompute hook (never written by this endpoint).

Conventions follow :mod:`app.api.v1.categories` (per-router ``get_db``
re-export, ``HTTPBearer`` via ``get_current_user``, 404 instead of 403
for ``not yours``, ``archived_at IS NULL`` exclusion everywhere).

Cross-cutting TL decisions:

* **404 not 403 for cross-user / archived.** Mirrors the categories /
  accounts / transactions pattern -- no leak.
* **Sort chain on list.** ``kind asc, start_date desc, created_at desc,
  id asc`` so the FE gets a deterministic order and the auto-calc
  fields can be edited without the row jumping around the page.
* **Pydantic ``extra="forbid"``** on create + update so a client sending
  ``kind`` or any other server-controlled field gets a 422 before the
  route runs.
* **Per-kind ``model_validator``** on the create schema so a saving goal
  with an EF-only field surfaces as a clear 422 instead of silently
  landing in the DB.
* **EF snapshot frozen at create.** ``PATCH`` does NOT re-derive
  ``target_amount_snapshot_cents`` even if ``monthly_expense_cents`` or
  ``jumlah_tanggungan`` are changed (TL confirm in parent issue).
  ``lama_mengumpulkan_bulan`` *is* re-derived because it depends on
  the (mutable) ``monthly_expense_cents`` rate.
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
from app.services.goal_engine import (
    compute_ef_lama_mengumpulkan_bulan,
    compute_ef_target_snapshot_cents,
    compute_goal_progress,
    compute_saving_tabungan_bulanan_cents,
)

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

    404 -- not 403 -- for both ``not found`` and ``not yours``. Archived
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
      supplied (handled by ``_get_owned_account`` instead -- kept
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


def _build_goal_from_create(
    db: Session,
    *,
    current_user: User,
    payload: GoalCreate,
) -> Goal:
    """Construct the new ``Goal`` row, applying sub-0005-02 auto-calcs.

    * EF -- ``target_amount_snapshot_cents`` frozen via
      :func:`compute_ef_target_snapshot_cents`; ``lama_mengumpulkan_bulan``
      derived from the snapshot / ``monthly_expense_cents`` rate. None
      of the auto-calc fields are user-editable; the route ignores
      whatever the request sent.
    * Saving -- ``tabungan_bulanan_cents`` derived from
      ``target_amount_cents / jangka_waktu_months``; ``lama_mengumpulkan_bulan``
      is unused for saving (return ``None``).

    The omitted-``start_date`` default uses the caller's local
    calendar date (``date.today()``) so a user in UTC+ creating a
    goal at 00:30 local gets a ``start_date`` matching their local
    Monday, not UTC's Sunday (sub-0005-06 / QA DEFECT-1 fix).
    """
    start_date: _date = payload.start_date or _date.today()

    if payload.kind == GoalKind.EMERGENCY_FUND:
        # ``monthly_expense_cents`` and ``jumlah_tanggungan`` are
        # enforced >0 / >=0 by Pydantic; we still defensive-null
        # them so the EF formula doesn't crash on a missing row.
        monthly_expense = payload.monthly_expense_cents or 0
        jumlah_tanggungan = payload.jumlah_tanggungan or 0
        target_snapshot = compute_ef_target_snapshot_cents(
            db,
            user_id=current_user.id,
            monthly_expense_cents=monthly_expense,
            jumlah_tanggungan=jumlah_tanggungan,
            override_multiplier=payload.multiplier,
        )
        lama_mengumpulkan = compute_ef_lama_mengumpulkan_bulan(
            target_amount_snapshot_cents=target_snapshot,
            monthly_expense_cents=payload.monthly_expense_cents,
        )
        return Goal(
            user_id=current_user.id,
            kind=payload.kind,
            name=payload.name,
            target_amount_cents=payload.target_amount_cents,
            current_amount_cents=payload.current_amount_cents,
            linked_account_id=payload.linked_account_id,
            start_date=start_date,
            target_date=None,
            jangka_waktu_months=None,
            tabungan_bulanan_cents=None,
            monthly_expense_cents=payload.monthly_expense_cents,
            jumlah_tanggungan=payload.jumlah_tanggungan,
            multiplier=payload.multiplier,
            lama_mengumpulkan_bulan=lama_mengumpulkan,
            target_amount_snapshot_cents=target_snapshot,
            notes=payload.notes,
            archived_at=None,
            achieved_at=None,
        )

    # SAVING -- auto-calc ``tabungan_bulanan_cents`` from the horizon.
    tabungan_bulanan = compute_saving_tabungan_bulanan_cents(
        target_amount_cents=payload.target_amount_cents,
        jangka_waktu_months=payload.jangka_waktu_months or 0,
    )
    return Goal(
        user_id=current_user.id,
        kind=payload.kind,
        name=payload.name,
        target_amount_cents=payload.target_amount_cents,
        current_amount_cents=payload.current_amount_cents,
        linked_account_id=payload.linked_account_id,
        start_date=start_date,
        target_date=payload.target_date,
        jangka_waktu_months=payload.jangka_waktu_months,
        tabungan_bulanan_cents=tabungan_bulanan,
        monthly_expense_cents=None,
        jumlah_tanggungan=None,
        multiplier=None,
        lama_mengumpulkan_bulan=None,
        target_amount_snapshot_cents=None,
        notes=payload.notes,
        archived_at=None,
        achieved_at=None,
    )


def _reapply_autocalcs_on_patch(
    db: Session,
    *,
    goal: Goal,
    payload: GoalUpdate,
) -> None:
    """Re-run sub-0005-02 auto-calcs on PATCH without touching the EF snapshot.

    EF: the snapshot is intentionally **frozen** at creation (TL decision),
    so patching ``monthly_expense_cents`` or ``jumlah_tanggungan`` does NOT
    re-derive ``target_amount_snapshot_cents``. ``lama_mengumpulkan_bulan``
    IS re-derived because it depends on the (mutable) ``monthly_expense_cents``
    rate.

    Saving: re-derive ``tabungan_bulanan_cents`` whenever ``target_amount_cents``
    or ``jangka_waktu_months`` change so the saving-rate column stays in
    sync with the user-edited inputs.
    """
    data = payload.model_dump(exclude_unset=True)

    if goal.kind == GoalKind.SAVING and (
        "target_amount_cents" in data or "jangka_waktu_months" in data
    ):
        effective_target = data.get("target_amount_cents", goal.target_amount_cents)
        effective_horizon = data.get("jangka_waktu_months", goal.jangka_waktu_months)
        goal.tabungan_bulanan_cents = compute_saving_tabungan_bulanan_cents(
            target_amount_cents=int(effective_target or 0),
            jangka_waktu_months=int(effective_horizon or 0),
        )

    elif goal.kind == GoalKind.EMERGENCY_FUND and "monthly_expense_cents" in data:
        # Snapshot is frozen -- never overwrite it on PATCH. We only refresh
        # ``lama_mengumpulkan_bulan`` because that's a function of the
        # (mutable) ``monthly_expense_cents`` rate and the snapshot.
        goal.lama_mengumpulkan_bulan = compute_ef_lama_mengumpulkan_bulan(
            target_amount_snapshot_cents=goal.target_amount_snapshot_cents,
            monthly_expense_cents=data["monthly_expense_cents"],
        )


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

    Validation runs at three layers:

    * Pydantic (``GoalCreate._validate_kind_specific``) -- rejects
      cross-field leaks (EF-only fields on a saving goal, etc.) with
      a 422 before the route handler runs.
    * The route here -- re-checks ``linked_account_id`` ownership (404)
      and the ``target_date >= start_date`` cross-field rule (422).
      The Pydantic check can't see the persisted row, so a future
      sub-task that introduces "default start_date to today" wouldn't
      be catched there.
    * :func:`_build_goal_from_create` -- applies the sub-0005-02
      auto-calc formulas server-side (saving ``tabungan_bulanan``,
      EF ``target_amount_snapshot`` + ``lama_mengumpulkan_bulan``).
      The FE cannot bypass these by sending a body field with the
      same name (``extra="forbid"``); the server writes them last
      on top of whatever the request carried.

    The new row is always created with ``archived_at = NULL`` and
    ``achieved_at = NULL``; archive is a separate endpoint (DELETE)
    and achievement comes from the recompute hook (sub-0005-02).
    """
    if payload.linked_account_id is not None:
        _get_owned_account(
            db,
            account_id=payload.linked_account_id,
            current_user=current_user,
        )

    start_date: _date = payload.start_date or _date.today()

    if payload.target_date is not None and payload.target_date < start_date:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"target_date ({payload.target_date.isoformat()}) must be >= "
                f"start_date ({start_date.isoformat()})"
            ),
        )

    goal = _build_goal_from_create(db, current_user=current_user, payload=payload)
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
            "``false`` (default) returns active goals only -- those with "
            "``archived_at IS NULL``. ``true`` returns the archived set "
            "exclusively -- those with ``archived_at IS NOT NULL``."
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

    Active rows (``archived_at IS NULL``) are returned by default -- the
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
    ``updated_at``, ``archived_at``, ``achieved_at``, and the EF
    ``target_amount_snapshot_cents``) are never editable through this
    endpoint -- the schema rejects unknown fields with 422 before the
    route runs and the route explicitly refuses to re-derive
    ``target_amount_snapshot_cents`` on PATCH (TL-confirmed decision).

    ``extra="forbid"`` rejects any unknown / server-controlled
    fields so a client attempting to edit ``kind`` (or set
    ``target_amount_snapshot_cents`` directly) gets a 422.

    Cross-user rows return 404 (same as create / list endpoints), and
    PATCH on an archived row also returns 404 so a stale id from the
    client never resurrects a tombstoned goal.

    ``linked_account_id`` can be cleared by sending ``null`` -- the
    route accepts the explicit ``None`` and writes it through. A new
    non-null id is validated via ``_get_owned_account``.

    sub-0005-02 auto-calc behaviour on PATCH:

    * Saving -- ``tabungan_bulanan_cents`` re-derived whenever the
      persisted ``target_amount_cents`` or ``jangka_waktu_months``
      change.
    * EF -- ``target_amount_snapshot_cents`` is **frozen** at creation
      and never re-derived. ``lama_mengumpulkan_bulan`` IS
      re-derived when ``monthly_expense_cents`` changes because
      it's a function of the mutable rate.
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

    _reapply_autocalcs_on_patch(db, goal=goal, payload=payload)

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

    Idempotent -- a second DELETE on an already-archived row is a no-op
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

    sub-0005-02 owns the compute path. The pure-read rule is:

    * ``current_amount_cents`` from :func:`compute_goal_progress` --
      linked-account saldo when ``linked_account_id IS NOT NULL``,
      stored value when ``linked_account_id IS NULL``.
    * ``percentage`` is ``min(100, current / target * 100)`` rounded
      to two decimals, ``0`` when ``target <= 0``.
    * ``achieved_at`` is the *persisted* column on the goal row --
      written by :func:`app.services.goal_progress_recompute.
      recompute_achieved_at_for_goal` once on the first crossing.
      This endpoint never writes.

    Note: a freshly-created saving goal whose ``current_amount_cents``
    is ``0`` and whose ``target_amount_cents`` is ``100`` ships
    ``percentage == 0.0`` and ``achieved_at is None``. The recompute
    hook (transactions router + BackgroundTasks) sets ``achieved_at``
    once a tx on the linked account pushes the live saldo past the
    target.
    """
    goal = _get_owned_goal(db, goal_id=goal_id, current_user=current_user)

    progress = compute_goal_progress(db, goal=goal)

    return GoalProgressPublic(
        goal_id=progress.goal_id,
        kind=progress.kind,
        current_amount_cents=progress.current_amount_cents,
        target_amount_cents=progress.target_amount_cents,
        percentage=progress.percentage,
        achieved_at=progress.achieved_at,
        tabungan_bulanan_cents=progress.tabungan_bulanan_cents,
        lama_mengumpulkan_bulan=progress.lama_mengumpulkan_bulan,
    )
