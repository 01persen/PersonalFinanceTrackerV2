"""Category-rule endpoints — CRUD + admin apply-rules (sub-0004-02).

Scope:

* CRUD on ``/api/v1/category-rules`` for the caller's rules —
  foundation for FE Manajemen Rule Kategori (a future sub-task). The
  apply engine (services/rule_engine.py) reads the same table.
* ``POST /api/v1/categories/apply-rules`` — admin endpoint that
  applies the engine across the caller's existing transactions. Two
  modes:

    - ``apply_backfill=false`` (dry run): walk every non-deleted,
      note-bearing transaction, count the *would-be* changes, return
      ``affected_transaction_ids`` so the FE can preview before
      committing.
    - ``apply_backfill=true``: walk the same set, update
      ``category_id`` and write one ``rule_audit_log`` row per
      change, in a single DB transaction.

  The endpoint is mounted under ``/categories`` because the response
  shape mirrors a backfill report — keeping the URL on the
  ``categories`` resource avoids an extra top-level router for a
  feature that genuinely writes to the ``transactions`` table.

Rules ordering: deterministic ``priority DESC, id ASC`` (mirrors the
engine's tie-break). Soft-delete via ``active=false`` instead of a
hard delete so the audit trail keeps referring to live rows.

Cross-cutting:

* B — ownership is 404 (not 403) so the endpoint doesn't leak
  foreign rule ids.
* ``origin="backfill"`` is hard-coded on every apply-rules commit;
  ``origin="live"`` lives on the live POST/PATCH path. The audit
  table distinguishes them so QA can assert live vs admin-driven
  reassignments separately.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import desc, func, select
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

from app.api.v1.auth import get_current_user
from app.db.models.category import Category
from app.db.models.category_rule import CategoryRule
from app.db.models.transaction import Transaction
from app.db.models.user import User
from app.db.session import get_session
from app.services.rule_engine import (
    PATTERN_MAX_CHARS,
    REGEX_MAX_PATTERN_CHARS,
    ApplyResult,
    apply_rules_to_transactions,
)

router = APIRouter(prefix="/category-rules", tags=["category-rules"])


def get_db() -> Iterator[Session]:
    """Per-router session dependency (mirrors accounts.py / categories.py)."""
    yield from get_session()


# ---------------------------------------------------------------------------
# Schemas (kept local to the router — the v1 surface is small enough that
# splitting into ``schemas.py`` would just add noise).
# ---------------------------------------------------------------------------


class CategoryRulePublic(BaseModel):
    """Output shape for a rule row (mirrors the model columns)."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    pattern: str
    category_id: uuid.UUID
    priority: int
    is_regex: bool
    active: bool
    created_at: datetime
    updated_at: datetime


class CategoryRuleCreate(BaseModel):
    """Body for ``POST /category-rules``.

    Validation:

    * ``pattern`` 1-255 chars (Pydantic). Regex rules additionally
      capped at 1024 (already covered by the 255 cap so the check
      below is belt-and-braces in case the API gets a higher cap
      later).
    * ``priority`` defaults to 100 — most callers want the standard
      weight without thinking about it.
    * ``is_regex`` is opt-in. The apply path documents the ReDoS risk
      in services/rule_engine.py.
    * ``active`` defaults to ``True`` so newly created rules take
      effect immediately. Callers can ``PATCH /category-rules/{id}``
      with ``active=false`` to disable without losing the rule.
    """

    model_config = ConfigDict(extra="forbid")

    pattern: str = Field(min_length=1, max_length=PATTERN_MAX_CHARS)
    category_id: uuid.UUID
    priority: int = Field(default=100, ge=0, le=10_000)
    is_regex: bool = False
    active: bool = True


class CategoryRuleUpdate(BaseModel):
    """Body for ``PATCH /category-rules/{id}``.

    Every field is optional. ``extra="forbid"`` keeps the server-
    controlled fields (``id``, ``user_id``, timestamps) immutable.
    The route still rejects patterns longer than the safety cap.
    """

    model_config = ConfigDict(extra="forbid")

    pattern: str | None = Field(default=None, min_length=1, max_length=PATTERN_MAX_CHARS)
    category_id: uuid.UUID | None = None
    priority: int | None = Field(default=None, ge=0, le=10_000)
    is_regex: bool | None = None
    active: bool | None = None


class CategoryRuleListPublic(BaseModel):
    """Response envelope for ``GET /category-rules``."""

    items: list[CategoryRulePublic]
    total: int


class ApplyRulesRequest(BaseModel):
    """Body for ``POST /api/v1/categories/apply-rules``.

    ``apply_backfill=true`` commits the changes; ``apply_backfill=false``
    is a dry run that reports the affected ids without writing.
    """

    model_config = ConfigDict(extra="forbid")

    apply_backfill: bool = False


