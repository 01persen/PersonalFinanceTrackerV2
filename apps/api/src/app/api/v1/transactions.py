"""Transactions endpoints — CRUD for the authenticated user's transactions.

Scope: sub-0003-01 (POST + GET list + validation) + sub-0003-02 (PATCH +
DELETE soft delete). The paired ``transfer`` flow lives in sub-0003-03 and
the monthly aggregator in sub-0003-04.

Conventions follow :mod:`app.api.v1.accounts` (per-router ``get_db``
re-export, ``HTTPBearer`` via ``get_current_user``, auth-scoped queries
that never read across users, 404 instead of 403 for ``not yours``
payloads).

Validation rules (sub-0003-01, AC (b)):

* ``amount_cents > 0`` — Pydantic ``Field(gt=0)`` → 422.
* ``currency == "IDR"`` — model validator → 422.
* ``account_id`` belongs to the caller — 404 if not.
* ``category_id`` (optional) belongs to the caller AND its ``kind`` matches
  the transaction ``type`` — 404 for ownership, 422 for kind mismatch.

Soft delete (sub-0003-02, AC (a)-(c)):

* ``PATCH /transactions/{id}`` is partial — only the fields present in the
  body are touched. Cross-user rows return 404 (same as create). ``type``
  and ``user_id`` are immutable through the API.
* ``DELETE /transactions/{id}`` sets ``deleted_at`` to the current UTC
  timestamp. The row stays in the table (audit trail) and the list endpoint
  filters it out via ``deleted_at IS NULL``. A second DELETE on the same
  row is idempotent (resets the timestamp; still 204, row still hidden).
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
    TransactionCreate,
    TransactionListPublic,
    TransactionPublic,
    TransactionUpdate,
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


def _get_owned_transaction(
    db: Session,
    *,
    transaction_id: uuid.UUID,
    current_user: User,
) -> Transaction:
    """Load a transaction and assert it belongs to the caller.

    Soft-deleted rows are surfaced as 404 (same as "not yours") so the FE
    can't observe a deleted row through a stale id and PATCH/DELETE on a
    tombstoned row returns the same code as PATCH/DELETE on a foreign id.
    """
    transaction = db.get(Transaction, transaction_id)
    if transaction is None or transaction.user_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="transaction not found",
        )
    if transaction.deleted_at is not None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="transaction not found",
        )
    return transaction


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

    Returns 201 with the persisted row. ``deleted_at`` defaults to NULL so
    the row is immediately visible to GET /transactions.
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
        deleted_at=None,
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

    Soft-deleted rows (``deleted_at IS NOT NULL``) are excluded (AC (b)).
    The list and the ``total`` count use the same predicate so pagination
    stays consistent.

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

    base_where = [
        Transaction.user_id == current_user.id,
        Transaction.deleted_at.is_(None),
    ]
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


@router.patch("/{transaction_id}", response_model=TransactionPublic)
def update_transaction(
    transaction_id: uuid.UUID,
    payload: TransactionUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TransactionPublic:
    """Partial update of a single transaction (scoped to the caller).

    Only the fields present in the request body are touched. ``type``,
    ``user_id``, ``transfer_pair_id``, ``recurring_rule_id`` and
    ``deleted_at`` are server-controlled and never editable through this
    endpoint (silently ignored if a client sends them — the request only
    declares the editable subset on the schema). Cross-user rows return
    404 (same as the create / list endpoints), and PATCH on a soft-deleted
    row also returns 404 so a stale id from the client never resurrects a
    tombstoned row.

    Validation mirrors POST: ``amount_cents > 0`` (Pydantic), ``currency ==
    "IDR"`` (model validator), ``account_id`` ownership (404), and
    ``category_id`` ownership + kind match (404 / 422).
    """
    transaction = _get_owned_transaction(
        db, transaction_id=transaction_id, current_user=current_user
    )

    data = payload.model_dump(exclude_unset=True)

    if "account_id" in data:
        _get_owned_account(db, account_id=data["account_id"], current_user=current_user)

    if "category_id" in data and data["category_id"] is not None:
        _validate_category(
            db,
            category_id=data["category_id"],
            current_user=current_user,
            type_=transaction.type,
        )

    for field, value in data.items():
        setattr(transaction, field, value)

    db.commit()
    db.refresh(transaction)
    return TransactionPublic.model_validate(transaction)


@router.delete(
    "/{transaction_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
def delete_transaction(
    transaction_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    """Soft-delete a transaction by setting ``deleted_at``.

    The row stays in the table (audit trail) and is filtered out of
    GET /transactions by the ``deleted_at IS NULL`` predicate (AC (b)).
    The timestamp is recorded server-side (``datetime.now(UTC)``) so all
    clients see the same audit value regardless of clock skew.

    Calling DELETE on a soft-deleted row is a no-op (idempotent) — the
    row is already hidden from the list endpoint and the final 204 makes
    the retry safe to issue without state-checking first.
    """
    transaction = db.get(Transaction, transaction_id)
    if transaction is None or transaction.user_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="transaction not found",
        )
    if transaction.deleted_at is None:
        transaction.deleted_at = datetime.now(UTC)
        db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
