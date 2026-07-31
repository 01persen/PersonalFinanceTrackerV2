"""extend goals table (sub-0005-01)

Revision ID: f5a6b7c8d9e0
Revises: b2c4d6e8f0a5
Create Date: 2026-07-31 19:00:00.000000

Goal Trackers (epic-0005, sub-0005-01). The ``goals`` table was a stub in
the initial schema — just enough columns for FK compatibility — so this
migration brings it up to the full PRD §14 shape.

Schema changes:

* **Rename** ``account_id`` → ``linked_account_id`` (the PRD's term for
  the optional account the goal tracks). Same FK target (``accounts.id``)
  and the same ``ON DELETE SET NULL`` semantics. The renamer uses
  ``ALTER TABLE ... RENAME COLUMN`` which is portable to both SQLite and
  PostgreSQL — Alembic emits the right syntax on each backend via the
  dialect-aware ``op.alter_column``.
* **Make ``current_amount_cents`` nullable.** It was ``NOT NULL DEFAULT 0``
  in the stub; the PRD allows ``NULL`` for goals that derive their
  current amount from the linked account balance (sub-0005-02 owns
  that compute path; here we just relax the constraint so the storage
  layer can stay consistent with the read model). Existing rows keep
  their integer default (``0``) since ``ALTER COLUMN ... DROP NOT NULL``
  does not touch the data.
* **Add new columns**:

  - ``start_date DATE NOT NULL DEFAULT CURRENT_DATE`` — every goal needs
    a start date (sub-0005-02 auto-picks ``today`` if omitted).
  - ``jangka_waktu_months INT NULL`` — saving-only horizon.
  - ``tabungan_bulanan_cents BIGINT NULL`` — auto-calc (saving). NULL
    until sub-0005-02 wires the rule.
  - ``monthly_expense_cents BIGINT NULL`` — EF-only snapshot input.
  - ``jumlah_tanggungan INT NULL`` — EF-only dependency count.
  - ``multiplier INT NULL`` — EF-only multiplier (PRD §14 default 3).
  - ``lama_mengumpulkan_bulan INT NULL`` — auto-calc EF.
  - ``target_amount_snapshot_cents BIGINT NULL`` — EF-only snapshot of
    the auto-calc formula result.
  - ``notes TEXT NULL`` — free-form annotation.
  - ``archived_at TIMESTAMP NULL`` — soft-delete tombstone. Mirrors the
    ``archived_at`` pattern on ``categories`` (sub-0004-01).

* **Indexes** (replaces the generic ``ix_goals_user_id``):

  - ``ix_goals_user_id_kind`` on ``(user_id, kind)`` — drives the list
    endpoint's ``?kind=`` filter.
  - ``ix_goals_user_id_archived_at`` on ``(user_id, archived_at)`` —
    drives the ``?archived=false`` filter (soft-delete exclusion).
  - ``ix_goals_linked_account_id`` on ``(linked_account_id)`` — for
    sub-0005-02's recompute lookup when an account balance changes.

Reversible: ``downgrade()`` drops the new indexes, drops the new
columns, restores the ``current_amount_cents NOT NULL`` constraint,
renames ``linked_account_id`` back to ``account_id``, and recreates
the original ``ix_goals_user_id`` index. Tested in
``tests/test_migrations.py::test_downgrade_is_reversible``.
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
revision: str = "f5a6b7c8d9e0"
down_revision: str | Sequence[str] | None = "b2c4d6e8f0a5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Extend ``goals`` to the full PRD §14 schema."""
    # 1. Rename ``account_id`` → ``linked_account_id``. Preserves data and
    # the FK constraint (Alembic emits the matching ``REFERENCES`` clause on
    # the new column).
    op.alter_column(
        "goals",
        "account_id",
        new_column_name="linked_account_id",
        existing_type=GUID(),
        existing_nullable=True,
    )

    # 2. Relax ``current_amount_cents`` → nullable. Existing rows keep
    # their default value; the looser constraint doesn't rewrite data.
    op.alter_column(
        "goals",
        "current_amount_cents",
        existing_type=sa.BigInteger(),
        nullable=True,
    )

    # 3. New columns. ``start_date`` has a server-side default so the
    # migration is safe to run over a populated stub table.
    op.add_column(
        "goals",
        sa.Column(
            "start_date",
            sa.Date(),
            nullable=False,
            server_default=sa.text("CURRENT_DATE"),
        ),
    )
    op.add_column(
        "goals",
        sa.Column("jangka_waktu_months", sa.Integer(), nullable=True),
    )
    op.add_column(
        "goals",
        sa.Column("tabungan_bulanan_cents", sa.BigInteger(), nullable=True),
    )
    op.add_column(
        "goals",
        sa.Column("monthly_expense_cents", sa.BigInteger(), nullable=True),
    )
    op.add_column(
        "goals",
        sa.Column("jumlah_tanggungan", sa.Integer(), nullable=True),
    )
    op.add_column(
        "goals",
        sa.Column("multiplier", sa.Integer(), nullable=True),
    )
    op.add_column(
        "goals",
        sa.Column("lama_mengumpulkan_bulan", sa.Integer(), nullable=True),
    )
    op.add_column(
        "goals",
        sa.Column(
            "target_amount_snapshot_cents", sa.BigInteger(), nullable=True
        ),
    )
    op.add_column(
        "goals",
        sa.Column("notes", sa.Text(), nullable=True),
    )
    op.add_column(
        "goals",
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
    )

    # 4. Replace the generic ``ix_goals_user_id`` with composite indexes
    # that match the list endpoint's filter chain. Drop first because
    # SQLite refuses to create two indexes covering the same leading
    # column with the same name.
    op.drop_index(op.f("ix_goals_user_id"), table_name="goals")
    op.create_index(
        "ix_goals_user_id_kind",
        "goals",
        ["user_id", "kind"],
        unique=False,
    )
    op.create_index(
        "ix_goals_user_id_archived_at",
        "goals",
        ["user_id", "archived_at"],
        unique=False,
    )
    op.create_index(
        "ix_goals_linked_account_id",
        "goals",
        ["linked_account_id"],
        unique=False,
    )