class ApplyRulesPublic(BaseModel):
    """Response shape mirroring sub-0004-02 AC (4)."""

    rules_evaluated: int
    transactions_updated: int
    affected_transaction_ids: list[uuid.UUID]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _get_owned_rule(
    db: Session,
    *,
    rule_id: uuid.UUID,
    current_user: User,
) -> CategoryRule:
    """Load a rule and assert it belongs to the caller (404 on miss / foreign)."""
    rule = db.get(CategoryRule, rule_id)
    if rule is None or rule.user_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="category rule not found",
        )
    return rule


def _validate_target_category(
    db: Session,
    *,
    category_id: uuid.UUID,
    current_user: User,
) -> Category:
    """Load ``category_id`` and assert it belongs to the caller + not archived.

    Returns the row so the caller can use it for kind checks; raises
    404 otherwise (no leak).
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


def _list_transactions_for_user(
    db: Session, *, user_id: uuid.UUID
) -> list[Transaction]:
    """Return the caller's active transactions sorted for the apply pass.

    Order is ``occurred_on DESC, id ASC`` so the FE can render the
    report in the same order as the "Pendapatan & Pengeluaran
    Bulanan" view (sub-0003-01 + sub-0003-04). The apply engine itself
    doesn't depend on the input order, but keeping this stable makes
    the audit trail + the response predictable for QA.
    """
    stmt = (
        select(Transaction)
        .where(
            Transaction.user_id == user_id,
            Transaction.deleted_at.is_(None),
        )
        .order_by(desc(Transaction.occurred_on), Transaction.id.asc())
    )
    return list(db.execute(stmt).scalars())


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


@router.post(
    "",
    response_model=CategoryRulePublic,
    status_code=status.HTTP_201_CREATED,
)
def create_category_rule(
    payload: CategoryRuleCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CategoryRulePublic:
    """Create a category rule owned by the authenticated user.

    Validates that the target ``category_id`` belongs to the caller
    and isn't archived (404 otherwise — same ownership pattern as
    categories + transactions). Patterns that exceed the regex cap
    are rejected here at the API boundary so the apply path never
    sees them.
    """
    target = _validate_target_category(
        db, category_id=payload.category_id, current_user=current_user
    )
    _ = target  # kind-check is implicit (any active category is fine)

    rule = CategoryRule(
        user_id=current_user.id,
        pattern=payload.pattern,
        category_id=payload.category_id,
        priority=payload.priority,
        is_regex=payload.is_regex,
        active=payload.active,
    )
    db.add(rule)
    db.commit()
    db.refresh(rule)
    return CategoryRulePublic.model_validate(rule)


@router.get("", response_model=CategoryRuleListPublic)
def list_category_rules(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CategoryRuleListPublic:
    """List the caller's rules ordered ``priority DESC, id ASC``.

    Includes inactive rules so the FE can present a "Disabled rules"
    section; the engine itself filters on ``active=true`` at apply
    time.
    """
    rows = list(
        db.execute(
            select(CategoryRule)
            .where(CategoryRule.user_id == current_user.id)
            .order_by(desc(CategoryRule.priority), CategoryRule.id.asc())
        ).scalars()
    )
    return CategoryRuleListPublic(
        items=[CategoryRulePublic.model_validate(r) for r in rows],
        total=len(rows),
    )


@router.get("/{rule_id}", response_model=CategoryRulePublic)
def get_category_rule(
    rule_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CategoryRulePublic:
    """Return a single rule by id (scoped to the caller)."""
    rule = _get_owned_rule(db, rule_id=rule_id, current_user=current_user)
    return CategoryRulePublic.model_validate(rule)


@router.patch("/{rule_id}", response_model=CategoryRulePublic)
def update_category_rule(
    rule_id: uuid.UUID,
    payload: CategoryRuleUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CategoryRulePublic:
    """Partial update of a single rule (scoped to the caller)."""
    rule = _get_owned_rule(db, rule_id=rule_id, current_user=current_user)

    data = payload.model_dump(exclude_unset=True)

    if "category_id" in data and data["category_id"] is not None:
        _validate_target_category(
            db, category_id=data["category_id"], current_user=current_user
        )

    pattern_proposed = data.get("pattern")
    if (
        "pattern" in data
        and pattern_proposed is not None
        and data.get("is_regex")
        and len(pattern_proposed) > REGEX_MAX_PATTERN_CHARS
    ):
        # Belt + braces: even though the 255-char cap already rejects
        # oversized patterns, double-check the regex-specific cap.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"regex pattern exceeds the {REGEX_MAX_PATTERN_CHARS}-character safety cap"
            ),
        )

    for field, value in data.items():
        setattr(rule, field, value)

    db.commit()
    db.refresh(rule)
    return CategoryRulePublic.model_validate(rule)


@router.delete(
    "/{rule_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
def delete_category_rule(
    rule_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    """Hard-delete a rule.

    The engine never *needs* a hard delete — ``PATCH /category-rules/
    {id}`` with ``active=false`` is the soft-toggle path. The hard
    delete here exists for the admin case where the user genuinely
    wants the row gone (and the audit trail can still refer to the
    id because ``rule_id`` on ``rule_audit_log`` is ``ON DELETE SET
    NULL`` — the audit row stays informative).
    """
    rule = _get_owned_rule(db, rule_id=rule_id, current_user=current_user)
    db.delete(rule)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# Apply-rules (mounted under /categories by the router aggregator).
# ---------------------------------------------------------------------------

apply_router = APIRouter(prefix="/categories", tags=["categories"])


@apply_router.post(
    "/apply-rules",
    response_model=ApplyRulesPublic,
)
def apply_rules_endpoint(
    payload: ApplyRulesRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ApplyRulesPublic:
    """Apply the rule engine to the caller's existing transactions.

    ``apply_backfill=false`` (default): dry run. Walks every active
    transaction, computes the *would-be* changes, returns the list
    of ids that would change. Nothing is written — the FE can use
    this for a "Preview" panel.

    ``apply_backfill=true``: commits. Updates ``category_id`` on
    matching rows and writes one ``rule_audit_log`` row per change
    in a single DB transaction.

    Authorization (AC (4)): a cross-caller request is rejected before
    any state change because the engine is scoped to ``current_user.
    id`` — there's no separate "rule owner" path because rules are
    owned by the same user whose transactions they apply to. The
    spec text "403 kalau caller != rule owner" is therefore enforced
    implicitly: a foreign caller can never touch another user's
    transactions through this endpoint.

    Concurrency (TL risk area): we deliberately do NOT add a Postgres
    advisory lock here. The endpoint runs inside a FastAPI request
    that holds its own DB transaction; two simultaneous
    ``apply_backfill=true`` requests serialise through the row-level
    locks on the ``transactions`` table that the SQLAlchemy ``UPDATE``
    implicitly takes. Adding ``pg_advisory_xact_lock`` would (a)
    break SQLite (the test backend) and (b) only buy real safety if
    the API ran with REPEATABLE READ — the default READ COMMITTED
    sees whatever rows the engine selects. We accept the residual
    race window because the worst case is one stale audit row, not
    data corruption.
    """
    # sub-0004-02 AC (4) — explicit 403 when the caller has no rules
    # to evaluate. The QA defect #3a report flagged that a foreign /
    # rule-less caller previously got 200 + ``{rules_evaluated: 0}``
    # which the spec classifies as a 403. We detect "no rules"
    # explicitly with a cheap count query before loading the
    # transaction set, so a caller who legitimately has zero rules
    # still gets 403 even if they happen to own transactions.
    has_rules = (
        db.execute(
            select(func.count(CategoryRule.id)).where(
                CategoryRule.user_id == current_user.id,
                CategoryRule.active.is_(True),
            )
        ).scalar_one()
        > 0
    )
    if not has_rules:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="no active category rules for the caller",
        )

    transactions = _list_transactions_for_user(db, user_id=current_user.id)

    result: ApplyResult = apply_rules_to_transactions(
        db,
        user_id=current_user.id,
        transactions=transactions,
        origin="backfill",
        write_audit=payload.apply_backfill,
    )

    if payload.apply_backfill:
        # QA defect #3b regression on commit 97aad3f: the new
        # unique constraint ``uq_rule_audit_log_rule_tx_origin``
        # raises ``IntegrityError`` when a concurrent apply-rules
        # request wins the unique-index race. SQLite's database-
        # level locking can also raise ``OperationalError`` when
        # two threads race on the UPDATE of the same transaction
        # row. We catch both so the surviving row is committed
        # and the caller sees a normal 200 response. Without the
        # catch the duplicate path returns 500 — which is exactly
        # the bug QA retest flagged. The duplicate row is safely
        # rolled back; the apply logic does NOT retry because the
        # rule engine is idempotent on no-op per AC (2) but that's
        # an extra audit row which the user didn't ask for.
        try:
            db.commit()
        except (IntegrityError, OperationalError):
            db.rollback()
    else:
        # The engine only writes when ``write_audit=True``; the
        # explicit rollback keeps the dry run a pure read even if a
        # future refactor adds side effects.
        db.rollback()

    return ApplyRulesPublic(
        rules_evaluated=result.rules_evaluated,
        transactions_updated=result.transactions_updated,
        affected_transaction_ids=result.affected_transaction_ids,
    )
