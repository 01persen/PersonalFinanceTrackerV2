"""Debt + DebtPayment tables."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import TYPE_CHECKING

from sqlalchemy import BigInteger, Date, Enum, ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.db.models.enums import DebtKind, DebtStatus
from app.db.models.mixins import GUID, TimestampMixin, UserFKMixin, UUIDPKMixin

if TYPE_CHECKING:
    from app.db.models.user import User


class Debt(Base, UUIDPKMixin, UserFKMixin, TimestampMixin):
    __tablename__ = "debts"

    name: Mapped[str] = mapped_column(String(120), nullable=False)
    kind: Mapped[DebtKind] = mapped_column(
        Enum(DebtKind, name="debt_kind", native_enum=False, length=32),
        nullable=False,
    )
    principal_cents: Mapped[int] = mapped_column(BigInteger, nullable=False)
    bunga_pct: Mapped[Decimal] = mapped_column(Numeric(7, 4), nullable=False, default=Decimal("0"))
    tenor_months: Mapped[int | None] = mapped_column(Integer, nullable=True)
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    monthly_payment_cents: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[DebtStatus] = mapped_column(
        Enum(DebtStatus, name="debt_status", native_enum=False, length=16),
        nullable=False,
        default=DebtStatus.ACTIVE,
    )

    user: Mapped[User] = relationship(back_populates="debts")
    payments: Mapped[list[DebtPayment]] = relationship(
        back_populates="debt", cascade="all, delete-orphan"
    )


class DebtPayment(Base, UUIDPKMixin, TimestampMixin):
    __tablename__ = "debt_payments"

    debt_id: Mapped[str] = mapped_column(
        GUID(),
        ForeignKey("debts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    occurred_on: Mapped[date] = mapped_column(Date, nullable=False)
    amount_cents: Mapped[int] = mapped_column(BigInteger, nullable=False)
    principal_portion_cents: Mapped[int] = mapped_column(BigInteger, nullable=False)
    interest_portion_cents: Mapped[int] = mapped_column(BigInteger, nullable=False)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    # sub-0006-02 — optional FK to the account that funded the payment.
    # ``ON DELETE SET NULL`` keeps the payment row in place (audit trail)
    # if the user archives / hard-deletes the source account; the FK
    # is nulled out so reporting can still bucket the row under
    # "uncategorised source". Nullable so a cash-in-hand payment with
    # no linked account is a first-class case (spec AC).
    source_account_id: Mapped[str | None] = mapped_column(
        GUID(),
        ForeignKey("accounts.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    debt: Mapped[Debt] = relationship(back_populates="payments")
