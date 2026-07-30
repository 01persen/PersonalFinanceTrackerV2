"""rule_audit_log unique constraint + priority DESC index

Revision ID: b2c4d6e8f0a4
Revises: b2c4d6e8f0a3
Create Date: 2026-07-30 05:00:00.000000

Closes the QA defect loop on sub-0004-02:

* Adds ``uq_rule_audit_log_rule_tx_origin`` — a UNIQUE constraint
  on ``(rule_id, transaction_id, origin)`` so two concurrent
  ``apply_backfill=true`` requests cannot both write an audit row for
  the same ``(rule, transaction, origin)`` triple. The duplicate
  insert raises ``IntegrityError`` which the service layer catches
  + counts as no-op (the apply path is already a transaction so a
  rollback here doesn't lose the *other* per-transaction work).
  Portable across SQLite (the test backend) and PostgreSQL (prod).
  Pre-existing duplicates from the previous build are deduped in
  the upgrade path so the constraint can be created cleanly —
  only the earliest row per triple is kept.

* Recreates ``ix_category_rules_user_priority_active`` with the
  priority column explicitly declared ``DESC``. PostgreSQL honours
  the direction for ordered scans; SQLite ignores the direction
  marker but stores the column ascending on disk (functionally
  equivalent for our query, which is a forward scan from the
  highest-priority active rule). The migration docstring on
  ``b2c4d6e8f0a2`` had this wrong; this migration makes the index
  definition match the apply path's ``ORDER BY priority DESC, id
  ASC`` so EXPLAIN plans are honest.

All changes are reversible. Downgrade drops the unique constraint
+ recreates the original ASC index without re-running the data
dedupe.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b2c4d6e8f0a4"
down_revision: str | Sequence[str] | None = "b2c4d6e8f0a3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()

    # 0) ``origin_tag`` column was added by the backfill migration
    # ``b2c4d6e8f0a3`` so the idempotency ``SELECT ... FROM
    # rule_audit_log`` could reference it. QA retest #2 found that
    # leaving the column addition to this migration meant f0a3
    # crashed on any database with prior data
    # (``no such column: origin_tag``). We add it in f0a3 and skip
    # here so the chain ``f0a3 → f0a4`` is order-stable.

    # 1) Dedupe any existing audit rows that would block the unique
    # index. Keep the earliest-applied row per triple.
    bind.execute(
        sa.text(
            """
            DELETE FROM rule_audit_log
            WHERE id IN (
                SELECT a.id
                FROM rule_audit_log AS a
                JOIN rule_audit_log AS b
                  ON a.rule_id IS b.rule_id
                 AND a.transaction_id = b.transaction_id
                 AND a.origin = b.origin
                 AND a.applied_at > b.applied_at
                WHERE a.rule_id IS NOT NULL
            )
            """
        )
    )

    # 2) Unique index on (rule_id, transaction_id, origin). We use
    # ``CREATE UNIQUE INDEX`` instead of ``ADD CONSTRAINT ... UNIQUE``
    # because SQLite's ALTER TABLE doesn't support constraint
    # changes (Alembic raises NotImplementedError). A unique INDEX
    # enforces the same semantics on both backends.
    op.create_index(
        "uq_rule_audit_log_rule_tx_origin",
        "rule_audit_log",
        ["rule_id", "transaction_id", "origin"],
        unique=True,
    )

    # 3) Recreate the priority index with DESC direction.
    # Drop + create is portable across SQLite + PostgreSQL.
    op.drop_index(
        "ix_category_rules_user_priority_active",
        table_name="category_rules",
    )
    op.create_index(
        "ix_category_rules_user_priority_active",
        "category_rules",
        ["user_id", sa.text("priority DESC"), "active"],
    )


def downgrade() -> None:
    # Reverse the priority index first so the unique index can
    # be dropped safely (no FK dependency either way, but doing it
    # in reverse order keeps the upgrade/downgrade symmetric).
    op.drop_index(
        "ix_category_rules_user_priority_active",
        table_name="category_rules",
    )
    op.create_index(
        "ix_category_rules_user_priority_active",
        "category_rules",
        ["user_id", "priority", "active"],
    )

    op.drop_index(
        "uq_rule_audit_log_rule_tx_origin",
        table_name="rule_audit_log",
    )

    # ``origin_tag`` column is dropped by ``b2c4d6e8f0a3``'s
    # downgrade — keep the schema change co-located with the
    # migration that introduces it so the upgrade/downgrade chain
    # is symmetric and self-contained.
