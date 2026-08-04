"""add debt_payments.source_account_id (sub-0006-02)

Revision ID: b2c4d6e8f0a6
Revises: d6e8f0a1b2c3
Create Date: 2026-08-03 14:00:00.000000

Debt Tracker (epic-0006, sub-0006-02). The initial
``debt_payments`` schema (revision ``cd96a512ab4a``) tracked the
principal / interest split of every cicilan but did not record which
account funded the payment. The epic detail doc adds ``source_account_id``
(nullable FK to ``accounts.id``) so the FE can show *which* saldo the
cicilan came out of and so post-MVP analytics can aggregate cash
outflow per account.

Schema changes:

* Add ``source_account_id`` column to ``debt_payments``:

  - ``GUID()`` (matches the cross-dialect PK column used on every
    other FK in this DB).
  - ``nullable=True`` — a payment can be cash-in-hand with no linked
    account; the spec explicitly carves out the "source account
    nullable" case as in-scope.
  - ``ON DELETE SET NULL`` — if the user archives / hard-deletes the
    source account, the historical payment row stays in place (audit
    trail integrity) and the FK is nulled out. Same semantics as
    ``goals.linked_account_id`` (sub-0005-01).

* Add ``ix_debt_payments_source_account_id`` index so post-MVP
  per-account payment aggregations are cheap. Mirrors the
  ``ix_debt_payments_debt_id`` index from the initial schema.

SQLite portability: SQLite < 3.35.0 cannot add a column with a foreign
key constraint in a single ``ALTER TABLE`` statement; the FK has to
be defined as part of the new table shape. ``batch_alter_table`` with
``recreate="always"`` forces the table-recreate path so both the
column add and the FK constraint land on every SQLite version Alembic
supports; PostgreSQL ignores the ``recreate`` hint and uses a regular
``ADD COLUMN`` + ``ADD CONSTRAINT``.

Reversible: ``downgrade()`` drops the index + FK + column in one
``batch_alter_table`` so the round-trip is portable across the same
SQLite range.

Tested in ``tests/test_migrations.py::test_debt_payments_source_account_roundtrip``.
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
revision: str = "b2c4d6e8f0a6"
down_revision: str | Sequence[str] | None = "d6e8f0a1b2c3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add ``source_account_id`` (nullable FK to ``accounts.id``) to ``debt_payments``."""
    with op.batch_alter_table("debt_payments", recreate="always") as batch_op:
        batch_op.add_column(
            sa.Column("source_account_id", GUID(), nullable=True)
        )
        batch_op.create_foreign_key(
            op.f("fk_debt_payments_source_account_id_accounts"),
            "accounts",
            ["source_account_id"],
            ["id"],
            ondelete="SET NULL",
        )
        batch_op.create_index(
            op.f("ix_debt_payments_source_account_id"),
            ["source_account_id"],
            unique=False,
        )


def downgrade() -> None:
    """Drop the ``source_account_id`` column + index + FK added in :func:`upgrade`."""
    with op.batch_alter_table("debt_payments", recreate="always") as batch_op:
        batch_op.drop_index(op.f("ix_debt_payments_source_account_id"))
        batch_op.drop_constraint(
            op.f("fk_debt_payments_source_account_id_accounts"),
            type_="foreignkey",
        )
        batch_op.drop_column("source_account_id")
