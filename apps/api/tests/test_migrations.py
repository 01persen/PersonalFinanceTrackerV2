"""Alembic migration smoke tests.

Runs the actual ``alembic upgrade head`` against a throwaway SQLite file and
checks every expected table (and a couple of indexes) are present. Then
exercises ``alembic downgrade base`` to confirm reversibility.
"""

from __future__ import annotations

import os
import sqlite3
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
API_ROOT = Path(__file__).resolve().parents[1]

EXPECTED_TABLES = {
    "users",
    "accounts",
    "categories",
    "transactions",
    "category_rules",
    "goals",
    "debts",
    "debt_payments",
    "user_preferences",
    "rule_audit_log",
}

EXPECTED_INDEXES = {
    ("users", "ix_users_email"),
    ("transactions", "ix_transactions_user_occurred_on"),
    ("transactions", "ix_transactions_account_occurred_on"),
    ("transactions", "ix_transactions_category"),
    ("transactions", "ix_transactions_user_deleted_at"),
    ("transactions", "ix_transactions_transfer_group_id"),
    # sub-0004-03 — search endpoint index design (migration f0a5).
    ("transactions", "ix_transactions_user_account_occurred_on"),
    ("transactions", "ix_transactions_user_category_occurred_on"),
    ("transactions", "ix_transactions_user_occurred_on_type"),
    ("transactions", "ix_transactions_user_occurred_on_amount"),
    ("transactions", "ix_transactions_note_trgm"),
    ("accounts", "ix_accounts_user_id"),
    ("categories", "ix_categories_user_id"),
    ("categories", "ix_categories_user_kind_archived_at"),
    ("category_rules", "ix_category_rules_user_id"),
    ("category_rules", "ix_category_rules_user_priority_active"),
    ("debts", "ix_debts_user_id"),
    # sub-0005-01 — goal CRUD index design (migration f5a6). The original
    # ``ix_goals_user_id`` is dropped in favour of the composite indexes
    # that drive the list endpoint's filters.
    ("goals", "ix_goals_user_id_kind"),
    ("goals", "ix_goals_user_id_archived_at"),
    ("goals", "ix_goals_linked_account_id"),
    ("debt_payments", "ix_debt_payments_debt_id"),
    ("rule_audit_log", "ix_rule_audit_log_user_applied_at"),
    ("rule_audit_log", "ix_rule_audit_log_rule_applied_at"),
    ("rule_audit_log", "ix_rule_audit_log_transaction"),
    ("user_preferences", "ix_user_preferences_user_id"),
}


def _run_alembic(db_path: Path, *args: str) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["ALEMBIC_DATABASE_URL"] = f"sqlite:///{db_path}"
    return subprocess.run(
        ["uv", "run", "alembic", *args],
        cwd=API_ROOT,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )


@pytest.fixture()
def sqlite_db(tmp_path: Path) -> Path:
    db = tmp_path / "migration_test.db"
    if db.exists():
        db.unlink()
    yield db
    if db.exists():
        db.unlink()


def _table_names(db_path: Path) -> set[str]:
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'alembic%'"
        ).fetchall()
        return {r[0] for r in rows}
    finally:
        conn.close()


def _index_names(db_path: Path) -> set[tuple[str, str]]:
    conn = sqlite3.connect(db_path)
    try:
        out: set[tuple[str, str]] = set()
        for (tbl,) in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'alembic%'"
        ):
            for row in conn.execute(f"PRAGMA index_list({tbl})"):
                idx_name = row[1]
                if idx_name.startswith("sqlite_autoindex_"):
                    continue
                out.add((tbl, idx_name))
        return out
    finally:
        conn.close()


def test_upgrade_creates_all_tables(sqlite_db: Path) -> None:
    result = _run_alembic(sqlite_db, "upgrade", "head")
    assert result.returncode == 0, result.stderr or result.stdout

    tables = _table_names(sqlite_db)
    missing = EXPECTED_TABLES - tables
    assert not missing, f"missing tables after upgrade: {missing}"

    indexes = _index_names(sqlite_db)
    missing_idx = EXPECTED_INDEXES - indexes
    assert not missing_idx, f"missing indexes after upgrade: {missing_idx}"


def test_downgrade_is_reversible(sqlite_db: Path) -> None:
    up = _run_alembic(sqlite_db, "upgrade", "head")
    assert up.returncode == 0, up.stderr or up.stdout

    down = _run_alembic(sqlite_db, "downgrade", "base")
    assert down.returncode == 0, down.stderr or down.stdout

    assert _table_names(sqlite_db) == set(), "tables still present after downgrade base"


