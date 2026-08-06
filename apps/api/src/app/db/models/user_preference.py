"""User preferences — single-row-per-user settings (locale, currency, EF multiplier, etc.).

Created at registration by the seed module and read back via the
``/api/v1/preferences`` endpoint (and embedded in ``/api/v1/auth/me``).

Sub-0008-03 extends the table with three settings columns:

* ``week_start`` — first day of the week (PRD §14: ``"senin"``).
  Enum whitelist enforced at the API layer; DB column stays a
  short string for forward-compat.
* ``display_name`` — optional profile nickname. NULL until the
  user sets one on the settings page; capped at 100 chars at the
  API layer.
* ``version`` — optimistic concurrency token. Starts at 1, gets
  bumped on every successful PATCH. Clients must echo the current
  value in the ``If-Match`` header or the write is rejected with
  412 (the GET returns it as ``ETag: "<version>"`` plus a body
  field ``version: int``).
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
    week_start: Mapped[str] = mapped_column(String(16), nullable=False, default="senin")
    display_name: Mapped[str | None] = mapped_column(String(100), nullable=True, default=None)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    user: Mapped[User] = relationship(back_populates="preferences")
