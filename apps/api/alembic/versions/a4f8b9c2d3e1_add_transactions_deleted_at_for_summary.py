"""add transactions deleted_at + ix_transactions_user_deleted_at

Revision ID: a4f8b9c2d3e1
Revises: 8a7b1c2d3e4f
Create Date: 2026-07-28 12:00:00.000000

Adds the ``deleted_at`` nullable timestamptz column on ``transactions``
plus a composite ``(user_id, deleted_at)`` index. The column lets
sub-0003-02 soft-delete rows without losing the audit trail, and the
index keeps the active-rows filter (``deleted_at IS NULL``) cheap for
both the list endpoint and the summary aggregator added in
sub-0003-04.

Existing rows receive ``NULL`` (treated as "not deleted") via the column
default — the API's behaviour on a never-deleted row is unchanged.

Note: this migration is parallel to ``e29955254062`` shipped in
sub-0003-02. Both branches (sub-0003-02 and sub-0003-04) are adding the
same column during Stage 2 of epic-0003, so the CI/CD merge step on
``release/epic-0003`` will need to keep one of them and drop the other,
or rewrite the surviving migration as an alembic merge branch. The
operational effect is identical: a nullable ``deleted_at`` column and
the ``ix_transactions_user_deleted_at`` index.
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
revision: str = "a4f8b9c2d3e1"
down_revision: str | Sequence[str] | None = "8a7b1c2d3e4f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add ``deleted_at`` column + composite index on ``transactions``."""
    op.add_column(
        "transactions",
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        op.f("ix_transactions_user_deleted_at"),
        "transactions",
        ["user_id", "deleted_at"],
        unique=False,
    )


def downgrade() -> None:
    """Drop the index and the ``deleted_at`` column."""
    op.drop_index(op.f("ix_transactions_user_deleted_at"), table_name="transactions")
    op.drop_column("transactions", "deleted_at")