def test_upgrade_is_replayable(sqlite_db: Path) -> None:
    """Apply → downgrade → re-apply → still idempotent at the table layer."""
    assert _run_alembic(sqlite_db, "upgrade", "head").returncode == 0
    assert _run_alembic(sqlite_db, "downgrade", "base").returncode == 0
    assert _run_alembic(sqlite_db, "upgrade", "head").returncode == 0

    tables = _table_names(sqlite_db)
    assert EXPECTED_TABLES.issubset(tables)


def test_users_email_is_unique(sqlite_db: Path) -> None:
    _run_alembic(sqlite_db, "upgrade", "head")
    conn = sqlite3.connect(sqlite_db)
    try:
        idx_rows = conn.execute("PRAGMA index_list(users)").fetchall()
        # PRAGMA index_list columns: seq, name, unique, origin, partial
        unique_idx_names = [row[1] for row in idx_rows if row[2] == 1]
        assert "ix_users_email" in unique_idx_names
    finally:
        conn.close()


def test_backfill_migration_with_prior_data_does_not_crash(sqlite_db: Path) -> None:
    """QA retest #2 defect #1c regression: ``b2c4d6e8f0a3`` backfill
    migration must not raise ``no such column: origin_tag`` when
    upgrading over a database that already has data at f0a1.

    The original split — ``origin_tag`` added in f0a4, queried in
    f0a3 — meant any upgrade over prior data crashed because
    f0a3's idempotency ``SELECT`` referenced a column the
    backfill didn't add yet. The fix moves the
    ``op.add_column("origin_tag", ...)`` to the top of
    ``b2c4d6e8f0a3`` upgrade; f0a4 keeps the unique index but
    skips the now-redundant column addition.
    """
    # Bring the DB up to f0a1 (the state right before backfill
    # migrations started).
    up_to_f0a1 = _run_alembic(sqlite_db, "upgrade", "b2c4d6e8f0a1")
    assert up_to_f0a1.returncode == 0, up_to_f0a1.stderr or up_to_f0a1.stdout

    # Seed: user + account + category + transaction.
    # Schema at f0a1 does not have is_regex/active (those come in
    # f0a2) — so we use the SQLite-recognised defaults.
    conn = sqlite3.connect(sqlite_db)
    try:
        conn.executescript(
            """
            INSERT INTO users (id, email, password_hash, created_at, updated_at)
            VALUES ('11111111-1111-1111-1111-111111111111',
                    'migration-test@example.com',
                    'fakehash', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
            INSERT INTO accounts (id, user_id, name, type, opening_balance_cents,
                                  currency, created_at, updated_at)
            VALUES ('22222222-2222-2222-2222-222222222222',
                    '11111111-1111-1111-1111-111111111111',
                    'Test', 'asset', 0, 'IDR',
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
            INSERT INTO categories (id, user_id, name, kind, created_at, updated_at)
            VALUES ('33333333-3333-3333-3333-333333333333',
                    '11111111-1111-1111-1111-111111111111',
                    'Makan', 'expense',
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
            INSERT INTO transactions (id, user_id, account_id, category_id,
                                      type, amount_cents, currency, occurred_on,
                                      note, created_at, updated_at)
            VALUES ('44444444-4444-4444-4444-444444444444',
                    '11111111-1111-1111-1111-111111111111',
                    '22222222-2222-2222-2222-222222222222',
                    NULL, 'expense', 10000, 'IDR', '2026-07-30',
                    'BACKFILL test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
            """
        )
        conn.commit()
    finally:
        conn.close()

    # Upgrade through f0a2 (which adds is_regex + active defaults
    # so the seeded category_rule isn't strictly needed here —
    # backfill works without rules and will just no-op for users
    # with no rules, which is enough to exercise the column
    # ordering).
    upgrade = _run_alembic(sqlite_db, "upgrade", "head")
    assert upgrade.returncode == 0, upgrade.stderr or upgrade.stdout

    # The migration should not crash AND the column ``origin_tag``
    # should be present (added by f0a3 during this same upgrade
    # pass).
    conn = sqlite3.connect(sqlite_db)
    try:
        cols = {row[1] for row in conn.execute("PRAGMA table_info(rule_audit_log)")}
    finally:
        conn.close()
    assert "origin_tag" in cols, "origin_tag column missing from rule_audit_log"


