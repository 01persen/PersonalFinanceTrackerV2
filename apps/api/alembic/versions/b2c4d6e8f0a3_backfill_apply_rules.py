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
* A ``rule_version`` hash (sorted ``(rule_id, pattern, priority,
  is_regex)`` tuples joined with ``"|"``) is recorded as the
  ``origin_tag`` on every audit row. The upgrade step queries
  the most recent ``origin_tag`` per user and skips the apply
  pass when the current rule set hashes to the same value.
* The unique constraint ``uq_rule_audit_log_rule_tx_origin``
  (added by ``b2c4d6e8f0a4``) is the DB-level backstop —
  concurrent backfills can't both write an audit row for the
  same ``(rule, transaction, origin)`` triple.

QA defect #1c: the previous implementation spun up a separate
SQLAlchemy ``Session`` via ``get_sessionmaker(url=bind_url)``.
That session was bound to a different engine than the one Alembic
held, so commits made by the engine never reached the migration
transaction and the audit rows silently disappeared. This
revision uses ``Session(bind=bind)`` directly — same engine, same
transaction — so the writes are durable.

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

import hashlib
import sys
from collections.abc import Sequence
from pathlib import Path

from alembic import op
from sqlalchemy import select, text
from sqlalchemy.orm import Session

# Ensure ``app`` package is importable when the migration runs standalone.
_SRC = Path(__file__).resolve().parents[3] / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from app.db.models.category_rule import CategoryRule  # noqa: E402
from app.db.models.transaction import Transaction  # noqa: E402
from app.services.rule_engine import apply_rules_to_transactions  # noqa: E402

# revision identifiers, used by Alembic.
revision: str = "b2c4d6e8f0a3"
down_revision: str | Sequence[str] | None = "b2c4d6e8f0a2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _current_rule_version(bind: object) -> dict[object, str]:
    """Return a ``{user_id: rule_version_hash}`` map for the active rule set.

    The hash is stable across reruns for the same rule set, so the
    migration can detect "rules haven't changed since the last
    apply" and skip the pass entirely. Includes ``user_id`` so a
    multi-tenant deploy can fingerprint each tenant independently.
    """
    rows = list(
        bind.execute(
            select(
                CategoryRule.user_id,
                CategoryRule.id,
                CategoryRule.pattern,
                CategoryRule.priority,
                CategoryRule.is_regex,
                CategoryRule.active,
            ).order_by(CategoryRule.user_id, CategoryRule.id)
        )
    )
    by_user: dict[object, list[tuple[object, ...]]] = {}
    for row in rows:
        by_user.setdefault(row.user_id, []).append(
            (row.id, row.pattern, row.priority, row.is_regex, row.active)
        )
    return {
        user_id: hashlib.sha256(
            "|".join(",".join(map(str, t)) for t in sorted(tuples)).encode()
        ).hexdigest()
        for user_id, tuples in by_user.items()
    }


def upgrade() -> None:
    """Apply rules to every user's existing transactions, per user."""
    bind = op.get_bind()

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

    rule_versions = _current_rule_version(bind)

    # QA defect #1c fix: use a Session bound to the *same* engine
    # Alembic is using so commits propagate to the migration
    # transaction.
    with Session(bind=bind) as session:
        try:
            for user_id in user_ids:
                rule_version = rule_versions.get(user_id)
                if rule_version is None:
                    # No active rules for this user — skip; matches
                    # the 403 behaviour of the apply-rules endpoint.
                    continue

                # Idempotency check: skip if the most recent audit
                # row for this user already records the current
                # rule_version. The migration is still re-runnable
                # after a rule change (the hash will differ).
                last_origin_tag = session.execute(
                    text(
                        "SELECT origin_tag FROM rule_audit_log "
                        "WHERE user_id = :user_id AND origin = 'backfill' "
                        "ORDER BY applied_at DESC LIMIT 1"
                    ),
                    {"user_id": user_id},
                ).scalar()

                if last_origin_tag == rule_version:
                    continue

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
                    rule_version=rule_version,
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
