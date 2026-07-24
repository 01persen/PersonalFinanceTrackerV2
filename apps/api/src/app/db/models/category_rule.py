"""Category rule (auto-categorisation) table."""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.db.models.mixins import GUID, TimestampMixin, UserFKMixin, UUIDPKMixin

if TYPE_CHECKING:
    from app.db.models.category import Category
    from app.db.models.user import User


class CategoryRule(Base, UUIDPKMixin, UserFKMixin, TimestampMixin):
    __tablename__ = "category_rules"

    pattern: Mapped[str] = mapped_column(String(255), nullable=False)
    category_id: Mapped[str] = mapped_column(
        GUID(),
        ForeignKey("categories.id", ondelete="CASCADE"),
        nullable=False,
    )
    priority: Mapped[int] = mapped_column(Integer, nullable=False, default=100)

    user: Mapped[User] = relationship(back_populates="category_rules")
    category: Mapped[Category] = relationship(back_populates="rules")
