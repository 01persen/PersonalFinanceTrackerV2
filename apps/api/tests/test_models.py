"""ORM-level smoke tests — run against an in-memory SQLite DB.

Verifies that:
  * All expected models import and register on ``Base.metadata``.
  * Relationships wire up without ``ConfigurationError``.
  * Round-tripping a ``User`` with a couple of child rows works end-to-end.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from app.db.base import Base
from app.db.models import (
    Account,
    AccountType,
    Category,
    CategoryKind,
    CategoryRule,
    Debt,
    DebtKind,
    DebtPayment,
    DebtStatus,
    Goal,
    GoalKind,
    Transaction,
    TransactionType,
    User,
)

EXPECTED_TABLES = {
    "users",
    "accounts",
    "categories",
    "transactions",
    "category_rules",
    "goals",
    "debts",
    "debt_payments",
    "user_preferences",
}


@pytest.fixture()
def in_memory_engine():
    engine = create_engine(
        "sqlite://",
        future=True,
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(engine, "connect")
    def _fk_on(dbapi_conn, _):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

    Base.metadata.create_all(engine)
    yield engine
    Base.metadata.drop_all(engine)
    engine.dispose()


@pytest.fixture()
def session(in_memory_engine) -> Session:
    return sessionmaker(bind=in_memory_engine, expire_on_commit=False)()


def test_all_models_register() -> None:
    assert EXPECTED_TABLES.issubset(set(Base.metadata.tables))


def test_user_can_be_persisted(session: Session) -> None:
    user = User(email="alice@example.com", password_hash="x")
    session.add(user)
    session.commit()

    fetched = session.get(User, user.id)
    assert fetched is not None
    assert fetched.email == "alice@example.com"


def test_full_graph_roundtrip(session: Session) -> None:
    user = User(email="bob@example.com", password_hash="h")
    session.add(user)
    session.flush()

    account = Account(
        user_id=user.id,
        name="BCA",
        type=AccountType.BANK,
        currency="IDR",
        opening_balance_cents=1_000_000,
    )
    session.add(account)
    session.flush()

    cat = Category(user_id=user.id, name="Groceries", kind=CategoryKind.EXPENSE)
    session.add(cat)
    session.flush()

    tx = Transaction(
        user_id=user.id,
        account_id=account.id,
        category_id=cat.id,
        type=TransactionType.EXPENSE,
        amount_cents=25_000,
        currency="IDR",
        occurred_on=__import__("datetime").date(2026, 7, 1),
    )
    session.add(tx)

    rule = CategoryRule(user_id=user.id, category_id=cat.id, pattern="^ALFAMART$", priority=10)
    session.add(rule)

    goal = Goal(
        user_id=user.id,
        kind=GoalKind.EMERGENCY_FUND,
        name="EF 3 bulan",
        target_amount_cents=9_000_000,
        start_date=__import__("datetime").date(2026, 7, 1),
        linked_account_id=account.id,
    )
    session.add(goal)

    debt = Debt(
        user_id=user.id,
        name="KPR",
        kind=DebtKind.KPR,
        principal_cents=120_000_000_00,
        bunga_pct=8.75,
        tenor_months=240,
        start_date=__import__("datetime").date(2024, 1, 1),
        status=DebtStatus.ACTIVE,
    )
    session.add(debt)
    session.flush()

    payment = DebtPayment(
        debt_id=debt.id,
        occurred_on=__import__("datetime").date(2026, 7, 10),
        amount_cents=1_200_000_00,
        principal_portion_cents=1_000_000_00,
        interest_portion_cents=200_000_00,
    )
    session.add(payment)

    session.commit()

    # Read back via relationship
    refreshed = session.get(User, user.id)
    assert refreshed is not None
    assert len(refreshed.accounts) == 1
    assert refreshed.accounts[0].name == "BCA"
    assert len(refreshed.transactions) == 1
    assert refreshed.transactions[0].amount_cents == 25_000
    assert len(refreshed.debts) == 1
    assert len(refreshed.debts[0].payments) == 1


def test_uuid_pk_is_generated(session: Session) -> None:
    user = User(email="cu@example.com", password_hash="x")
    session.add(user)
    session.commit()
    assert isinstance(user.id, uuid.UUID)
