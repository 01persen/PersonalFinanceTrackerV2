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
  and the same ``ON DELETE SET NULL`` semantics. ``ALTER TABLE ...
  RENAME COLUMN`` is portable across SQLite (3.25+) and PostgreSQL —
  Alembic emits the matching syntax on each backend.
* **Make ``current_amount_cents`` nullable.** It was ``NOT NULL DEFAULT 0``
  in the stub; the PRD allows ``NULL`` for goals that derive their
  current amount from the linked account balance (sub-0005-02 owns
  that compute path; here we just relax the constraint so the storage
  layer can stay consistent with the read model). Existing rows keep
  their integer default (``0``) — the relax path doesn't rewrite data.
* **Add new columns**:

  - ``start_date DATE NOT NULL`` (defaulted to ``CURRENT_DATE`` server-side
    for back-fill). Every goal needs a start date; sub-0005-02 auto-picks
    ``today`` if omitted. The migration adds it as nullable first,
    backfills ``CURRENT_DATE`` for any pre-existing rows, then tightens
    to NOT NULL in a second batch — the split is required for SQLite
    portability (see below).
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

SQLite portability (sub-0005-01 carry-over):

SQLite < 3.35.0 cannot run any of these ``ALTER TABLE`` sub-commands
natively:

* ``ALTER COLUMN ... DROP NOT NULL`` (used to relax ``current_amount_cents``)
* ``ALTER COLUMN ... SET NOT NULL`` (used to tighten ``start_date`` after back-fill)
* ``ADD COLUMN ... NOT NULL DEFAULT <non-constant>`` (would have been
  used for the initial ``start_date`` add — that's why we back-fill
  in two passes)
* ``DROP COLUMN`` (used in downgrade to remove every new column)
* ``ALTER TABLE ... RENAME COLUMN`` works natively from 3.25.0 but
  is still routed through the batch recreate here for symmetry with
  the surrounding ops.

Every one of those operations is wrapped in
``op.batch_alter_table("goals", recreate="always")`` so Alembic
forces the table-recreate path: rename ``goals`` to
``_alembic_batch_tmp``, create a fresh ``goals`` with the new
column shape, copy rows over, drop the temp. The pattern is portable
to every SQLite version Alembic supports and PostgreSQL ignores the
``recreate`` hint (it uses regular ``ALTER COLUMN`` on PG).

