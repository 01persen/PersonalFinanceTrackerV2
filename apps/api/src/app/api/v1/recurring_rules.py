"""Recurring-rule endpoints — CRUD for the authenticated user's recurring
rules (sub-0009-01, epic-0009).

Wire surface:

* ``GET /recurring-rules`` — paginated list, default page size 50,
  ordered by ``next_run_on asc, start_on asc, id asc`` so the FE's
  "due soon" widget can show the top of the list without a client
  sort.
* ``POST /recurring-rules`` — create. The schema's
  ``RecurringRuleCreate._check_end_on`` and ``_check_currency`` model
  validators run before the route; the route re-checks ownership of
  ``account_id`` and ``category_id`` against the persisted rows
  (404 / 422 — same pattern as the transactions / goals routers).
  ``next_run_on`` is always server-derived via
  :func:`app.services.recurring_rules.compute_next_run_on`.
* ``GET /recurring-rules/{id}`` — detail (404 for cross-user).
* ``PATCH /recurring-rules/{id}`` — partial update. ``extra="forbid"``
  rejects server-controlled fields (``id``, ``user_id``,
  ``next_run_on``, timestamps). The route re-derives
  ``next_run_on`` when ``start_on`` or ``cadence`` change via
  :func:`app.services.recurring_rules.should_advance_next_run_on`.
* ``DELETE /recurring-rules/{id}`` — hard delete. Returns 204
  idempotently (a second DELETE on the same id is still 204). Mirrors
  the transactional rule that the (future) materializer writes
  ``recurring_rule_id`` on each spawned transaction, so deleting a
  rule doesn't lose audit history — the historical transactions still
  carry the (now-orphaned) reference.

Cross-cutting TL decisions:

* **404 not 403 for cross-user.** Mirrors the categories / accounts /
  transactions / goals pattern — no leak of another user's row id.
* **Pydantic ``extra="forbid"``** on create + update so a client
  sending ``next_run_on`` (or any other server-controlled field) gets
  a 422 before the route runs.
* **422 for cross-field validation.** Pydantic raises ``ValueError``
  on ``end_on < start_on`` / currency mismatch → 422 with a
  field-level error body (the FastAPI default).
* **422 for category-kind mismatch.** A bill / subscription /
  cicilan_fixed rule can't link to an ``income`` category because
  the materializer would otherwise spawn an income transaction; the
  route surfaces this as 422 with a clear ``detail`` string.
* **Hard delete (not soft).** ``is_active`` is the soft-disable
  lever — DELETE is intentionally destructive so a rule with stale
  references can't accidentally re-fire if the materializer lands in
  a later iteration. A future epic can add a ``?archive=true`` query
  parameter for soft-delete parity with categories / goals if the
  audit need shows up.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from datetime import date as _date

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.schemas import (
    RecurringRuleCreate,
    RecurringRuleListPublic,
    RecurringRulePublic,
    RecurringRuleUpdate,
)
from app.api.v1.auth import get_current_user
from app.db.models.account import Account
from app.db.models.category import Category
from app.db.models.enums import CategoryKind
from app.db.models.recurring_rule import RecurringRule
from app.db.models.user import User
from app.db.session import get_session
from app.services.recurring_rules import (
    compute_next_run_on,
    should_advance_next_run_on,
)

router = APIRouter(prefix="/recurring-rules", tags=["recurring-rules"])


def get_db() -> Iterator[Session]:
    """Per-router session dependency (mirrors goals.py / categories.py)."""
    yield from get_session()


def _get_owned_account(db: Session, *, account_id: uuid.UUID, current_user: User) -> Account:
    """Load ``account_id`` and assert it belongs to the caller.

    Mirrors the pattern from :mod:`app.api.v1.goals`. Raises 404 (not
    403) so foreign ids don't leak; archived accounts return 404 so a
    rule cannot be silently re-linked to a closed account.
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


def _get_owned_category(db: Session, *, category_id: uuid.UUID, current_user: User) -> Category:
    """Load ``category_id`` and assert it belongs to the caller.

    Archived categories return 404 so a stale client id never
    resurrects a tombstoned rule on a closed category. The
    expense-kind check is done by the caller (with a 422) — this
    helper only handles ownership + archive.
    """
    category = db.get(Category, category_id)
    if category is None or category.user_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="category not found",
        )
    if category.archived_at is not None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="category not found",
        )
    return category


