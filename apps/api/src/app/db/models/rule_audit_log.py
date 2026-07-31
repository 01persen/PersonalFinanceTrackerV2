"""Audit log for category-rule auto-applies (sub-0004-02).

Every time the rule engine assigns a ``category_id`` to a transaction
— whether from a POST / PATCH on ``/transactions`` (live apply) or from
the ``POST /categories/apply-rules`` backfill — a row is written here
recording the exact change. The trail is what the QA + analytics
squad need to answer "why did this transaction land in *Makan*?" and
is the input for the idempotency hash that the data-migration script
checks before re-applying.

One row per *apply event*, not per (rule, transaction) pair over the
lifetime — the rule id may change as users re-prioritise, and re-writes
are normal; the log preserves the exact ``prev_category_id`` →
``new_category_id`` transition plus the rule id that caused it.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

import sqlalchemy as sa
from sqlalchemy import DateTime, ForeignKey, Index, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.db.models.mixins import GUID, UUIDPKMixin

if TYPE_CHECKING:
    from app.db.models.category_rule import CategoryRule
    from app.db.models.transaction import Transaction


class RuleAuditLog(Base, UUIDPKMixin):
    __tablename__ = "rule_audit_log"
    __table_args__ = (
        Index("ix_rule_audit_log_user_applied_at", "user_id", "applied_at"),
        Index("ix_rule_audit_log_rule_applied_at", "rule_id", "applied_at"),
        Index("ix_rule_audit_log_transaction", "transaction_id"),
        # Sub-0004-02 QA fix — unique (rule, transaction, origin)
        # prevents duplicate audit rows on concurrent backfill. The
        # constraint is portable across SQLite + PostgreSQL and is
        # created by Alembic migration b2c4d6e8f0a4. ``applied_at``
        # is excluded because duplicate writes within the same
        # microsecond would otherwise be allowed; the constraint
        # catches that case at the (rule, tx, origin) level instead.
        sa.UniqueConstraint(
            "rule_id",
            "transaction_id",
            "origin",
            name="uq_rule_audit_log_rule_tx_origin",
        ),
    )

    rule_id: Mapped[uuid.UUID] = mapped_column(
        GUID(),
        ForeignKey("category_rules.id", ondelete="SET NULL"),
        nullable=True,
    )
    transaction_id: Mapped[uuid.UUID] = mapped_column(
        GUID(),
        ForeignKey("transactions.id", ondelete="CASCADE"),
        nullable=False,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        GUID(),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    prev_category_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(),
        ForeignKey("categories.id", ondelete="SET NULL"),
        nullable=True,
    )
    new_category_id: Mapped[uuid.UUID] = mapped_column(
        GUID(),
        ForeignKey("categories.id", ondelete="SET NULL"),
        nullable=False,
    )
    applied_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    origin: Mapped[str] = mapped_column(
        # ``"live"`` for POST/PATCH /transactions, ``"backfill"`` for the
        # admin dry-run / apply endpoint. Free-text on purpose — future
        # origins (``"import"``, ``"undo"``) reuse the same row without a
        # schema change.
    )
    origin_tag: Mapped[str | None] = mapped_column(
        # Sub-0004-02 QA fix — SHA256 fingerprint of the active rule
        # set at apply time, used by the Alembic data migration to
        # short-circuit re-runs when the rules haven't changed. NULL
        # for the live-apply path (only the backfill hashes rules).
        nullable=True,
    )

    rule: Mapped[CategoryRule | None] = relationship()
    transaction: Mapped[Transaction] = relationship()
