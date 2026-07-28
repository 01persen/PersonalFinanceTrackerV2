"""Transaction table."""

from __future__ import annotations

from datetime import date, datetime
from typing import TYPE_CHECKING

from sqlalchemy import BigInteger, Date, DateTime, Enum, ForeignKey, Index, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.db.models.enums import TransactionType
from app.db.models.mixins import GUID, TimestampMixin, UserFKMixin, UUIDPKMixin

if TYPE_CHECKING:
    from app.db.models.account import Account
    from app.db.models.category import Category
    from app.db.models.user import User


class Transaction(Base, UUIDPKMixin, UserFKMixin, TimestampMixin):
    __tablename__ = "transactions"
    __table_args__ = (
        Index("ix_transactions_user_occurred_on", "user_id", "occurred_on"),
        Index("ix_transactions_account_occurred_on", "account_id", "occurred_on"),
        Index("ix_transactions_category", "category_id"),
        Index("ix_transactions_user_deleted_at", "user_id", "deleted_at"),
        Index("ix_transactions_transfer_group_id", "transfer_group_id"),
    )

    account_id: Mapped[str] = mapped_column(
        GUID(),
        ForeignKey("accounts.id", ondelete="CASCADE"),
        nullable=False,
    )
    category_id: Mapped[str | None] = mapped_column(
        GUID(),
        ForeignKey("categories.id", ondelete="SET NULL"),
        nullable=True,
    )
    type: Mapped[TransactionType] = mapped_column(
        Enum(TransactionType, name="transaction_type", native_enum=False, length=16),
        nullable=False,
    )
    amount_cents: Mapped[int] = mapped_column(BigInteger, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    occurred_on: Mapped[date] = mapped_column(Date, nullable=False)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    transfer_pair_id: Mapped[str | None] = mapped_column(GUID(), nullable=True)
    transfer_group_id: Mapped[str | None] = mapped_column(GUID(), nullable=True)
    recurring_rule_id: Mapped[str | None] = mapped_column(GUID(), nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
        default=None,
    )

    user: Mapped[User] = relationship(back_populates="transactions")
    account: Mapped[Account] = relationship(back_populates="transactions")
    category: Mapped[Category | None] = relationship(back_populates="transactions")
