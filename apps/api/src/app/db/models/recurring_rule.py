"""Recurring rule table (sub-0009-01, epic-0009).

A recurring rule is the *template* the materializer (sub-0009-02) reads at
each run to decide whether to spawn a transaction. Schema is intentionally
narrow — it captures everything the FE CRUD form needs plus what the
worker needs to compute the next-run moment, and nothing more. There is
no join to ``transactions`` from this table; the materializer writes
``recurring_rule_id`` on each spawned row so audit / rollback can follow
the chain backwards without a back-reference on this table.

Field summary:

* **Common** — ``kind`` (bill / subscription / cicilan_fixed), ``cadence``
  (daily / weekly / monthly / yearly), ``amount_cents``, ``currency``,
  ``note``, ``is_active``, server timestamps.
* **Schedule** — ``start_on`` (anchor), ``end_on`` (nullable — open-ended
  rules run forever), ``next_run_on`` (derived server-side at create
  time from ``start_on + cadence``; the worker re-derives it after each
  spawn).
* **FK** — ``account_id`` (NOT NULL, mirrors ``transactions.account_id``)
  and ``category_id`` (nullable — some bills are uncategorised).

``kind`` and ``cadence`` are stored as ``String`` columns via
``Enum(..., native_enum=False, ...)`` to match the rest of the schema
(categories / accounts / transactions / goals) and keep the SQLite vs
PostgreSQL DDL bit-identical.

Indexes:

* ``ix_recurring_rules_user_next_run_on`` — hot-path for the worker
  ("all due rules for user X on or before today").
* ``ix_recurring_rules_user_account`` — FE list filter by account.
* ``ix_recurring_rules_user_active_next_run`` — combined "active rules
  for user X ordered by next-run" for the dashboard widget.

``is_active`` lets the FE pause a rule without losing its audit history.
The DELETE endpoint is a hard delete; pausing (set ``is_active=false``)
is the soft-disable path.
"""

from __future__ import annotations

import uuid
from datetime import date
from typing import TYPE_CHECKING

from sqlalchemy import (
    BigInteger,
    Boolean,
    Date,
    Enum,
    ForeignKey,
    Index,
    String,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.db.models.enums import RecurringRuleCadence, RecurringRuleKind
from app.db.models.mixins import GUID, TimestampMixin, UserFKMixin, UUIDPKMixin

if TYPE_CHECKING:
    from app.db.models.account import Account
    from app.db.models.category import Category
    from app.db.models.user import User


class RecurringRule(Base, UUIDPKMixin, UserFKMixin, TimestampMixin):
    __tablename__ = "recurring_rules"
    __table_args__ = (
        # Worker scan — "rules for user X with next_run_on <= today".
        Index("ix_recurring_rules_user_next_run_on", "user_id", "next_run_on"),
        # FE list filter — "rules for user X scoped to one account".
        Index("ix_recurring_rules_user_account", "user_id", "account_id"),
        # Active-only dashboard widget scan.
        Index(
            "ix_recurring_rules_user_active_next_run",
            "user_id",
            "is_active",
            "next_run_on",
        ),
    )

    account_id: Mapped[uuid.UUID] = mapped_column(
        GUID(),
        ForeignKey("accounts.id", ondelete="CASCADE"),
        nullable=False,
    )
    category_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(),
        ForeignKey("categories.id", ondelete="SET NULL"),
        nullable=True,
    )
    kind: Mapped[RecurringRuleKind] = mapped_column(
        Enum(RecurringRuleKind, name="recurring_rule_kind", native_enum=False, length=32),
        nullable=False,
    )
    cadence: Mapped[RecurringRuleCadence] = mapped_column(
        Enum(
            RecurringRuleCadence,
            name="recurring_rule_cadence",
            native_enum=False,
            length=16,
        ),
        nullable=False,
    )
    amount_cents: Mapped[int] = mapped_column(BigInteger, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    start_on: Mapped[date] = mapped_column(Date, nullable=False)
    end_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    next_run_on: Mapped[date] = mapped_column(Date, nullable=False)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_active: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        server_default=func.true(),
    )

    user: Mapped[User] = relationship(back_populates="recurring_rules")
    account: Mapped[Account] = relationship(back_populates="recurring_rules")
    category: Mapped[Category | None] = relationship(back_populates="recurring_rules")
