"""add transactions transfer_group_id for paired transfers

Revision ID: a1f7c8e2b4d9
Revises: 8a7b1c2d3e4f
Create Date: 2026-07-28 12:10:00.000000

Adds a nullable ``transfer_group_id`` column on ``transactions`` so the
paired ``POST /transactions/transfer`` flow (sub-0003-03) can group the
two legs of a single transfer under the same identifier. Both rows of a
pair share the same ``transfer_pair_id`` and the same ``transfer_group_id``
— the pair id is the exact link between the two legs, while the group id
is reserved for future batched/grouped transfers (e.g. multi-leg splits)
and mirrors the pair id for the current 2-row MVP.

Existing rows get ``NULL`` (no transfer leg) via the default; no backfill
is required because the column is informational and the saldo engine
does not depend on it.
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
revision: str = "a1f7c8e2b4d9"
down_revision: str | Sequence[str] | None = "8a7b1c2d3e4f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add ``transfer_group_id`` column + index on ``transactions``."""
    op.add_column(
        "transactions",
        sa.Column("transfer_group_id", GUID(), nullable=True),
    )
    op.create_index(
        op.f("ix_transactions_transfer_group_id"),
        "transactions",
        ["transfer_group_id"],
        unique=False,
    )


def downgrade() -> None:
    """Drop the index and the ``transfer_group_id`` column."""
    op.drop_index(op.f("ix_transactions_transfer_group_id"), table_name="transactions")
    op.drop_column("transactions", "transfer_group_id")
