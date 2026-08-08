"""Category table."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, Enum, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.db.models.enums import CategoryKind
from app.db.models.mixins import GUID, TimestampMixin, UserFKMixin, UUIDPKMixin

if TYPE_CHECKING:
    from app.db.models.category_rule import CategoryRule
    from app.db.models.recurring_rule import RecurringRule
    from app.db.models.transaction import Transaction
    from app.db.models.user import User


class Category(Base, UUIDPKMixin, UserFKMixin, TimestampMixin):
    __tablename__ = "categories"

    name: Mapped[str] = mapped_column(String(120), nullable=False)
    kind: Mapped[CategoryKind] = mapped_column(
        Enum(CategoryKind, name="category_kind", native_enum=False, length=16),
        nullable=False,
    )
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(),
        ForeignKey("categories.id", ondelete="SET NULL"),
        nullable=True,
    )
    color: Mapped[str | None] = mapped_column(String(16), nullable=True)
    icon: Mapped[str | None] = mapped_column(String(64), nullable=True)
    archived: Mapped[bool] = mapped_column(default=False, nullable=False)
    # Server-side tombstone timestamp. Set on DELETE / archive endpoints, NULL
    # while the row is active. The composite index (user_id, kind, archived_at)
    # keeps the active-rows filter ("archived_at IS NULL") cheap for the list
    # endpoint and any future aggregations over the category tree.
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    user: Mapped[User] = relationship(back_populates="categories")
    parent: Mapped[Category | None] = relationship(
        remote_side="Category.id", back_populates="children"
    )
    children: Mapped[list[Category]] = relationship(back_populates="parent")
    transactions: Mapped[list[Transaction]] = relationship(back_populates="category")
    rules: Mapped[list[CategoryRule]] = relationship(back_populates="category")
    recurring_rules: Mapped[list[RecurringRule]] = relationship(back_populates="category")
