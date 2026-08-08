"""User table."""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.db.models.mixins import TimestampMixin, UUIDPKMixin

if TYPE_CHECKING:
    from app.db.models.account import Account
    from app.db.models.category import Category
    from app.db.models.category_rule import CategoryRule
    from app.db.models.debt import Debt
    from app.db.models.goal import Goal
    from app.db.models.recurring_rule import RecurringRule
    from app.db.models.transaction import Transaction
    from app.db.models.user_preference import UserPreference


class User(Base, UUIDPKMixin, TimestampMixin):
    __tablename__ = "users"

    email: Mapped[str] = mapped_column(String(255), nullable=False, unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)

    accounts: Mapped[list[Account]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    categories: Mapped[list[Category]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    transactions: Mapped[list[Transaction]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    category_rules: Mapped[list[CategoryRule]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    goals: Mapped[list[Goal]] = relationship(back_populates="user", cascade="all, delete-orphan")
    debts: Mapped[list[Debt]] = relationship(back_populates="user", cascade="all, delete-orphan")
    recurring_rules: Mapped[list[RecurringRule]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    preferences: Mapped[UserPreference | None] = relationship(
        back_populates="user", cascade="all, delete-orphan", uselist=False
    )

    def __repr__(self) -> str:
        return f"User(id={self.id!r}, email={self.email!r})"
