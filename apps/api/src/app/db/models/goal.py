"""Goal table."""

from __future__ import annotations

from datetime import date
from typing import TYPE_CHECKING

from sqlalchemy import BigInteger, Date, Enum, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.db.models.enums import GoalKind
from app.db.models.mixins import GUID, TimestampMixin, UserFKMixin, UUIDPKMixin

if TYPE_CHECKING:
    from app.db.models.account import Account
    from app.db.models.user import User


class Goal(Base, UUIDPKMixin, UserFKMixin, TimestampMixin):
    __tablename__ = "goals"

    kind: Mapped[GoalKind] = mapped_column(
        Enum(GoalKind, name="goal_kind", native_enum=False, length=32),
        nullable=False,
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    target_amount_cents: Mapped[int] = mapped_column(BigInteger, nullable=False)
    target_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    account_id: Mapped[str | None] = mapped_column(
        GUID(),
        ForeignKey("accounts.id", ondelete="SET NULL"),
        nullable=True,
    )
    current_amount_cents: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)

    user: Mapped[User] = relationship(back_populates="goals")
    account: Mapped[Account | None] = relationship(back_populates="goals")
