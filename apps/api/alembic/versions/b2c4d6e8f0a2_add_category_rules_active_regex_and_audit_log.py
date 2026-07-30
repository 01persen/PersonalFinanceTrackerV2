"""add category_rules active+is_regex + rule_audit_log

Revision ID: b2c4d6e8f0a2
Revises: b2c4d6e8f0a1
Create Date: 2026-07-29 14:00:00.000000

Closes sub-0004-02 acceptance criteria (3) and (5)-(6):

* Adds ``is_regex`` and ``active`` columns to ``category_rules``.
  ``active=True`` server default mirrors the existing default behaviour
  (all rows are eligible) so the live-apply path can safely filter on
  ``active=True`` without a backfill — rows created before this
  migration get the column default on next read.
* Adds the composite index ``ix_category_rules_user_priority_active``
  on ``(user_id, priority, active)`` — the hot-path index for the
  rule lookup ``WHERE user_id = ? AND active = TRUE ORDER BY
  priority DESC, id ASC``. Priority is stored ASC because
  PostgreSQL can scan the composite index DESC (the apply path asks
  for ``priority DESC, id ASC``) without an extra sort step.
* Creates ``rule_audit_log`` with the schema described in
  sub-0004-02 AC (6): one row per apply event carrying the rule id,
  transaction id, user id, prev/new category ids, ``applied_at``,
  and a free-text ``origin`` column (``"live"`` / ``"backfill"``).
* Three supporting indexes on the audit table (per AC for audit log
  volume and idempotency):

    - ``ix_rule_audit_log_user_applied_at`` — the "last applied_at
      per user" lookup used by the idempotency hash check in the
      Alembic data migration (``see b2c4d6e8f0a3_backfill_apply_rules``).
    - ``ix_rule_audit_log_rule_applied_at`` — analytics paths that
      ask "how many transactions did rule X touch this month".
    - ``ix_rule_audit_log_transaction`` — reverse lookup from the
      transaction side ("why does this row sit in *Makan*?").

All changes are reversible (the audit log table + indexes are dropped
on downgrade; the new ``category_rules`` columns and index are
removed; existing rules keep their original behaviour because the
defaults are non-destructive).
"""

from __future__ import annotations

import sys
from collections.abc import Sequence
from pathlib import Path

import sqlalchemy as sa
from alembic import op

# Ensure ``app`` package is importable when the migration runs standalone.
_SRC = Path(__file__).resolve().parents[3] / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from app.db.models.mixins import GUID  # noqa: E402

# revision identifiers, used by Alembic.
revision: str = "b2c4d6e8f0a2"
down_revision: str | Sequence[str] | None = "b2c4d6e8f0a1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add rule behaviour flags + the audit log table."""
    op.add_column(
        "category_rules",
        sa.Column(
            "is_regex",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.add_column(
        "category_rules",
        sa.Column(
            "active",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
    )
    op.create_index(
        op.f("ix_category_rules_user_priority_active"),
        "category_rules",
        ["user_id", "priority", "active"],
        unique=False,
    )

    op.create_table(
        "rule_audit_log",
        sa.Column("rule_id", GUID(), nullable=True),
        sa.Column("transaction_id", GUID(), nullable=False),
        sa.Column("user_id", GUID(), nullable=False),
        sa.Column("prev_category_id", GUID(), nullable=True),
        sa.Column("new_category_id", GUID(), nullable=False),
        sa.Column(
            "applied_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column("origin", sa.String(length=32), nullable=False),
        sa.Column("id", GUID(), nullable=False),
        sa.ForeignKeyConstraint(
            ["rule_id"],
            ["category_rules.id"],
            name=op.f("fk_rule_audit_log_rule_id_category_rules"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["transaction_id"],
            ["transactions.id"],
            name=op.f("fk_rule_audit_log_transaction_id_transactions"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_rule_audit_log_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["prev_category_id"],
            ["categories.id"],
            name=op.f("fk_rule_audit_log_prev_category_id_categories"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["new_category_id"],
            ["categories.id"],
            name=op.f("fk_rule_audit_log_new_category_id_categories"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_rule_audit_log")),
    )
    op.create_index(
        op.f("ix_rule_audit_log_user_applied_at"),
        "rule_audit_log",
        ["user_id", "applied_at"],
        unique=False,
    )
    op.create_index(
        op.f("ix_rule_audit_log_rule_applied_at"),
        "rule_audit_log",
        ["rule_id", "applied_at"],
        unique=False,
    )
    op.create_index(
        op.f("ix_rule_audit_log_transaction"),
        "rule_audit_log",
        ["transaction_id"],
        unique=False,
    )


def downgrade() -> None:
    """Drop the audit log table + rule flags + indexes."""
    op.drop_index(
        op.f("ix_rule_audit_log_transaction"), table_name="rule_audit_log"
    )
    op.drop_index(
        op.f("ix_rule_audit_log_rule_applied_at"), table_name="rule_audit_log"
    )
    op.drop_index(
        op.f("ix_rule_audit_log_user_applied_at"), table_name="rule_audit_log"
    )
    op.drop_table("rule_audit_log")

    op.drop_index(
        op.f("ix_category_rules_user_priority_active"),
        table_name="category_rules",
    )
    op.drop_column("category_rules", "active")
    op.drop_column("category_rules", "is_regex")
