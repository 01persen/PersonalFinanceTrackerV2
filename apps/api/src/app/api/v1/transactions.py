"""Transactions endpoints — CRUD for the authenticated user's transactions.

Scope: sub-0003-01 (POST + GET list + validation) + sub-0003-02 (PATCH +
DELETE soft delete) + sub-0003-04 (monthly summary aggregation) +
sub-0004-03 (search endpoint + index design). The paired ``transfer``
flow lives in sub-0003-03.

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
  timestamp. The row stays in the table and the list endpoint filters it out.

The paired ``POST /transactions/transfer`` endpoint (sub-0003-03) creates
two rows in a single DB transaction — an ``expense`` on the source account
and an ``income`` on the destination account — both linked by the same
``transfer_pair_id`` and ``transfer_group_id``. Either both rows land or
neither does; see :func:`create_transfer` for the atomicity contract.

The summary path is read-only, excludes soft-deleted rows and transfers, and
returns zeros plus empty arrays for empty months.

The list path is paginated (``limit`` + ``offset``) and filterable on
``occurred_on`` range, ``account_id``, ``type``, and ``category_id``.
Results sort by ``occurred_on`` desc, ``amount_cents`` desc, ``id`` asc —
a fully deterministic tie-breaker chain that does not depend on
``created_at`` (whose second-level precision on SQLite ties frequently,
forcing a random UUID tie-break). See sub-0004-00 carry-over for the
historical flake and sub-0004-03 for the same pattern in the search
endpoint.
"""

from __future__ import annotations

import calendar
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from datetime import date as _date

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.schemas import (
    SummaryAccountBreakdownPublic,
    SummaryCategoryBreakdownPublic,
    TransactionCreate,
    TransactionListPublic,
    TransactionPublic,
    TransactionSearchListPublic,
    TransactionSummaryPublic,
    TransactionUpdate,
    TransferCreate,
    TransferPublic,
)
from app.api.v1.auth import get_current_user
from app.db.models.account import Account
from app.db.models.category import Category
from app.db.models.enums import CategoryKind, TransactionType
from app.db.models.rule_audit_log import RuleAuditLog
from app.db.models.transaction import Transaction
from app.db.models.user import User
from app.db.session import get_session
from app.services.rule_engine import (
    resolve_category_for_transaction,
)

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
        transfer_group_id=None,
        recurring_rule_id=None,
        deleted_at=None,
    )
    db.add(transaction)
    db.flush()  # need ``transaction.id`` for the audit log row

    # sub-0004-02 AC (1) — auto-apply active category rules when the caller
    # didn't supply a category. ``note``-based match only; if no rule
    # matches (or the row has no note) the category stays ``None`` (AC (2)
    # "no-match preserve" — there's nothing to preserve, so this is a
    # no-op). Audit row written inside the engine, in the same transaction
    # as the parent insert so a failed commit drops both.
    if transaction.category_id is None:
        match = resolve_category_for_transaction(
            db, transaction=transaction, current_user_id=current_user.id
        )
        if match is not None:
            target = db.get(Category, match.category_id)
            if (
                target is not None
                and target.user_id == current_user.id
                and target.archived_at is None
                and target.kind == type_enum.value
            ):
                transaction.category_id = target.id
                db.add(
                    RuleAuditLog(
                        rule_id=match.rule_id,
                        transaction_id=transaction.id,
                        user_id=current_user.id,
                        prev_category_id=None,
                        new_category_id=target.id,
                        origin="live",
                    )
                )

    db.commit()
    db.refresh(transaction)
    return TransactionPublic.model_validate(transaction)