def _get_owned_rule(
    db: Session,
    *,
    rule_id: uuid.UUID,
    current_user: User,
) -> RecurringRule:
    """Load a recurring rule and assert it belongs to the calling user.

    404 (not 403) for both ``not found`` and ``not yours`` so the
    endpoint doesn't leak the existence of another user's rule IDs.
    """
    rule = db.get(RecurringRule, rule_id)
    if rule is None or rule.user_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="recurring rule not found",
        )
    return rule


def _validate_category_kind(
    *,
    category: Category,
    field_name: str,
) -> None:
    """Reject income categories on a recurring rule link.

    All three MVP rule kinds (bill / subscription / cicilan_fixed)
    auto-materialize as expense transactions (PRD §epic-0009), so a
    rule linked to an income category would land an income
    transaction on the worker's next run. The route surfaces this
    as 422 with a field-level message so the FE knows which field to
    swap, mirroring the goals router's category-kind mismatch
    handler.
    """
    if category.kind != CategoryKind.EXPENSE:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"{field_name} must reference an expense category; "
                f"category {category.id} has kind {category.kind.value!r}"
            ),
        )


def _validate_end_on_against_start_on(
    *,
    end_on: _date | None,
    start_on: _date,
) -> None:
    """Cross-field rule — ``end_on`` must be ``>= start_on``.

    Mirrors the ``GoalCreate._validate_kind_specific`` cross-field
    rule (saving: ``target_date >= start_date``) so the FE gets the
    same 422 surface on both endpoints.
    """
    if end_on is not None and end_on < start_on:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(f"end_on ({end_on.isoformat()}) must be >= start_on ({start_on.isoformat()})"),
        )


