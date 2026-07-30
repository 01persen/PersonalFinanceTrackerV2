"""transactions search indexes (sub-0004-03)

Revision ID: b2c4d6e8f0a5
Revises: b2c4d6e8f0a4
Create Date: 2026-07-30 10:30:00.000000

Adds the index design called out in sub-0004-03 AC (6) so the search
endpoint ``GET /api/v1/transactions/search`` can meet its **p95 < 500 ms
for 5.000 transaksi** target on PostgreSQL. The composite columns are
chosen so each individual search filter (``account_id``, ``category_id``,
``type``, ``amount_min_cents``/``amount_max_cents``) can be served by an
index that also respects the mandatory ``user_id`` predicate and the
mandatory ``occurred_on DESC`` ordering.

New indexes:

* ``ix_transactions_user_account_occurred_on``
  ``(user_id, account_id, occurred_on DESC)`` — drives
  ``account_id`` + date-range searches.
* ``ix_transactions_user_category_occurred_on``
  ``(user_id, category_id, occurred_on DESC)`` — drives
  ``category_id`` + date-range searches (NULL category is fine —
  PG + SQLite both store NULL in the index so ``category_id IS NULL``
  predicates can use it).
* ``ix_transactions_user_occurred_on_type``
  ``(user_id, occurred_on DESC, type)`` — drives ``type`` + date-range
  searches. ``occurred_on`` leads the trailing columns so the index can
  still serve the no-``type`` case.
* ``ix_transactions_user_occurred_on_amount``
  ``(user_id, occurred_on DESC, amount_cents)`` — drives
  ``amount_min_cents``/``amount_max_cents`` + date-range searches
  (PostgreSQL can range-scan a leading equality + range column).
* Trigram GIN index on ``note`` for substring search. We rely on
  ``pg_trgm`` (PG-only extension) so we gate the extension +
  GIN-trigram creation on a PostgreSQL dialect. SQLite falls back to
  a plain B-tree on ``note`` so the index assertion in
  ``test_migrations.py`` can find a deterministic index name, even
  though the LIKE-with-leading-wildcard search plan on SQLite still
  scans (acceptable — SQLite is the test backend only, perf budget is
  measured against PG in the bench script).

Pre-existing indexes (``ix_transactions_account_occurred_on`` etc.) are
left untouched — they still serve the non-user-scoped balance engine
queries that join ``accounts`` to ``transactions``.

Reversible: downgrade drops every new index (and the PG extension
uninstall is intentionally *not* attempted — dropping extensions is
risky in shared environments and the ``pg_trgm`` extension is shared
by other tenants in the database).
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
revision: str = "b2c4d6e8f0a5"
down_revision: str | Sequence[str] | None = "b2c4d6e8f0a4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    dialect_name = bind.dialect.name

    # Composite indexes — portable across SQLite + PostgreSQL.
    # DESC direction is honoured by PostgreSQL; SQLite ignores the
    # marker and stores columns ascending on disk (functionally
    # equivalent for the search endpoint's forward scan from the
    # newest ``occurred_on``).
    op.create_index(
        "ix_transactions_user_account_occurred_on",
        "transactions",
        ["user_id", "account_id", sa.text("occurred_on DESC")],
    )
    op.create_index(
        "ix_transactions_user_category_occurred_on",
        "transactions",
        ["user_id", "category_id", sa.text("occurred_on DESC")],
    )
    op.create_index(
        "ix_transactions_user_occurred_on_type",
        "transactions",
        ["user_id", sa.text("occurred_on DESC"), "type"],
    )
    op.create_index(
        "ix_transactions_user_occurred_on_amount",
        "transactions",
        ["user_id", sa.text("occurred_on DESC"), "amount_cents"],
    )

    # Trigram index on ``note`` — PG-only.
    if dialect_name == "postgresql":
        # ``IF NOT EXISTS`` keeps the migration idempotent against a
        # PG instance where ``pg_trgm`` is already loaded by an
        # earlier migration or by the hosting platform.
        op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
        op.execute(
            "CREATE INDEX ix_transactions_note_trgm "
            "ON transactions USING GIN (note gin_trgm_ops)"
        )
    else:
        # SQLite fallback: a plain B-tree on ``note``. It won't help
        # a leading-wildcard ``LIKE`` (the test backend does not
        # need to hit the perf budget — that's measured against PG
        # in the bench script) but the index name stays stable so
        # ``test_migrations.EXPECTED_INDEXES`` can assert on it.
        op.create_index(
            "ix_transactions_note_trgm",
            "transactions",
            ["note"],
        )


def downgrade() -> None:
    bind = op.get_bind()
    dialect_name = bind.dialect.name

    # Drop the note index first — symmetric with the upgrade order.
    if dialect_name == "postgresql":
        op.execute("DROP INDEX IF EXISTS ix_transactions_note_trgm")
        # Note: we intentionally do NOT ``DROP EXTENSION pg_trgm``
        # — extensions are shared by other tenants in the database
        # and removing them is a risky operation that would
        # accidentally impact unrelated schemas.
    else:
        op.drop_index("ix_transactions_note_trgm", table_name="transactions")

    op.drop_index(
        "ix_transactions_user_occurred_on_amount", table_name="transactions"
    )
    op.drop_index(
        "ix_transactions_user_occurred_on_type", table_name="transactions"
    )
    op.drop_index(
        "ix_transactions_user_category_occurred_on", table_name="transactions"
    )
    op.drop_index(
        "ix_transactions_user_account_occurred_on", table_name="transactions"
    )
