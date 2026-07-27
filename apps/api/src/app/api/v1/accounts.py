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
from datetime import UTC, datetime

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
    as_of = datetime.now(UTC)
    balances = calculate_user_balances(db, user_id=current_user.id, as_of=as_of.date())
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

    as_of = datetime.now(UTC)
    balance = calculate_account_balance(
        db,
        user_id=current_user.id,
        account_id=account_id,
        as_of=as_of.date(),
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
    """
    account = _get_owned_account(db, account_id=account_id, current_user=current_user)

    data = payload.model_dump(exclude_unset=True)
    if "type" in data:
        account.is_asset = _is_asset(data["type"])
    for field, value in data.items():
        setattr(account, field, value)

    db.commit()
    db.refresh(account)
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
    return Response(status_code=status.HTTP_204_NO_CONTENT)
