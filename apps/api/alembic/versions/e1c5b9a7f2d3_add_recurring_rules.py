"""add recurring_rules table (sub-0009-01)

Revision ID: e1c5b9a7f2d3
Revises: 7d8e9f0a1b2c
Create Date: 2026-08-09 04:00:00.000000

epic-0009 (Recurring Transaction & Reminder), sub-0009-01 — recurring
rule CRUD scaffold.

Adds the ``recurring_rules`` table that the FE CRUD form (sub-0009-04)
will populate and the materializer (sub-0009-02) will read on each
worker run. Schema is intentionally narrow — just enough columns to
describe the schedule (kind, cadence, start_on / end_on, next_run_on)
plus the FK targets the worker needs to spawn a transaction
(account_id, category_id).

Enum values are stored as ``VARCHAR(n)`` via SQLAlchemy ``Enum(..., native_enum=False)``
so the DDL stays bit-identical on SQLite (test DB) and PostgreSQL
(production). The same pattern is used by ``transaction_type``,
``account_type``, ``category_kind``, ``goal_kind``, etc.

Three indexes cover the hot read paths:

* ``ix_recurring_rules_user_next_run_on`` — worker's "rules for user X
  with next_run_on <= today" scan (sub-0009-02 hot path).
* ``ix_recurring_rules_user_account`` — FE list filter scoped to one
  account.
* ``ix_recurring_rules_user_active_next_run`` — dashboard widget scan
  for active rules ordered by next-run.

Cascade / set-null behaviour mirrors the existing pattern on
``transactions`` / ``goals``:

* ``account_id`` FK — ``ON DELETE CASCADE``. Archiving an account is a
  soft-delete (``archived=True``) so existing rows stay linked; a hard
  delete of an account row will pull its rules with it (matches the
  ``transactions`` behaviour on the same FK).
* ``category_id`` FK — ``ON DELETE SET NULL``. Categories are
  soft-deleted via ``archived_at`` so the link survives in practice; a
  hard delete clears the link so the rule can still fire uncategorised.

Reversible: ``downgrade()`` drops the table. SQLite uses the
batch-recreate path so a fresh DB on SQLite < 3.35.0 lands the DROP
cleanly; PostgreSQL uses a regular ``DROP TABLE``.

Tested by ``tests/test_migrations.py``:

* ``test_upgrade_creates_all_tables`` — adds ``recurring_rules`` and its
  three composite indexes to ``EXPECTED_TABLES`` / ``EXPECTED_INDEXES``.
* ``test_recurring_rules_table_roundtrip`` (added in sub-0009-01) —
  applies + downgrades + reapplies + verifies column presence + index
  presence.
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
revision: str = "e1c5b9a7f2d3"
down_revision: str | Sequence[str] | None = "7d8e9f0a1b2c"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the ``recurring_rules`` table + supporting indexes."""
    op.create_table(
        "recurring_rules",
        sa.Column("account_id", GUID(), nullable=False),
        sa.Column("category_id", GUID(), nullable=True),
        sa.Column(
            "kind",
            sa.Enum(
                "bill",
                "subscription",
                "cicilan_fixed",
                name="recurring_rule_kind",
                native_enum=False,
                length=32,
            ),
            nullable=False,
        ),
        sa.Column(
            "cadence",
            sa.Enum(
                "daily",
                "weekly",
                "monthly",
                "yearly",
                name="recurring_rule_cadence",
                native_enum=False,
                length=16,
            ),
            nullable=False,
        ),
        sa.Column("amount_cents", sa.BigInteger(), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("start_on", sa.Date(), nullable=False),
        sa.Column("end_on", sa.Date(), nullable=True),
        sa.Column("next_run_on", sa.Date(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column(
            "is_active",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
        sa.Column("id", GUID(), nullable=False),
        sa.Column("user_id", GUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["account_id"],
            ["accounts.id"],
            name=op.f("fk_recurring_rules_account_id_accounts"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["category_id"],
            ["categories.id"],
            name=op.f("fk_recurring_rules_category_id_categories"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_recurring_rules_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_recurring_rules")),
    )
    op.create_index(
        op.f("ix_recurring_rules_user_next_run_on"),
        "recurring_rules",
        ["user_id", "next_run_on"],
        unique=False,
    )
    op.create_index(
        op.f("ix_recurring_rules_user_account"),
        "recurring_rules",
        ["user_id", "account_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_recurring_rules_user_active_next_run"),
        "recurring_rules",
        ["user_id", "is_active", "next_run_on"],
        unique=False,
    )


def downgrade() -> None:
    """Drop the ``recurring_rules`` table added in :func:`upgrade`."""
    # SQLite < 3.35.0 cannot drop columns natively and Alembic's plain
    # ``drop_table`` is enough here (no column add on a pre-existing
    # table). Use ``batch_alter_table`` so the DDL stays reversible on
    # older SQLite + PostgreSQL without dialect-specific branching.
    with op.batch_alter_table("recurring_rules", recreate="always") as batch_op:
        batch_op.drop_index(op.f("ix_recurring_rules_user_next_run_on"))
        batch_op.drop_index(op.f("ix_recurring_rules_user_account"))
        batch_op.drop_index(op.f("ix_recurring_rules_user_active_next_run"))
    op.drop_table("recurring_rules")