@router.post(
    "/transfer",
    response_model=TransferPublic,
    status_code=status.HTTP_201_CREATED,
)
def create_transfer(
    payload: TransferCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TransferPublic:
    """Create a paired transfer between two of the caller's accounts.

    Persists exactly two rows in a single DB transaction:

    * an ``expense`` transaction on ``source_account_id`` for
      ``amount_cents`` currency IDR on ``occurred_on``;
    * an ``income`` transaction on ``destination_account_id`` for the
      same ``amount_cents`` currency IDR on the same ``occurred_on``.

    Both rows share the same ``transfer_pair_id`` and ``transfer_group_id``
    (a single fresh UUID per call). The saldo engine's sign convention
    (``expense`` → ``-amount``, ``income`` → ``+amount``) does the
    bookkeeping: the source loses ``amount_cents`` and the destination
    gains ``amount_cents``, networth unchanged.

    Atomicity contract (AC (a)): the two inserts run inside one
    ``db.begin()`` block and the entire batch is committed in a single
    ``commit()`` call. If any check fails after the inserts begin — or
    the commit itself raises (constraint violation, transient DB error,
    etc.) — SQLAlchemy rollback discards both rows.

    Validation contract:

    * ``amount_cents > 0`` (Pydantic ``gt=0``) → 422.
    * ``currency == "IDR"`` (model validator) → 422.
    * ``source_account_id != destination_account_id`` (model validator)
      → 422.
    * Both accounts belong to the caller and are non-archived →
      404 for ownership/missing, 404 for archived (mirrors the
      accounts router).
    """
    source = _get_owned_account(db, account_id=payload.source_account_id, current_user=current_user)
    destination = _get_owned_account(
        db, account_id=payload.destination_account_id, current_user=current_user
    )

    pair_id = uuid.uuid4()
    note = payload.note

    source_tx = Transaction(
        user_id=current_user.id,
        account_id=source.id,
        category_id=None,
        type=TransactionType.EXPENSE,
        amount_cents=payload.amount_cents,
        currency=payload.currency,
        occurred_on=payload.occurred_on,
        note=note,
        transfer_pair_id=pair_id,
        transfer_group_id=pair_id,
        recurring_rule_id=None,
    )
    destination_tx = Transaction(
        user_id=current_user.id,
        account_id=destination.id,
        category_id=None,
        type=TransactionType.INCOME,
        amount_cents=payload.amount_cents,
        currency=payload.currency,
        occurred_on=payload.occurred_on,
        note=note,
        transfer_pair_id=pair_id,
        transfer_group_id=pair_id,
        recurring_rule_id=None,
    )

    db.add_all([source_tx, destination_tx])
    db.commit()
    db.refresh(source_tx)
    db.refresh(destination_tx)

    return TransferPublic(
        source=TransactionPublic.model_validate(source_tx),
        destination=TransactionPublic.model_validate(destination_tx),
        transfer_pair_id=pair_id,
        transfer_group_id=pair_id,
    )


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
                Transaction.amount_cents.desc(),
                Transaction.id.asc(),
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


_SEARCH_MAX_PAGE_SIZE = 200
_SEARCH_DEFAULT_PAGE_SIZE = 50


@router.get("/search", response_model=TransactionSearchListPublic)
def search_transactions(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    q: str | None = Query(
        default=None,
        max_length=200,
        description=(
            "Free-text substring match against ``note`` (case-insensitive). "
            "Empty / whitespace-only values disable the filter."
        ),
    ),
    type: str | None = Query(
        default=None,
        description="Filter by transaction type (``income`` / ``expense`` / ``transfer``).",
    ),
    account_id: uuid.UUID | None = Query(
        default=None,
        description="Filter by the source account. Must belong to the caller.",
    ),
    category_id: uuid.UUID | None = Query(
        default=None,
        description="Filter by category id.",
    ),
    date_from: _date | None = Query(
        default=None,
        description="Inclusive lower bound on ``occurred_on`` (ISO date).",
    ),
    date_to: _date | None = Query(
        default=None,
        description="Inclusive upper bound on ``occurred_on`` (ISO date).",
    ),
    amount_min_cents: int | None = Query(
        default=None,
        ge=0,
        description="Inclusive lower bound on ``amount_cents``.",
    ),
    amount_max_cents: int | None = Query(
        default=None,
        ge=0,
        description="Inclusive upper bound on ``amount_cents``.",
    ),
    page: int = Query(
        default=1,
        ge=1,
        description="1-indexed page number. Page 1 is the first page.",
    ),
    page_size: int = Query(
        default=_SEARCH_DEFAULT_PAGE_SIZE,
        ge=1,
        le=_SEARCH_MAX_PAGE_SIZE,
        description=(
            f"Page size. Default {_SEARCH_DEFAULT_PAGE_SIZE}, max {_SEARCH_MAX_PAGE_SIZE}."
        ),
    ),
) -> TransactionSearchListPublic:
    """Composite search over the caller's transactions (sub-0004-03).

    Filters are composable (AND): every query parameter may be sent
    together. ``q`` is a case-insensitive substring match against
    ``note`` (the only free-text field the FE surfaces); all other
    filters are exact-match / range.

    Acceptance criteria this endpoint satisfies:

    * **(1)** All eight filter parameters + ``page`` / ``page_size``
      pagination. ``page_size`` defaults to 50 and is hard-capped at
      200 (the FE never needs more in one round-trip — anything bigger
      is a UI bug, not a backend concern).
    * **(2)** Deterministic ordering — ``occurred_on DESC,
      amount_cents DESC, id ASC``. The same query returns the same
      rows in the same order every time; the ``id ASC`` tie-break is
      what kills the SQLite UUID-flake carried over from PR #22 (the
      same fix sub-0004-00 applied to the list endpoint).
    * **(3)** Soft-delete aware — ``deleted_at IS NULL`` is part of
      the predicate so tombstoned rows never appear in search
      results, mirroring the list endpoint (sub-0003-02).
    * **(4)** Perf budget — ``p95 < 500 ms @ 5.000 transaksi``. The
      benchmark script (``scripts/bench_transactions_search.py``)
      measures this end-to-end against a fresh DB; the
      index-design migration
      (``alembic/versions/b2c4d6e8f0a5_transactions_search_indexes.py``)
      is what makes the target achievable on PostgreSQL.

    Validation (mirrors :func:`list_transactions`):

    * ``account_id`` belongs to the caller → 404.
    * ``category_id`` belongs to the caller → 404.
    * ``type`` is a valid :class:`TransactionType` → 422.
    * ``date_from <= date_to`` when both present → 422.
    * ``amount_min_cents <= amount_max_cents`` when both present → 422.

    Cross-user isolation: every clause in ``_search_where`` includes
    ``Transaction.user_id == current_user.id`` so another user's
    transactions can never bleed into the response — even when
    ``account_id`` / ``category_id`` happen to be foreign ids (those
    are filtered out by the ownership check above, but the
    ``user_id`` predicate is the load-bearing isolation guarantee).
    """
    if date_from is not None and date_to is not None and date_from > date_to:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"date_from ({date_from.isoformat()}) must be <= date_to ({date_to.isoformat()})"
            ),
        )

    if (
        amount_min_cents is not None
        and amount_max_cents is not None
        and amount_min_cents > amount_max_cents
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"amount_min_cents ({amount_min_cents}) must be <= "
                f"amount_max_cents ({amount_max_cents})"
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

    # ``q`` normalisation — strip and treat empty / whitespace-only
    # values as "no filter" so a stray space from the FE search box
    # doesn't accidentally 0-out the result set. ``max_length=200``
    # in the ``Query`` definition already caps how much the user
    # can send, but we still trim before building the LIKE pattern.
    q_stripped = q.strip() if q is not None else ""
    if q_stripped == "":
        like_pattern: str | None = None
    else:
        # Escape SQL ``%`` / ``_`` so a search for "100% discount" doesn't
        # turn into a wildcard scan. ``ESCAPE '\\'`` is portable across
        # SQLite + PostgreSQL.
        like_pattern = (
            "%" + q_stripped.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        )

    where = [Transaction.user_id == current_user.id, Transaction.deleted_at.is_(None)]
    if date_from is not None:
        where.append(Transaction.occurred_on >= date_from)
    if date_to is not None:
        where.append(Transaction.occurred_on <= date_to)
    if account_id is not None:
        where.append(Transaction.account_id == account_id)
    if type_enum is not None:
        where.append(Transaction.type == type_enum)
    if category_id is not None:
        where.append(Transaction.category_id == category_id)
    if amount_min_cents is not None:
        where.append(Transaction.amount_cents >= amount_min_cents)
    if amount_max_cents is not None:
        where.append(Transaction.amount_cents <= amount_max_cents)
    if like_pattern is not None:
        # ``ilike`` translates to ``ILIKE`` on PostgreSQL (which can
        # use the ``pg_trgm`` GIN index on ``note``) and to
        # ``LIKE`` with the default SQLite case-insensitive ASCII
        # collation on the test backend. Either way the predicate
        # shape is identical.
        where.append(Transaction.note.ilike(like_pattern, escape="\\"))

    total = db.execute(select(func.count()).select_from(Transaction).where(*where)).scalar_one()

    offset = (page - 1) * page_size
    rows = list(
        db.execute(
            select(Transaction)
            .where(*where)
            .order_by(
                Transaction.occurred_on.desc(),
                Transaction.amount_cents.desc(),
                Transaction.id.asc(),
            )
            .limit(page_size)
            .offset(offset)
        ).scalars()
    )

    return TransactionSearchListPublic(
        items=[TransactionPublic.model_validate(row) for row in rows],
        total=int(total),
        page=page,
        page_size=page_size,
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

    # sub-0004-02 AC (1) — auto-apply rules when EITHER:
    #   (a) the caller sends an explicit ``category_id: null`` (clear
    #       the manual override, let the engine decide), OR
    #   (b) the caller edits a matching field (``note`` — the only
    #       free-text key the engine indexes) and leaves
    #       ``category_id`` untouched or sends ``null`` too.
    # An explicit non-null ``category_id`` is a manual override and
    # is preserved (no engine call). The engine's
    # ``resolve_category_for_transaction`` honours no-match preserve
    # (AC (2)) — if nothing matches the resulting note we leave the
    # cleared ``None`` alone.
    category_touched = "category_id" in data and data["category_id"] is None
    note_changed = "note" in data
    if category_touched or note_changed:
        prev_category_id = transaction.category_id
        match = resolve_category_for_transaction(
            db, transaction=transaction, current_user_id=current_user.id
        )
        if match is not None:
            target = db.get(Category, match.category_id)
            if (
                target is not None
                and target.user_id == current_user.id
                and target.archived_at is None
                and target.kind == transaction.type.value
                and prev_category_id != target.id
            ):
                transaction.category_id = target.id
                db.add(
                    RuleAuditLog(
                        rule_id=match.rule_id,
                        transaction_id=transaction.id,
                        user_id=current_user.id,
                        prev_category_id=prev_category_id,
                        new_category_id=target.id,
                        origin="live",
                    )
                )

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
