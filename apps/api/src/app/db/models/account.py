"""Account table."""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import BigInteger, Boolean, Enum, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.db.models.enums import AccountType
from app.db.models.mixins import TimestampMixin, UserFKMixin, UUIDPKMixin

if TYPE_CHECKING:
    from app.db.models.goal import Goal
    from app.db.models.transaction import Transaction
    from app.db.models.user import User


class Account(Base, UUIDPKMixin, UserFKMixin, TimestampMixin):
    __tablename__ = "accounts"

    name: Mapped[str] = mapped_column(String(120), nullable=False)
    type: Mapped[AccountType] = mapped_column(
        Enum(AccountType, name="account_type", native_enum=False, length=32),
        nullable=False,
    )
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    opening_balance_cents: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    is_asset: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    archived: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    user: Mapped[User] = relationship(back_populates="accounts")
    transactions: Mapped[list[Transaction]] = relationship(
        back_populates="account", cascade="all, delete-orphan"
    )
    goals: Mapped[list[Goal]] = relationship(back_populates="linked_account")