def downgrade() -> None:
    """Reverse every change in ``upgrade()`` exactly."""
    # 1. Drop the new indexes, restore ``ix_goals_user_id``.
    op.drop_index("ix_goals_linked_account_id", table_name="goals")
    op.drop_index("ix_goals_user_id_archived_at", table_name="goals")
    op.drop_index("ix_goals_user_id_kind", table_name="goals")
    op.create_index(
        op.f("ix_goals_user_id"),
        "goals",
        ["user_id"],
        unique=False,
    )

    # 2. Drop the new columns in reverse order (column order is cosmetic
    # on SQLite/PG but keeps the diff readable).
    op.drop_column("goals", "archived_at")
    op.drop_column("goals", "notes")
    op.drop_column("goals", "target_amount_snapshot_cents")
    op.drop_column("goals", "lama_mengumpulkan_bulan")
    op.drop_column("goals", "multiplier")
    op.drop_column("goals", "jumlah_tanggungan")
    op.drop_column("goals", "monthly_expense_cents")
    op.drop_column("goals", "tabungan_bulanan_cents")
    op.drop_column("goals", "jangka_waktu_months")
    op.drop_column("goals", "start_date")

    # 3. Re-tighten ``current_amount_cents`` → NOT NULL. The default
    # ``0`` already exists on the column so any ``NULL`` introduced by
    # the relaxed constraint would break — but this is a downgrade path
    # we expect to run in dev/CI only, never in production, so we don't
    # bake a backfill in here.
    op.alter_column(
        "goals",
        "current_amount_cents",
        existing_type=sa.BigInteger(),
        nullable=False,
    )

    # 4. Rename back ``linked_account_id`` → ``account_id``.
    op.alter_column(
        "goals",
        "linked_account_id",
        new_column_name="account_id",
        existing_type=GUID(),
        existing_nullable=True,
    )
