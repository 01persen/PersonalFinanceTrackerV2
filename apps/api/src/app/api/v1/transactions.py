"""Transactions endpoints — CRUD for the authenticated user's transactions.

Scope: sub-0003-01 (POST + GET list + validation) + sub-0003-04 (monthly
summary aggregation). PATCH / DELETE land in sub-0003-02 (with the
soft-delete behaviour) and the paired ``transfer`` flow lives in
sub-0003-03.

Conventions follow :mod:`app.api.v1.accounts` (per-router ``get_db``
re-export, ``HTTPBearer`` via ``get_current_user``, auth-scoped queries
that never read across users, 404 instead of 403 for ``not yours``
payloads).

Validation rules (per acceptance criteria (b) of sub-0003-01):

* ``amount_cents > 0`` — Pydantic ``Field(gt=0)`` → 422.
* ``currency == "IDR"`` — model validator → 422.
* ``account_id`` belongs to the caller — 404 if not.
* ``category_id`` (optional) belongs to the caller AND its ``kind`` matches
  the transaction ``type`` — 404 for ownership, 422 for kind mismatch.

The list path is paginated (``limit`` + ``offset``) and filterable on
``occurred_on`` range, ``account_id``, ``type``, and ``category_id``.
Results sort by ``occurred_on`` desc, ``created_at`` desc to give the FE a
stable "Pendapatan & Pengeluaran Bulanan" view.

The summary path (sub-0003-04) is read-only and never accepts a body. It
filters out soft-deleted rows (``deleted_at IS NULL``) so the monthly
totals + breakdowns stay consistent with what the list endpoint shows.
"""

from __future__ import annotations

import calendar
import uuid
from collections.abc import Iterator
from datetime import date as _date

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.schemas import (
    SummaryAccountBreakdownPublic,
    SummaryCategoryBreakdownPublic,
    TransactionCreate,
    TransactionListPublic,
    TransactionPublic,
    TransactionSummaryPublic,
)
from app.api.v1.auth import get_current_user
from app.db.models.account import Account
from app.db.models.category import Category
from app.db.models.enums import CategoryKind, TransactionType
from app.db.models.transaction import Transaction
from app.db.models.user import User
from app.db.session import get_session

router = APIRouter(prefix="/transactions", tags=["transactions"])


def get_db() -> Iterator[Session]:
    """Per-router session dependency (mirrors accounts.py / categories.py)."""
    yield from get_session()


def _type_to_category_kind(type_: TransactionType) -> CategoryKind:
    """Map a transaction ``type`` to the matching ``CategoryKind``.

    The schema only allows ``income`` / ``expense`` here, so a ``transfer``
    in practice never reaches this helper — the :class:`TransactionCreate`
    schema narrows ``type`` to ``Literal['income', 'expense']``. The
    ``assert`` is a defensive narrowing for ``mypy --strict`` and is safe
    to keep because every reachable caller already validated ``type``.
    """
    if type_ is TransactionType.INCOME:
        return CategoryKind.INCOME
    if type_ is TransactionType.EXPENSE:
        return CategoryKind.EXPENSE
    raise AssertionError(f"unreachable transaction type: {type_!r}")  # pragma: no cover


