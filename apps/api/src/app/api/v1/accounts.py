"""Accounts endpoints — CRUD for the authenticated user's accounts.

Scope: sub-0002-01. The read-side aggregations (balances) land in sub-0002-02.

Conventions follow ``auth.py`` (per-router ``get_db`` re-export, ``HTTPBearer``
via the shared ``get_current_user``) and ``categories.py`` (auth-scoped
queries that never read across users).

TL decisions baked in here:

* G1 — ``is_asset`` is a Pydantic-derived field on ``AccountPublic``
  (``type`` is the single source of truth: ``credit_card`` is a liability,
  every other ``AccountType`` is an asset). The DB column exists for
  reporting but is never written by the API; ``AccountPublic.from_account``
  always recomputes the value on read.
* G4 — ``currency`` is strict-validated as ``"IDR"`` by the request schema
  (``AccountCreate`` / ``AccountUpdate``). Anything else surfaces as 422 from
  Pydantic before the route handler runs.
* D — ``DELETE`` is a soft delete: we flip ``archived = True`` so the row
  stays around for transaction-history integrity. Hard delete would orphan
  ``transactions.account_id`` and break the saldo engine.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from datetime import UTC, date, datetime

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.schemas import (
    AccountBalancePublic,
    AccountBalancesPublic,
    AccountCreate,
    AccountPublic,
    AccountUpdate,
)
from app.api.v1.auth import get_current_user
from app.db.models.account import Account
from app.db.models.enums import AccountType
from app.db.models.user import User
from app.db.session import get_session
from app.services import dashboard_cache
from app.services.balance import calculate_account_balance, calculate_user_balances

router = APIRouter(prefix="/accounts", tags=["accounts"])


def get_db() -> Iterator[Session]:
    """Per-router session dependency (mirrors auth.py / categories.py)."""
    yield from get_session()


def _is_asset(account_type: AccountType) -> bool:
    """TL decision G1: ``type`` is the source of truth for asset vs liability.

    Only ``credit_card`` is a liability in the MVP. Everything else
    (cash / bank / e_wallet / investment / other) is an asset.
    """
    return account_type != AccountType.CREDIT_CARD


def _get_owned_account(db: Session, *, account_id: uuid.UUID, current_user: User) -> Account:
    """Load an account and assert it belongs to the calling user.

    Raises 404 — not 403 — for both ``not found`` and ``not yours`` so the
    endpoint doesn't leak the existence of another user's account IDs.
    """
    account = db.get(Account, account_id)
    if account is None or account.user_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="account not found",
        )
    return account


@router.post(
    "",
    response_model=AccountPublic,
    status_code=status.HTTP_201_CREATED,
)
def create_account(
    payload: AccountCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AccountPublic:
    """Create a new account owned by the authenticated user.

    ``is_asset`` is derived from ``type`` server-side (G1) and written to the
    DB column for reporting parity, but the response shape is what the FE
    relies on — see ``AccountPublic.from_account``.
    """
    account = Account(
        user_id=current_user.id,
        name=payload.name,
        type=payload.type,
        currency=payload.currency,
        opening_balance_cents=payload.opening_balance_cents,
        is_asset=_is_asset(payload.type),
        archived=False,
    )
    db.add(account)
    db.commit()
    db.refresh(account)
    # sub-0007-01 -- invalidate the dashboard cache so the next
    # ``/dashboard/summary`` and ``/dashboard/networth-trend`` call
    # sees the new account's opening balance. The two endpoints are
    # the only dashboard reads that depend on the accounts aggregate.
    dashboard_cache.invalidate_for_table(user_id=current_user.id, table="accounts")
    return AccountPublic.from_account(account)


@router.get("", response_model=list[AccountPublic])
def list_accounts(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[AccountPublic]:
    """List the current user's accounts.

    Sorted with assets first, then liabilities, then by name inside each
    bucket — the FE uses this to render the account picker and networth
    card without a second pass. Archived rows are hidden by default; pass
    ``?include_archived=true`` (added in epic-0008 if needed) when you want
    to surface them.
    """
    accounts = list(
        db.execute(
            select(Account)
            .where(Account.user_id == current_user.id, Account.archived.is_(False))
            .order_by(Account.is_asset.desc(), Account.name)
        ).scalars()
    )
    return [AccountPublic.from_account(a) for a in accounts]


@router.get("/balances", response_model=AccountBalancesPublic)
def list_account_balances(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AccountBalancesPublic:
    # ``as_of`` defaults to the caller's local calendar date so the
    # JOIN predicate ``Transaction.occurred_on <= as_of`` includes the
    # user's transactions logged "today" in UTC+ (sub-0005-06 / QA
    # DEFECT-1). ``as_of`` returned to the client still carries the
    # UTC timestamp for unambiguous audit trail.
    as_of = datetime.now(UTC)
    as_of_date = date.today()
    balances = calculate_user_balances(db, user_id=current_user.id, as_of=as_of_date)
    return AccountBalancesPublic(
        accounts=[
            AccountBalancePublic(
                account_id=account.account_id,
                balance_cents=account.balance_cents,
                as_of=as_of,
            )
            for account in balances.accounts
        ],
        total_assets_cents=balances.total_assets_cents,
        total_liabilities_cents=balances.total_liabilities_cents,
        networth_cents=balances.networth_cents,
    )


@router.get("/{account_id}/balance", response_model=AccountBalancePublic)
def get_account_balance(
    account_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AccountBalancePublic:
    account = _get_owned_account(db, account_id=account_id, current_user=current_user)
    if account.archived:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="account not found",
        )

    # ``as_of`` defaults to the caller's local calendar date so the
    # JOIN predicate ``Transaction.occurred_on <= as_of`` includes the
    # user's transactions logged "today" in UTC+ (sub-0005-06 / QA
    # DEFECT-1). ``as_of`` returned to the client still carries the
    # UTC timestamp for unambiguous audit trail.
    as_of = datetime.now(UTC)
    as_of_date = date.today()
    balance = calculate_account_balance(
        db,
        user_id=current_user.id,
        account_id=account_id,
        as_of=as_of_date,
    )
    if balance is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="account not found",
        )
    return AccountBalancePublic(
        account_id=balance.account_id,
        balance_cents=balance.balance_cents,
        as_of=as_of,
    )


@router.get("/{account_id}", response_model=AccountPublic)
def get_account(
    account_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AccountPublic:
    """Return a single account by id (scoped to the caller)."""
    account = _get_owned_account(db, account_id=account_id, current_user=current_user)
    return AccountPublic.from_account(account)


@router.patch("/{account_id}", response_model=AccountPublic)
def update_account(
    account_id: uuid.UUID,
    payload: AccountUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AccountPublic:
    """Partial update of a single account (scoped to the caller).

    Only the fields present in the request body are touched. If ``type``
    changes, ``is_asset`` is recomputed and persisted so reporting rows
    stay in sync (G1 single source of truth: ``type``).

    The cross-field rule that ``opening_balance_cents`` may be negative only
    when the effective type is ``credit_card`` is enforced here against the
    merged effective values (request payload merged with persisted row). The
    request-only case is also covered by ``AccountUpdate._check_opening_balance_when_type_provided``;
    we still re-check here so a single-field PATCH that flips the type to
    a non-credit-card while the persisted balance is negative is rejected
    before any write hits the DB.
    """
    account = _get_owned_account(db, account_id=account_id, current_user=current_user)

    data = payload.model_dump(exclude_unset=True)

    effective_type: AccountType = data.get("type", account.type)
    effective_balance: int = data.get("opening_balance_cents", account.opening_balance_cents)
    if effective_balance < 0 and effective_type != AccountType.CREDIT_CARD:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                "opening_balance_cents may be negative only when type is 'credit_card' "
                f"(effective type={effective_type.value!r}, effective balance="
                f"{effective_balance})"
            ),
        )

    if "type" in data:
        account.is_asset = _is_asset(data["type"])
    for field, value in data.items():
        setattr(account, field, value)

    db.commit()
    db.refresh(account)
    # sub-0007-01 -- invalidate dashboard cache on type / balance / archive
    # changes so the next read sees the corrected networth.
    dashboard_cache.invalidate_for_table(user_id=current_user.id, table="accounts")
    return AccountPublic.from_account(account)


@router.delete(
    "/{account_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
def delete_account(
    account_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    """Soft-delete an account by setting ``archived = True``.

    We intentionally do NOT hard-delete: existing ``transactions.account_id``
    rows must keep pointing at a real account for the saldo engine and
    reporting to work. The saldo sub-issues (sub-0002-02) will treat
    ``archived`` accounts as excluded from active balances.
    """
    account = _get_owned_account(db, account_id=account_id, current_user=current_user)
    account.archived = True
    db.commit()
    # sub-0007-01 -- invalidating on archive hides the account from the
    # saldo engine's aggregate (the engine's ``archived.is_(False)``
    # filter is what powers that), so the networth read must refresh.
    dashboard_cache.invalidate_for_table(user_id=current_user.id, table="accounts")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
