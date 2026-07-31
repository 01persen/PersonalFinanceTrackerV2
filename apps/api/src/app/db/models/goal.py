"""Goal table — Saving and Emergency Fund trackers (epic-0005).

Per PRD §14, the schema is one table with a ``kind`` discriminator
(``saving`` | ``emergency_fund``). Kind-specific columns are nullable so a
single backing table can hold both flavours without a JOIN-style subclass
split — the API layer enforces which fields are allowed at write time
(``GoalCreate`` runs the kind-specific validation in Pydantic, not at
the DB level).

Field summary:

* **Common** — ``kind``, ``name``, ``target_amount_cents``,
  ``current_amount_cents``, ``linked_account_id`` (nullable FK to
  ``accounts.id``), ``start_date``, ``notes``, ``archived_at``,
  ``created_at`` / ``updated_at``.
* **Saving-only** — ``target_date``, ``jangka_waktu_months``,
  ``tabungan_bulanan_cents`` (auto-calc server).
* **Emergency Fund-only** — ``monthly_expense_cents``, ``jumlah_tanggungan``,
  ``multiplier``, ``lama_mengumpulkan_bulan`` (auto-calc),
  ``target_amount_snapshot_cents`` (snapshot of the auto-calc formula result).

Auto-calc fields (``tabungan_bulanan_cents``, ``lama_mengumpulkan_bulan``,
``target_amount_snapshot_cents``) are populated by sub-0005-02 in the
service layer; sub-0005-01 (this PR) just stores ``NULL`` and lets the
client send a manual value when applicable (or rely on the server to
default later). The ``current_amount_cents`` column is nullable so a
goal with a linked account has no persisted value — sub-0005-02 will
compute the live amount from the saldo engine on read.

The FK to ``accounts`` is ``ON DELETE SET NULL`` so archiving an account
never cascades into deleting the goal (mirrors the PRD's audit-friendly
intent — losing a goal because someone closes an account would be a
surprise).
"""

from __future__ import annotations

from datetime import date
from typing import TYPE_CHECKING

from sqlalchemy import BigInteger, Date, DateTime, Enum, ForeignKey, Index, Integer, String, Text
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
    linked_account_id: Mapped[str | None] = mapped_column(
        GUID(),
        ForeignKey("accounts.id", ondelete="SET NULL"),
        nullable=True,
    )
    current_amount_cents: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    jangka_waktu_months: Mapped[int | None] = mapped_column(Integer, nullable=True)
    tabungan_bulanan_cents: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    monthly_expense_cents: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    jumlah_tanggungan: Mapped[int | None] = mapped_column(Integer, nullable=True)
    multiplier: Mapped[int | None] = mapped_column(Integer, nullable=True)
    lama_mengumpulkan_bulan: Mapped[int | None] = mapped_column(Integer, nullable=True)
    target_amount_snapshot_cents: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    archived_at: Mapped[DateTime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )

    # Composite indexes mirroring the (user_id, kind) and (user_id, archived_at)
    # lookups the list endpoint issues, plus the (linked_account_id) recompute
    # lookup sub-0005-02 will use to refresh goal current_amount when an
    # account balance changes.
    __table_args__ = (
        Index("ix_goals_user_id_kind", "user_id", "kind"),
        Index("ix_goals_user_id_archived_at", "user_id", "archived_at"),
        Index("ix_goals_linked_account_id", "linked_account_id"),
    )

    user: Mapped[User] = relationship(back_populates="goals")
    linked_account: Mapped[Account | None] = relationship(back_populates="goals")
