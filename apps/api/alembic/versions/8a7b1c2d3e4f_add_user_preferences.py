"""add user_preferences

Revision ID: 8a7b1c2d3e4f
Revises: cd96a512ab4a
Create Date: 2026-07-26 21:00:00.000000

"""

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
revision: str = "8a7b1c2d3e4f"
down_revision: str | Sequence[str] | None = "cd96a512ab4a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add the single-row-per-user preferences table (locale, currency, EF, etc.)."""
    op.create_table(
        "user_preferences",
        sa.Column("locale", sa.String(length=10), nullable=False, server_default="id-ID"),
        sa.Column("currency", sa.String(length=3), nullable=False, server_default="IDR"),
        sa.Column(
            "emergency_fund_multiplier",
            sa.Integer(),
            nullable=False,
            server_default="3",
        ),
        sa.Column(
            "dependents_count",
            sa.Integer(),
            nullable=False,
            server_default="1",
        ),
        sa.Column("theme", sa.String(length=16), nullable=False, server_default="system"),
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
            ["user_id"],
            ["users.id"],
            name=op.f("fk_user_preferences_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_user_preferences")),
        sa.UniqueConstraint("user_id", name=op.f("uq_user_preferences_user_id")),
    )
    op.create_index(
        op.f("ix_user_preferences_user_id"),
        "user_preferences",
        ["user_id"],
        unique=False,
    )


def downgrade() -> None:
    """Drop the preferences table."""
    op.drop_index(op.f("ix_user_preferences_user_id"), table_name="user_preferences")
    op.drop_table("user_preferences")
