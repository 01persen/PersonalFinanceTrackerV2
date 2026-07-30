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

import sqlalchemy as sa
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


def _current_rule_version(bind: object) -> dict[str, str]:
    """Return a ``{user_id_str: rule_version_hash}`` map for the active rule set.

    The hash is stable across reruns for the same rule set, so the
    migration can detect "rules haven't changed since the last
    apply" and skip the pass entirely. ``user_id`` is normalised
    to its string form so the lookup matches the raw
    ``SELECT DISTINCT user_id`` row above (which returns ``str``
    on SQLite, ``uuid.UUID`` on Postgres — both stringify the
    same way for storage).

    QA defect #1c root cause: a previous revision keyed this map
    by the raw ``CategoryRule.user_id`` (a ``UUID`` instance) but
    compared against the raw-SQL result which returned ``str``,
    so ``.get()`` always missed and the apply pass was silently
    skipped for every user. The migration committed successfully,
    the data directory was left untouched, and the audit log had
    zero rows — the kind of bug that's invisible until you look
    for it.
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
    by_user: dict[str, list[tuple[object, ...]]] = {}
    for row in rows:
        by_user.setdefault(str(row.user_id), []).append(
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

    # QA retest #2 defect #1c (round 2): the ``origin_tag`` column
    # is referenced below in the ``SELECT ... FROM rule_audit_log``
    # idempotency query, but the column is also part of the
    # follow-up migration ``b2c4d6e8f0a4``'s ``add_column``. If
    # we waited for that migration, this upgrade would crash on
    # any database with prior data — ``no such column: origin_tag``.
    # Add the column here so the SELECT below sees a defined schema,
    # and skip the same ``add_column`` in ``b2c4d6e8f0a4``'s upgrade
    # to avoid an ALTER-TABLE error on second touch.
    op.add_column(
        "rule_audit_log",
        sa.Column("origin_tag", sa.String(length=64), nullable=True),
    )

    # Discover the user set without dragging the ORM mapper; the data
    # migration is a one-shot pass and a raw ``text()`` query keeps the
    # path portable to both Postgres + SQLite. Normalise to ``str``
    # so the rule_version lookup matches the format used by
    # ``_current_rule_version``.
    user_ids = [
        str(uid)
        for uid in bind.execute(
            text(
                "SELECT DISTINCT user_id FROM transactions WHERE deleted_at IS NULL"
            )
        ).scalars()
    ]

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
    """Reverse the schema change but keep the audit trail.

    The ``origin_tag`` column is dropped on downgrade (it was
    added in ``upgrade`` above so the idempotency query could see
    it). Audit rows written by the backfill are intentionally
    preserved — they're the audit trail that downstream analytics
    + QA depend on, and hard reversal of the categorisation would
    need a separate ticket that explicitly scopes which tenants /
    rule versions to revert.
    """
    op.drop_column("rule_audit_log", "origin_tag")
