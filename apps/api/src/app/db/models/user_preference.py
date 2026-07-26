"""User preferences — single-row-per-user settings (locale, currency, EF multiplier, etc.).

Created at registration by the seed module and read back via the
``/api/v1/preferences`` endpoint (and embedded in ``/api/v1/auth/me``).
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.db.models.mixins import TimestampMixin, UserFKMixin, UUIDPKMixin

if TYPE_CHECKING:
    from app.db.models.user import User


class UserPreference(Base, UUIDPKMixin, UserFKMixin, TimestampMixin):
    __tablename__ = "user_preferences"
    __table_args__ = (UniqueConstraint("user_id", name="uq_user_preferences_user_id"),)

    locale: Mapped[str] = mapped_column(String(10), nullable=False, default="id-ID")
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="IDR")
    emergency_fund_multiplier: Mapped[int] = mapped_column(Integer, nullable=False, default=3)
    dependents_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    theme: Mapped[str] = mapped_column(String(16), nullable=False, default="system")

    user: Mapped[User] = relationship(back_populates="preferences")
