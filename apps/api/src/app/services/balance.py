from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import date

from sqlalchemy import and_, case, func, select
from sqlalchemy.orm import Session

from app.db.models.account import Account
from app.db.models.enums import AccountType, TransactionType
from app.db.models.transaction import Transaction


@dataclass(frozen=True)
class AccountBalance:
    account_id: uuid.UUID
    balance_cents: int
    is_asset: bool


@dataclass(frozen=True)
class UserBalances:
    accounts: list[AccountBalance]
    total_assets_cents: int
    total_liabilities_cents: int
    networth_cents: int


def _calculate_balances(
    db: Session,
    *,
    user_id: uuid.UUID,
    as_of: date,
    account_id: uuid.UUID | None = None,
) -> list[AccountBalance]:
    transaction_delta = case(
        (Transaction.type == TransactionType.INCOME, Transaction.amount_cents),
        (Transaction.type == TransactionType.EXPENSE, -Transaction.amount_cents),
        (Transaction.type == TransactionType.TRANSFER, Transaction.amount_cents),
        else_=0,
    )
    summed_delta = func.coalesce(func.sum(transaction_delta), 0).label("transaction_delta_cents")
    statement = (
        select(
            Account.id.label("account_id"),
            Account.opening_balance_cents,
            Account.type.label("account_type"),
            summed_delta,
        )
        .outerjoin(
            Transaction,
            and_(
                Transaction.account_id == Account.id,
                Transaction.user_id == user_id,
                Transaction.occurred_on <= as_of,
                # sub-0005-02 -- exclude soft-deleted transactions from
                # the saldo aggregate. Mirrors the ``deleted_at IS NULL``
                # predicate the list / search / summary endpoints
                # already use (epic-0003 AC (b)). Without this filter,
                # a soft-deleted expense would still count as a debit
                # and the linked goal's progress would never refresh.
                Transaction.deleted_at.is_(None),
            ),
        )
        .where(Account.user_id == user_id, Account.archived.is_(False))
        .group_by(
            Account.id,
            Account.opening_balance_cents,
            Account.type,
            Account.is_asset,
            Account.name,
        )
        .order_by(Account.is_asset.desc(), Account.name)
    )
    if account_id is not None:
        statement = statement.where(Account.id == account_id)

    return [
        AccountBalance(
            account_id=row.account_id,
            balance_cents=int(row.opening_balance_cents) + int(row.transaction_delta_cents),
            is_asset=row.account_type != AccountType.CREDIT_CARD,
        )
        for row in db.execute(statement)
    ]


def calculate_account_balance(
    db: Session,
    *,
    user_id: uuid.UUID,
    account_id: uuid.UUID,
    as_of: date,
) -> AccountBalance | None:
    balances = _calculate_balances(
        db,
        user_id=user_id,
        account_id=account_id,
        as_of=as_of,
    )
    return balances[0] if balances else None


def calculate_user_balances(
    db: Session,
    *,
    user_id: uuid.UUID,
    as_of: date,
) -> UserBalances:
    accounts = _calculate_balances(db, user_id=user_id, as_of=as_of)
    total_assets_cents = sum(account.balance_cents for account in accounts if account.is_asset)
    total_liabilities_cents = sum(
        account.balance_cents for account in accounts if not account.is_asset
    )
    return UserBalances(
        accounts=accounts,
        total_assets_cents=total_assets_cents,
        total_liabilities_cents=total_liabilities_cents,
        networth_cents=total_assets_cents - total_liabilities_cents,
    )
