"""add transactions deleted_at for soft delete

Revision ID: e29955254062
Revises: 8a7b1c2d3e4f
Create Date: 2026-07-28 11:46:19.846090

Adds a nullable ``deleted_at`` column on ``transactions`` so the API can
soft-delete rows (sub-0003-02) without losing the audit trail. Existing
rows get ``NULL`` (treated as "not deleted") via the default; the
``ix_transactions_user_deleted_at`` index keeps the active-rows filter
("``deleted_at IS NULL``") cheap for the list endpoint and the aggregator
in sub-0003-04.
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
revision: str = "e29955254062"
down_revision: str | Sequence[str] | None = "8a7b1c2d3e4f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add ``deleted_at`` column + index on ``transactions``."""
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