def test_backfill_migration_actually_applies_rules(sqlite_db: Path) -> None:
    """QA retest #3 defect #1c (round 3): the backfill migration
    must *actually* apply rules — not just run without crashing.

    Round 2's fix moved ``op.add_column("origin_tag", ...)`` to
    the top of f0a3 so the idempotency SELECT didn't crash. But
    it also normalised ``user_id`` to ``str`` so the
    ``_current_rule_version`` lookup would match. The engine's
    Python-side guard ``transaction.user_id != user_id`` then
    fails (``UUID != str``) and every transaction is silently
    skipped — the migration runs to completion, writes nothing,
    and AC (5) "log affected rows" stays unmet.

    The fix casts the string ``user_id`` back to ``UUID`` before
    calling the engine so the Python-side guard sees the same
    type as ``Transaction.user_id``. This test seeds a real
    category_rule (the previous test missed this path entirely)
    and asserts the transaction's ``category_id`` gets assigned
    + an audit row appears in ``rule_audit_log``.

    Enum note: SQLAlchemy's ``Enum(native_enum=False)`` stores
    enum *names* (UPPERCASE) in the DB, not the lowercase
    ``StrEnum`` *values*. The model bind processor converts
    ``TransactionType.EXPENSE`` to ``"EXPENSE"`` for storage; a
    raw-SQL ``INSERT ... type='expense'`` would store a value
    the ORM can't roundtrip back. Production writes go through
    the ORM so this works there — but a raw-SQL seed must use
    uppercase enum names to match the storage convention.
    """
    up_to_f0a2 = _run_alembic(sqlite_db, "upgrade", "b2c4d6e8f0a2")
    assert up_to_f0a2.returncode == 0, up_to_f0a2.stderr or up_to_f0a2.stdout

    # Seed user + account + category + rule + transaction. Schema
    # at f0a2 already has is_regex/active columns so we set them
    # explicitly.
    conn = sqlite3.connect(sqlite_db)
    try:
        conn.executescript(
            """
            INSERT INTO users (id, email, password_hash, created_at, updated_at)
            VALUES ('11111111-1111-1111-1111-111111111111',
                    'migration-apply@example.com',
                    'fakehash', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
            INSERT INTO accounts (id, user_id, name, type, opening_balance_cents,
                                  currency, created_at, updated_at)
            VALUES ('22222222-2222-2222-2222-222222222222',
                    '11111111-1111-1111-1111-111111111111',
                    'Test', 'asset', 0, 'IDR',
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
            INSERT INTO categories (id, user_id, name, kind, created_at, updated_at)
            VALUES ('33333333-3333-3333-3333-333333333333',
                    '11111111-1111-1111-1111-111111111111',
                    'Makan', 'EXPENSE',
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
            INSERT INTO category_rules (id, user_id, pattern, category_id,
                                        priority, is_regex, active,
                                        created_at, updated_at)
            VALUES ('55555555-5555-5555-5555-555555555555',
                    '11111111-1111-1111-1111-111111111111',
                    'BACKFILL',
                    '33333333-3333-3333-3333-333333333333',
                    100, 0, 1,
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
            INSERT INTO transactions (id, user_id, account_id, category_id,
                                      type, amount_cents, currency, occurred_on,
                                      note, created_at, updated_at)
            VALUES ('44444444-4444-4444-4444-444444444444',
                    '11111111-1111-1111-1111-111111111111',
                    '22222222-2222-2222-2222-222222222222',
                    NULL, 'EXPENSE', 10000, 'IDR', '2026-07-30',
                    'BACKFILL test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
            """
        )
        conn.commit()
    finally:
        conn.close()

    upgrade = _run_alembic(sqlite_db, "upgrade", "head")
    assert upgrade.returncode == 0, upgrade.stderr or upgrade.stdout

    conn = sqlite3.connect(sqlite_db)
    try:
        # The transaction's category_id must be assigned — the
        # rule matches note "BACKFILL test" → category Makan.
        tx_category = conn.execute(
            "SELECT category_id FROM transactions WHERE id = '44444444-4444-4444-4444-444444444444'"
        ).fetchone()[0]
        assert tx_category == "33333333-3333-3333-3333-333333333333", (
            f"backfill did not assign category_id, got {tx_category!r}"
        )

        # One audit row written for the apply pass, with the
        # SHA256 ``rule_version`` hash in ``origin_tag``.
        audit_rows = list(
            conn.execute(
                "SELECT rule_id, transaction_id, origin, origin_tag "
                "FROM rule_audit_log WHERE origin = 'backfill'"
            )
        )
        assert len(audit_rows) == 1, f"expected exactly 1 backfill audit row, got {len(audit_rows)}"
        assert audit_rows[0][2] == "backfill"
        assert audit_rows[0][3] is not None and len(audit_rows[0][3]) == 64
    finally:
        conn.close()