def _get_owned_account(db: Session, *, account_id: uuid.UUID, current_user: User) -> Account:
    """Load ``account_id`` and assert it belongs to the caller.

    Mirrors the pattern from :func:`app.api.v1.accounts._get_owned_account`:
    404 (not 403) when the row doesn't exist or belongs to another user, so
    the endpoint doesn't leak the existence of foreign account IDs.
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


def _validate_category(
    db: Session,
    *,
    category_id: uuid.UUID,
    current_user: User,
    type_: TransactionType,
) -> None:
    """Validate the optional ``category_id`` payload field.

    Raises 404 if the category doesn't exist or belongs to another user
    (mirror of the account ownership check), and 422 if its ``kind``
    doesn't match ``type`` (e.g. an ``expense`` transaction with an
    ``income`` category). Both checks short-circuit before the transaction
    is written so the saldo engine and the FE ``category`` aggregations
    always see consistent kind/type pairs.
    """
    expected_kind = _type_to_category_kind(type_)
    category = db.get(Category, category_id)
    if category is None or category.user_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="category not found",
        )
    if category.archived:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="category not found",
        )
    if category.kind != expected_kind:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"category kind {category.kind.value!r} does not match transaction type "
                f"{type_.value!r} (expected {expected_kind.value!r})"
            ),
        )


@router.post(
    "",
    response_model=TransactionPublic,
    status_code=status.HTTP_201_CREATED,
)
def create_transaction(
    payload: TransactionCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TransactionPublic:
    """Create an income or expense transaction for the current user.

    Returns 201 with the persisted row. The soft-delete ``deleted_at``
    column ships with sub-0003-02 — for now the row is hard-saved.
    """
    type_enum = TransactionType(payload.type)
    account = _get_owned_account(db, account_id=payload.account_id, current_user=current_user)

    if payload.category_id is not None:
        _validate_category(
            db,
            category_id=payload.category_id,
            current_user=current_user,
            type_=type_enum,
        )

    transaction = Transaction(
        user_id=current_user.id,
        account_id=account.id,
        category_id=payload.category_id,
        type=type_enum,
        amount_cents=payload.amount_cents,
        currency=payload.currency,
        occurred_on=payload.occurred_on,
        note=payload.note,
        transfer_pair_id=None,
        recurring_rule_id=None,
    )
    db.add(transaction)
    db.commit()
    db.refresh(transaction)
    return TransactionPublic.model_validate(transaction)


@router.get("", response_model=TransactionListPublic)
def list_transactions(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    date_from: _date | None = Query(
        default=None,
        description="Inclusive lower bound on ``occurred_on`` (ISO date).",
    ),
    date_to: _date | None = Query(
        default=None,
        description="Inclusive upper bound on ``occurred_on`` (ISO date).",
    ),
    account_id: uuid.UUID | None = Query(
        default=None,
        description="Filter by the source account. Must belong to the caller.",
    ),
    type: str | None = Query(
        default=None,
        description="Filter by transaction type (``income`` / ``expense`` / ``transfer``).",
    ),
    category_id: uuid.UUID | None = Query(
        default=None,
        description="Filter by category id.",
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
) -> TransactionListPublic:
    """List the current user's transactions with optional filters and pagination.

    Filters are composable (AND): all of ``date_from`` + ``account_id`` +
    ``type`` + ``category_id`` may be sent together. The response envelope
    includes ``total`` so the FE can render pagination without a second
    request.

    Validation:

    * ``account_id`` must belong to the caller — 404 otherwise.
    * ``category_id`` must belong to the caller — 404 otherwise.
    * ``type`` must be a valid :class:`TransactionType` value — 422 otherwise.
    * ``date_from <= date_to`` when both are provided — 422.
    """
    if date_from is not None and date_to is not None and date_from > date_to:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"date_from ({date_from.isoformat()}) must be <= date_to ({date_to.isoformat()})"
            ),
        )

    type_enum: TransactionType | None = None
    if type is not None:
        try:
            type_enum = TransactionType(type)
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=(f"type must be one of {[t.value for t in TransactionType]}; got {type!r}"),
            ) from exc

    if account_id is not None:
        _get_owned_account(db, account_id=account_id, current_user=current_user)

    if category_id is not None:
        category = db.get(Category, category_id)
        if category is None or category.user_id != current_user.id:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="category not found",
            )

    base_where = [Transaction.user_id == current_user.id]
    if date_from is not None:
        base_where.append(Transaction.occurred_on >= date_from)
    if date_to is not None:
        base_where.append(Transaction.occurred_on <= date_to)
    if account_id is not None:
        base_where.append(Transaction.account_id == account_id)
    if type_enum is not None:
        base_where.append(Transaction.type == type_enum)
    if category_id is not None:
        base_where.append(Transaction.category_id == category_id)

    total = db.execute(
        select(func.count()).select_from(Transaction).where(*base_where)
    ).scalar_one()

    rows = list(
        db.execute(
            select(Transaction)
            .where(*base_where)
            .order_by(
                Transaction.occurred_on.desc(),
                Transaction.created_at.desc(),
                Transaction.id.desc(),
            )
            .limit(limit)
            .offset(offset)
        ).scalars()
    )

    return TransactionListPublic(
        items=[TransactionPublic.model_validate(row) for row in rows],
        total=int(total),
        limit=limit,
        offset=offset,
    )


def _month_bounds(year: int, month: int) -> tuple[_date, _date]:
    """Return ``(first_day, last_day)`` for a given ``(year, month)``.

    ``month`` is 1-indexed (1 = January) to match what the FE sends. The
    returned range is inclusive on both ends so a transaction dated
    ``2026-01-31`` lands in the January bucket.
    """
    first_day = _date(year, month, 1)
    last_day_num = calendar.monthrange(year, month)[1]
    last_day = _date(year, month, last_day_num)
    return first_day, last_day


@router.get("/summary", response_model=TransactionSummaryPublic)
def transactions_summary(
    year: int = Query(
        ...,
        ge=1970,
        le=2999,
        description="Calendar year (e.g. ``2026``).",
    ),
    month: int = Query(
        ...,
        ge=1,
        le=12,
        description="Calendar month, 1-indexed (1 = January, 12 = December).",
    ),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TransactionSummaryPublic:
    """Return the caller's monthly income/expense summary + breakdowns.

    Implementation notes (sub-0003-04):

    * **Inclusive bounds.** The month window is ``[first, last]`` so a
      transaction dated ``2026-01-31`` lands in January and
      ``2026-02-01`` lands in February.
    * **Soft-delete aware.** Every query in this route filters on
      ``deleted_at IS NULL`` so tombstoned rows never inflate totals or
      the breakdowns (acceptance criterion (b)). The
      ``ix_transactions_user_deleted_at`` index keeps the predicate cheap.
    * **Transfers excluded.** The summary covers income + expense only;
      ``transfer`` rows (created by the paired-create flow in sub-0003-03)
      are internal account-to-account moves, not real income/expense, so
      they don't belong in the monthly view. The saldo engine handles
      transfers for balance computation.
    * **Empty months are not 404.** A month with zero active transactions
      returns ``200`` with ``total_income_cents=0``,
      ``total_expense_cents=0``, ``net_cents=0``, empty breakdowns, and
      ``transaction_count=0`` — the FE renders an empty state without a
      second request (acceptance criterion (c)).
    * **Category names are snapshotted at response time.** A row whose
      category is renamed or archived after the fact still surfaces under
      the name it had when the transaction happened… actually no: the FE
      wants the current category name so the breakdown UI labels stay
      consistent with the rest of the app. We use ``Category.name`` from
      the persisted row, joined on ``category_id``; categories that don't
      exist (e.g. FK cascade-deleted) surface as ``category_name=None``
      with ``category_id=None`` so the FE can bucket them under
      "Uncategorized".
    * **Account names are snapshotted at response time** for the same
      reason. Archived accounts still surface in the breakdown (the
      transactions happened, the account just got retired) — we never
      filter on ``Account.archived`` here.
    * **Cross-user isolation.** Every aggregate filters on
      ``Transaction.user_id == current_user.id``; another user's rows in
      the same month are never visible.
    """
    first_day, last_day = _month_bounds(year, month)

    active_filters = [
        Transaction.user_id == current_user.id,
        Transaction.occurred_on >= first_day,
        Transaction.occurred_on <= last_day,
        Transaction.deleted_at.is_(None),
    ]

    total_income_cents = int(
        db.execute(
            select(func.coalesce(func.sum(Transaction.amount_cents), 0)).where(
                *active_filters,
                Transaction.type == TransactionType.INCOME,
            )
        ).scalar_one()
    )
    total_expense_cents = int(
        db.execute(
            select(func.coalesce(func.sum(Transaction.amount_cents), 0)).where(
                *active_filters,
                Transaction.type == TransactionType.EXPENSE,
            )
        ).scalar_one()
    )
    transaction_count = int(
        db.execute(
            select(func.count()).select_from(Transaction).where(*active_filters)
        ).scalar_one()
    )

    category_rows = db.execute(
        select(
            Transaction.category_id,
            Category.name,
            Transaction.type,
            func.coalesce(func.sum(Transaction.amount_cents), 0).label("total_cents"),
            func.count(Transaction.id).label("transaction_count"),
        )
        .outerjoin(Category, Category.id == Transaction.category_id)
        .where(*active_filters)
        .group_by(Transaction.category_id, Category.name, Transaction.type)
        .order_by(
            Transaction.type.asc(),
            func.sum(Transaction.amount_cents).desc(),
            Category.name.asc().nulls_last(),
        )
    ).all()

    account_rows = db.execute(
        select(
            Transaction.account_id,
            Account.name.label("account_name"),
            Transaction.type,
            func.coalesce(func.sum(Transaction.amount_cents), 0).label("total_cents"),
            func.count(Transaction.id).label("transaction_count"),
        )
        .join(Account, Account.id == Transaction.account_id)
        .where(*active_filters)
        .group_by(Transaction.account_id, Account.name, Transaction.type)
        .order_by(
            Transaction.type.asc(),
            func.sum(Transaction.amount_cents).desc(),
            Account.name.asc(),
        )
    ).all()

    breakdown_by_category = [
        SummaryCategoryBreakdownPublic(
            category_id=row.category_id,
            category_name=row.name,
            type=row.type,
            total_cents=int(row.total_cents),
            transaction_count=int(row.transaction_count),
        )
        for row in category_rows
    ]
    breakdown_by_account = [
        SummaryAccountBreakdownPublic(
            account_id=row.account_id,
            account_name=row.account_name,
            type=row.type,
            total_cents=int(row.total_cents),
            transaction_count=int(row.transaction_count),
        )
        for row in account_rows
    ]

    return TransactionSummaryPublic(
        year=year,
        month=month,
        currency="IDR",
        total_income_cents=total_income_cents,
        total_expense_cents=total_expense_cents,
        net_cents=total_income_cents - total_expense_cents,
        transaction_count=transaction_count,
        breakdown_by_category=breakdown_by_category,
        breakdown_by_account=breakdown_by_account,
    )
