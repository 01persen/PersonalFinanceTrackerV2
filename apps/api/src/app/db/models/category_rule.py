"""Category rule (auto-categorisation) table.

Scope: sub-0004-02. The table ships with the four-column shape from the
initial schema migration (``pattern``, ``category_id``, ``priority``,
``user_id``, ``id``, ``timestamps``). sub-0004-02 adds two nullable
behaviour flags that the rule engine + audit path depend on:

* ``is_regex`` — when ``True`` the ``pattern`` is a Python regex
  (``re.search``) instead of a plain case-insensitive substring. The
  route layer documents the ReDoS risk (see services/rule_engine.py).
* ``active`` — soft-toggle a rule without deleting it. The apply
  path skips ``active=False`` rows; admins can flip the flag later
  to re-enable.

The composite index ``ix_category_rules_user_priority_active`` is the
hot-path index for the rule lookup (``WHERE user_id = ? AND active =
TRUE ORDER BY priority DESC, id ASC``); see the
``b2c4d6e8f0a2_add_category_rules_active_regex_index`` migration for
the DDL.
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, ForeignKey, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.db.models.mixins import GUID, TimestampMixin, UserFKMixin, UUIDPKMixin

if TYPE_CHECKING:
    from app.db.models.category import Category
    from app.db.models.user import User


class CategoryRule(Base, UUIDPKMixin, UserFKMixin, TimestampMixin):
    __tablename__ = "category_rules"
    __table_args__ = (
        Index(
            "ix_category_rules_user_priority_active",
            "user_id",
            "priority",
            "active",
        ),
    )

    pattern: Mapped[str] = mapped_column(String(255), nullable=False)
    category_id: Mapped[uuid.UUID] = mapped_column(
        GUID(),
        ForeignKey("categories.id", ondelete="CASCADE"),
        nullable=False,
    )
    priority: Mapped[int] = mapped_column(Integer, nullable=False, default=100)
    is_regex: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )

    user: Mapped[User] = relationship(back_populates="category_rules")
    category: Mapped[Category] = relationship(back_populates="rules")