Reversible: ``downgrade()`` drops the new indexes, runs a single
batch_alter_table that drops the new columns + re-tightens
``current_amount_cents`` + renames ``linked_account_id`` back to
``account_id`` (one recreate, not three), and recreates the original
``ix_goals_user_id`` index. Tested in
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
    # the new column). SQLite 3.25+ supports ``ALTER TABLE ... RENAME COLUMN``
    # natively, so no table-recreate is needed here.
    op.alter_column(
        "goals",
        "account_id",
        new_column_name="linked_account_id",
        existing_type=GUID(),
        existing_nullable=True,
    )

    # 2. Add all new columns + relax ``current_amount_cents`` in one
    # table-recreate cycle.
    #
    # SQLite portability note: SQLite < 3.35.0 cannot run any of:
    #   - ``ALTER COLUMN ... DROP NOT NULL``
    #   - ``ALTER COLUMN ... SET NOT NULL``
    #   - ``ADD COLUMN ... NOT NULL DEFAULT <non-constant>``
    # natively — the only ``ALTER TABLE`` sub-commands SQLite has
    # supported since 3.25.0 are ``RENAME TO`` and ``RENAME COLUMN``;
    # everything else requires the table-recreate trick. The CI image
    # ships an older SQLite, so a naked ``op.alter_column(... nullable=True)``
    # emits DDL that throws ``near "ALTER": syntax error`` — CI flagged
    # this on the first pipeline pass.
    #
    # ``op.batch_alter_table(recreate="always")`` forces the
    # table-recreate path unconditionally — Alembic will: rename the
    # original ``goals`` to ``_alembic_batch_tmp``, create a fresh
    # ``goals`` with the new column shape, copy the rows over, and drop
    # the temp table. It works on every SQLite version Alembic supports,
    # and PostgreSQL's planner ignores the ``recreate`` hint (it uses a
    # regular ``ALTER COLUMN`` on PG).
    #
    # All new columns land as ``nullable=True`` in this batch — even
    # ``start_date``, which the model marks ``NOT NULL`` — because adding
    # a NOT NULL column with a non-constant default (``CURRENT_DATE``) to
    # a table with pre-existing rows is exactly the operation SQLite
    # refuses. We backfill ``start_date`` afterwards and enforce NOT NULL
    # in a second batch.
    with op.batch_alter_table("goals", recreate="always") as batch_op:
        batch_op.alter_column(
            "current_amount_cents",
            existing_type=sa.BigInteger(),
            nullable=True,
        )
        batch_op.add_column(sa.Column("start_date", sa.Date(), nullable=True))
        batch_op.add_column(sa.Column("jangka_waktu_months", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("tabungan_bulanan_cents", sa.BigInteger(), nullable=True))
        batch_op.add_column(sa.Column("monthly_expense_cents", sa.BigInteger(), nullable=True))
        batch_op.add_column(sa.Column("jumlah_tanggungan", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("multiplier", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("lama_mengumpulkan_bulan", sa.Integer(), nullable=True))
        batch_op.add_column(
            sa.Column("target_amount_snapshot_cents", sa.BigInteger(), nullable=True)
        )
        batch_op.add_column(sa.Column("notes", sa.Text(), nullable=True))
        batch_op.add_column(sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True))

    # 3. Backfill ``start_date`` for any pre-existing rows. The model
    # says ``nullable=False`` so every row must have a value; rows that
    # pre-date the migration get today's date (the same value the
    # ``GoalCreate`` route would have defaulted to at insert time).
    op.execute("UPDATE goals SET start_date = CURRENT_DATE WHERE start_date IS NULL")

    # 4. Tighten ``start_date`` → NOT NULL. Same SQLite constraint as
    # above (no ``ALTER COLUMN ... SET NOT NULL``), so we round-trip
    # the table again. Cheap on the empty CI DB; on the production DB
    # (currently 0 goal rows) this is also a no-op-equivalent recreate.
    with op.batch_alter_table("goals", recreate="always") as batch_op:
        batch_op.alter_column(
            "start_date",
            existing_type=sa.Date(),
            nullable=False,
        )

    # 5. Replace the generic ``ix_goals_user_id`` with composite indexes
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

    # 2. Drop the new columns and re-tighten ``current_amount_cents``
    # in one ``batch_alter_table`` so SQLite < 3.35.0 uses the
    # table-recreate path:
    #
    #   * ``DROP COLUMN`` was added in SQLite 3.35.0.
    #   * ``ALTER COLUMN ... SET NOT NULL`` is also a 3.35.0+ feature.
    #
    # The column rename is done *outside* the batch block — ``ALTER TABLE
    # ... RENAME COLUMN`` is supported natively from SQLite 3.25.0, and
    # we hit an Alembic quirk where ``batch_op.alter_column`` with
    # ``new_column_name`` fails on our ``GUID()`` type (a custom
    # ``TypeDecorator`` that doesn't expose ``.name``). Plain
    # ``op.alter_column`` handles the rename correctly on both SQLite
    # and PostgreSQL — keeping it outside the batch costs us nothing
    # and avoids the type-inspection edge case.
    with op.batch_alter_table("goals", recreate="always") as batch_op:
        batch_op.drop_column("archived_at")
        batch_op.drop_column("notes")
        batch_op.drop_column("target_amount_snapshot_cents")
        batch_op.drop_column("lama_mengumpulkan_bulan")
        batch_op.drop_column("multiplier")
        batch_op.drop_column("jumlah_tanggungan")
        batch_op.drop_column("monthly_expense_cents")
        batch_op.drop_column("tabungan_bulanan_cents")
        batch_op.drop_column("jangka_waktu_months")
        batch_op.drop_column("start_date")
        batch_op.alter_column(
            "current_amount_cents",
            existing_type=sa.BigInteger(),
            nullable=False,
        )

    # 3. Rename ``linked_account_id`` back to ``account_id``. SQLite
    # 3.25+ does this natively (no batch needed); PostgreSQL emits a
    # regular ``ALTER COLUMN RENAME``. Keeps the column rename out of
    # the batch recreate so we get one ``_alembic_batch_tmp`` round-trip
    # for the heavy lifting instead of two.
    op.alter_column(
        "goals",
        "linked_account_id",
        new_column_name="account_id",
        existing_type=GUID(),
        existing_nullable=True,
    )
