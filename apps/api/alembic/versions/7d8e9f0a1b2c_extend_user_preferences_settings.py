"""extend user_preferences with week_start, display_name, version

Revision ID: 7d8e9f0a1b2c
Revises: b2c4d6e8f0a6
Create Date: 2026-08-05 05:00:00.000000

Settings (epic-0008, sub-0008-03). The initial ``user_preferences``
schema (revision ``8a7b1c2d3e4f``) covered the minimal preferences
the FE needed at registration — locale, currency, EF multiplier,
dependents, theme. The epic-0008 settings spec adds three more
columns:

* ``week_start`` — String(16), NOT NULL, default ``"senin"``. The
  enum whitelist (senin, selasa, rabu, kamis, jumat, sabtu, minggu)
  is enforced at the API layer via Pydantic so the DB column stays
  a short string for forward compatibility (an enum constraint
  would block a future addition without a migration).
* ``display_name`` — String(100), NULL. Optional profile nickname
  shown on the FE settings page; nullable because a brand-new user
  may not have set one yet. Length cap mirrors the Pydantic
  ``max_length=100`` on the request schema.
* ``version`` — Integer, NOT NULL, default ``1``. Optimistic
  concurrency token for the ``GET/PATCH /settings`` cycle: every
  PATCH that commits a write bumps the column by one, and clients
  must echo the current ``version`` in the ``If-Match`` header —
  a stale echo returns ``412 Precondition Failed``. The value is
  exposed on the wire as the response body field ``version: int``
  and on the response header ``ETag: "<version>"``.

Schema changes:

* Add ``week_start``: server default ``"senin"`` backfills existing
  rows so the migration is safe on a populated DB.
* Add ``display_name``: nullable, no default.
* Add ``version``: server default ``1`` backfills existing rows.

SQLite portability: simple ``ADD COLUMN`` with a server default
portable to all SQLite versions Alembic supports, no
``batch_alter_table`` needed because these are scalar columns
(no FK / CHECK).

Reversible: ``downgrade()`` drops the three columns in one
``batch_alter_table`` so the round-trip is portable across the
same SQLite range.

Tested in ``tests/test_migrations.py::test_user_preferences_settings_columns_roundtrip``.
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
revision: str = "7d8e9f0a1b2c"
down_revision: str | Sequence[str] | None = "b2c4d6e8f0a6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Extend ``user_preferences`` with the epic-0008 settings columns."""
    with op.batch_alter_table("user_preferences", recreate="always") as batch_op:
        batch_op.add_column(
            sa.Column(
                "week_start",
                sa.String(length=16),
                nullable=False,
                server_default="senin",
            )
        )
        batch_op.add_column(sa.Column("display_name", sa.String(length=100), nullable=True))
        batch_op.add_column(sa.Column("version", sa.Integer(), nullable=False, server_default="1"))


def downgrade() -> None:
    """Drop the three settings columns added in :func:`upgrade`."""
    with op.batch_alter_table("user_preferences", recreate="always") as batch_op:
        batch_op.drop_column("version")
        batch_op.drop_column("display_name")
        batch_op.drop_column("week_start")
