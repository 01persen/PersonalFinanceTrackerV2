"""add categories archived_at + icon + composite index

Revision ID: b2c4d6e8f0a1
Revises: a1f7c8e2b4d9
Create Date: 2026-07-29 12:00:00.000000

Adds the soft-delete machinery the categories CRUD endpoints (sub-0004-01)
need:

* ``archived_at`` — server-side tombstone timestamp. The DELETE and the
  explicit ``POST /categories/{id}/archive`` endpoints set this to
  ``CURRENT_TIMESTAMP``; the default list endpoint filters on
  ``archived_at IS NULL`` so archived rows never surface.
* ``icon`` — optional short string (up to 64 chars) for the FE to render
  a category glyph next to the row. Optional because not every user
  uses the icon slot — it stays nullable.
* Composite index ``ix_categories_user_kind_archived_at`` on
  ``(user_id, kind, archived_at)`` — keeps the active-rows filter
  (``WHERE user_id = ? AND kind = ? AND archived_at IS NULL``) cheap for
  the list endpoint and any future kind-scoped aggregations the FE
  builds on top of the tree.

The ``archived`` boolean column stays as a derived flag (kept in sync
with ``archived_at`` by the API layer) so the existing seed helpers
that filter on ``Category.archived.is_(False)`` keep working without a
backfill — they co-exist with the new timestamp filter.

Existing rows get ``NULL`` for both new columns; no backfill is required
because the timestamp defaults to "not archived" and ``icon`` is purely
informational.
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
revision: str = "b2c4d6e8f0a1"
down_revision: str | Sequence[str] | None = "a1f7c8e2b4d9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add ``archived_at`` + ``icon`` columns and the composite index."""
    op.add_column(
        "categories",
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "categories",
        sa.Column("icon", sa.String(length=64), nullable=True),
    )
    op.create_index(
        op.f("ix_categories_user_kind_archived_at"),
        "categories",
        ["user_id", "kind", "archived_at"],
        unique=False,
    )


def downgrade() -> None:
    """Drop the composite index and the new columns."""
    op.drop_index(
        op.f("ix_categories_user_kind_archived_at"), table_name="categories"
    )
    op.drop_column("categories", "icon")
    op.drop_column("categories", "archived_at")