@router.post(
    "",
    response_model=RecurringRulePublic,
    status_code=status.HTTP_201_CREATED,
)
def create_recurring_rule(
    payload: RecurringRuleCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> RecurringRulePublic:
    """Create a new recurring rule owned by the authenticated user.

    Validation runs at three layers:

    * Pydantic (``RecurringRuleCreate._check_currency`` +
      ``_check_end_on``) — rejects shape + cross-field errors with
      a 422 before the route handler runs.
    * The route here — re-checks ``account_id`` ownership (404),
      ``category_id`` ownership (404) and category-kind match
      (422). The Pydantic check can't see the persisted row.
    * :func:`compute_next_run_on` — derives ``next_run_on`` from
      ``start_on + cadence`` server-side. The FE cannot bypass the
      derivation by sending ``next_run_on`` in the body
      (``extra="forbid"``).

    A brand-new rule is always created with ``is_active=True`` by
    default; the caller can opt out via the request body.
    """
    account = _get_owned_account(db, account_id=payload.account_id, current_user=current_user)

    category: Category | None = None
    if payload.category_id is not None:
        category = _get_owned_category(
            db, category_id=payload.category_id, current_user=current_user
        )
        _validate_category_kind(category=category, field_name="category_id")

    next_run_on = compute_next_run_on(start_on=payload.start_on, cadence=payload.cadence)

    rule = RecurringRule(
        user_id=current_user.id,
        account_id=account.id,
        category_id=category.id if category is not None else None,
        kind=payload.kind,
        cadence=payload.cadence,
        amount_cents=payload.amount_cents,
        currency=payload.currency,
        start_on=payload.start_on,
        end_on=payload.end_on,
        next_run_on=next_run_on,
        note=payload.note,
        is_active=payload.is_active,
    )
    db.add(rule)
    db.commit()
    db.refresh(rule)
    return RecurringRulePublic.model_validate(rule)


@router.get("", response_model=RecurringRuleListPublic)
def list_recurring_rules(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
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
) -> RecurringRuleListPublic:
    """Return the caller's recurring rules (paginated, sorted by next-run).

    Sort order is deterministic across requests:
    ``next_run_on asc, start_on asc, id asc``. The "due soon" widget
    on the FE renders the top of the page, so the cheapest scan is
    the next-run column ascending — a fresh rule with
    ``start_on = today`` and ``cadence = daily`` lands at index 0.

    Paused rules (``is_active=False``) are returned too — the FE
    decides whether to badge them or hide them client-side. A
    server-side ``?is_active=true`` filter lands in a follow-up if
    the rule count per user climbs enough to make the unsorted scan
    expensive.
    """
    base_where = [RecurringRule.user_id == current_user.id]

    total = db.execute(
        select(func.count()).select_from(RecurringRule).where(*base_where)
    ).scalar_one()

    rows = list(
        db.execute(
            select(RecurringRule)
            .where(*base_where)
            .order_by(
                RecurringRule.next_run_on.asc(),
                RecurringRule.start_on.asc(),
                RecurringRule.id.asc(),
            )
            .limit(limit)
            .offset(offset)
        ).scalars()
    )

    return RecurringRuleListPublic(
        items=[RecurringRulePublic.model_validate(row) for row in rows],
        total=int(total),
        limit=limit,
        offset=offset,
    )


@router.get("/{rule_id}", response_model=RecurringRulePublic)
def get_recurring_rule(
    rule_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> RecurringRulePublic:
    """Return a single recurring rule by id (scoped to the caller)."""
    rule = _get_owned_rule(db, rule_id=rule_id, current_user=current_user)
    return RecurringRulePublic.model_validate(rule)


@router.patch("/{rule_id}", response_model=RecurringRulePublic)
def update_recurring_rule(
    rule_id: uuid.UUID,
    payload: RecurringRuleUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> RecurringRulePublic:
    """Partial update of a single recurring rule (scoped to the caller).

    Only the fields present in the request body are touched. The
    server-controlled fields (``id``, ``user_id``, ``created_at``,
    ``updated_at``, ``next_run_on``) are never editable through this
    endpoint — the schema rejects unknown fields with 422 before the
    route runs and the route explicitly refuses to write
    ``next_run_on`` from the request (re-derives it server-side
    when ``start_on`` or ``cadence`` change via
    :func:`app.services.recurring_rules.should_advance_next_run_on`).

    Cross-user rows return 404 (same as create / list endpoints),
    and PATCH never resurrects a deleted rule — there's no
    soft-delete tombstone on this table in MVP.

    ``category_id`` can be cleared by sending ``null`` — the route
    accepts the explicit ``None`` and writes it through. A new
    non-null id is validated via ``_get_owned_category`` + the
    expense-kind check.

    ``end_on`` can be cleared by sending ``null``. A new non-null
    value is re-validated against the *effective* ``start_on``
    (i.e. the merged persisted + payload value) so a PATCH that
    flips both ``start_on`` and ``end_on`` together still lands a
    consistent schedule.
    """
    rule = _get_owned_rule(db, rule_id=rule_id, current_user=current_user)

    data = payload.model_dump(exclude_unset=True)

    if "account_id" in data and data["account_id"] is not None:
        _get_owned_account(
            db,
            account_id=data["account_id"],
            current_user=current_user,
        )

    if "category_id" in data:
        if data["category_id"] is None:
            data["category_id"] = None
        else:
            category = _get_owned_category(
                db,
                category_id=data["category_id"],
                current_user=current_user,
            )
            _validate_category_kind(category=category, field_name="category_id")

    # Re-derive ``next_run_on`` first so the cross-field end_on
    # validator below sees the same effective start_on that the row
    # will end up with.
    if should_advance_next_run_on(updated_fields=set(data.keys())):
        effective_start_on: _date = data.get("start_on", rule.start_on)
        effective_cadence = data.get("cadence", rule.cadence)
        rule.next_run_on = compute_next_run_on(
            start_on=effective_start_on, cadence=effective_cadence
        )

    effective_start_on = data.get("start_on", rule.start_on)
    effective_end_on = data.get("end_on", rule.end_on)
    _validate_end_on_against_start_on(end_on=effective_end_on, start_on=effective_start_on)

    for field, value in data.items():
        setattr(rule, field, value)

    db.commit()
    db.refresh(rule)
    return RecurringRulePublic.model_validate(rule)


@router.delete(
    "/{rule_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
def delete_recurring_rule(
    rule_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    """Hard-delete a recurring rule by id.

    Idempotent — a second DELETE on an already-deleted id returns
    404 (the row is gone, not tombstoned). The (future) materializer
    writes ``recurring_rule_id`` on each spawned transaction, so
    deleting a rule does *not* lose the audit trail — the historical
    transactions still carry the reference, the rule row is just
    absent from the CRUD list.
    """
    rule = _get_owned_rule(db, rule_id=rule_id, current_user=current_user)
    db.delete(rule)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
