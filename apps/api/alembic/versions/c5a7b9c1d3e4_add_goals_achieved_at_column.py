"""add goals.achieved_at column (sub-0005-02)

Revision ID: c5a7b9c1d3e4
Revises: f5a6b7c8d9e0
Create Date: 2026-07-31 20:00:00.000000

Goal Trackers (epic-0005, sub-0005-02). The goal-engine needs a
``persisted`` flag for "this goal first crossed 100%" so the FE can
badge achieved goals on a cache miss and the progress endpoint
doesn't have to write to the DB on every read.

The column is the *first time* the goal reached ``percentage >= 100``,
not the most recent crossing; the same goal that subsequently dips
back below 100 (e.g. the user withdraws from the linked account)
still shows the original achievement timestamp. Idempotent: a goal
that's already ``achieved_at`` is left alone by the recompute hook.

Schema changes:

* Add ``achieved_at TIMESTAMP NULL`` (timezone-aware) on ``goals``.

Reversible: ``downgrade()`` drops the column.

SQLite portability: same constraints as the previous goals migration
(SQLite < 3.35.0 cannot ``ALTER TABLE ... ADD COLUMN ... NOT NULL`` or
``DROP COLUMN`` natively). ``op.batch_alter_table(recreate="always")``
forces the table-recreate path so the column add lands on every
SQLite version Alembic supports; PostgreSQL uses a regular
``ADD COLUMN`` and ignores the ``recreate`` hint.

Tested in ``tests/test_migrations.py::test_goals_achieved_at_column_roundtrip``.
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


# revision identifiers, used by Alembic.
revision: str = "c5a7b9c1d3e4"
down_revision: str | Sequence[str] | None = "f5a6b7c8d9e0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add nullable ``achieved_at`` to the ``goals`` table."""
    # SQLite < 3.35.0 cannot run ``ADD COLUMN`` on a column declared
    # with a server-side default + NOT NULL natively, and this codebase
    # uses the batch-recreate path everywhere for safety. The column
    # is nullable so there's no integrity check; recreating is just
    # here so a downgrade can drop it without dialect-specific DDL
    # branching. PostgreSQL ignores ``recreate`` and emits a regular
    # ``ADD COLUMN``.
    with op.batch_alter_table("goals", recreate="always") as batch_op:
        batch_op.add_column(
            sa.Column("achieved_at", sa.DateTime(timezone=True), nullable=True)
        )


def downgrade() -> None:
    """Drop the ``achieved_at`` column added in :func:`upgrade`."""
    with op.batch_alter_table("goals", recreate="always") as batch_op:
        batch_op.drop_column("achieved_at")
