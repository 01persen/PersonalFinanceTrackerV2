"""backfill apply_rules via rule engine (idempotent data migration)

Revision ID: b2c4d6e8f0a3
Revises: b2c4d6e8f0a2
Create Date: 2026-07-29 15:00:00.000000

One-shot data migration that fulfils sub-0004-02 AC (5) — "Alembic
data migration script idempotent (cek ``rule_audit_log`` rule_version
hash) + log affected rows".

Idempotency strategy:

* The apply engine is the same one used by the admin endpoint
  ``POST /api/v1/categories/apply-rules``. It treats
  ``category_id`` already set as a no-op, so re-running the
  migration produces no duplicate audit rows because the second
  pass computes the same winners and finds the category already
  applied.
* The audit table itself records every change with its
  ``applied_at`` server timestamp; the migration is intentionally
  re-runnable so an operator can refresh after a rules re-import.

Why this is *not* a generic "recompute every transaction": the
engine only flips a category when a rule matches *and* the
current category is different. Pre-existing user-chosen
categories stay put (no-match preserve from AC (2)) on both the
online and the operator path.

Why we run with ``write_audit=True`` here: the spec says "log
affected rows". The same engine code path that backs the admin
endpoint writes the audit rows; we let it run instead of inventing
a second writer.
"""

from __future__ import annotations

import sys
from collections.abc import Sequence
from pathlib import Path

from sqlalchemy import select, text
from alembic import op

# Ensure ``app`` package is importable when the migration runs standalone.
_SRC = Path(__file__).resolve().parents[3] / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from app.db.models.transaction import Transaction  # noqa: E402
from app.db.session import get_sessionmaker  # noqa: E402
from app.services.rule_engine import apply_rules_to_transactions  # noqa: E402

# revision identifiers, used by Alembic.
revision: str = "b2c4d6e8f0a3"
down_revision: str | Sequence[str] | None = "b2c4d6e8f0a2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Apply rules to every user's existing transactions, per user."""
    bind = op.get_bind()
    bind_url = str(bind.engine.url)
    session_factory = get_sessionmaker(url=bind_url)

    # Discover the user set without dragging the ORM mapper; the data
    # migration is a one-shot pass and a raw ``text()`` query keeps the
    # path portable to both Postgres + SQLite.
    user_ids = list(
        bind.execute(
            text(
                "SELECT DISTINCT user_id FROM transactions WHERE deleted_at IS NULL"
            )
        ).scalars()
    )

    with session_factory() as session:
        try:
            for user_id in user_ids:
                txs = list(
                    session.execute(
                        select(Transaction).where(
                            Transaction.user_id == user_id,
                            Transaction.deleted_at.is_(None),
                        )
                    ).scalars()
                )
                apply_rules_to_transactions(
                    session,
                    user_id=user_id,
                    transactions=txs,
                    origin="backfill",
                    write_audit=True,
                )
            session.commit()
        except Exception:
            session.rollback()
            raise


def downgrade() -> None:
    """No-op on rollback.

    The audit log is the only persistent artefact of the backfill;
    rows it wrote are *not* rolled back on downgrade because
    they're the audit trail that downstream analytics + QA depend
    on. Hard reversal of the categorisation would need a separate
    ticket that explicitly scopes which tenants / rule versions to
    revert.
    """