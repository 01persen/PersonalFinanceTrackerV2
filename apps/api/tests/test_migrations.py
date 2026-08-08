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
    # sub-0009-01 — recurring rule CRUD scaffold (migration e1c5).
    "recurring_rules",
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
    # sub-0006-02 — debt payments source_account_id index added so
    # per-account payment aggregations are cheap. Migration f0a6.
    ("debt_payments", "ix_debt_payments_source_account_id"),
    ("rule_audit_log", "ix_rule_audit_log_user_applied_at"),
    ("rule_audit_log", "ix_rule_audit_log_rule_applied_at"),
    ("rule_audit_log", "ix_rule_audit_log_transaction"),
    ("user_preferences", "ix_user_preferences_user_id"),
    # sub-0009-01 — recurring rule CRUD scaffold (migration e1c5). The
    # three composite indexes cover the worker scan (next_run_on), the
    # FE list filter by account, and the dashboard active-rules widget.
    ("recurring_rules", "ix_recurring_rules_user_next_run_on"),
    ("recurring_rules", "ix_recurring_rules_user_account"),
    ("recurring_rules", "ix_recurring_rules_user_active_next_run"),
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


def test_user_preferences_settings_columns_roundtrip(sqlite_db: Path) -> None:
    """sub-0008-03 — the ``7d8e9f0a1b2c`` migration adds ``week_start``,
    ``display_name``, and ``version`` columns to ``user_preferences``. The
    test pins the contract:

    * Apply cleanly on top of the b2c4d6e8f0a6 state.
    * Survive a ``downgrade -1`` round-trip (drop the three new columns).
    * Stay server-defaulted so a brand-new DB (or a populated one from a
      pre-sub-0008-03 dump) sees the right values without manual
      backfill scripts.
    """
    up = _run_alembic(sqlite_db, "upgrade", "7d8e9f0a1b2c")
    assert up.returncode == 0, up.stderr or up.stdout

    conn = sqlite3.connect(sqlite_db)
    try:
        cols = {row[1] for row in conn.execute("PRAGMA table_info(user_preferences)")}
        assert {"week_start", "display_name", "version"} <= cols
    finally:
        conn.close()

    # Downgrade — the three new columns must be gone after ``-1``.
    down = _run_alembic(sqlite_db, "downgrade", "b2c4d6e8f0a6")
    assert down.returncode == 0, down.stderr or up.stdout

    conn = sqlite3.connect(sqlite_db)
    try:
        cols = {row[1] for row in conn.execute("PRAGMA table_info(user_preferences)")}
        assert "week_start" not in cols
        assert "display_name" not in cols
        assert "version" not in cols
    finally:
        conn.close()

    # Re-apply — the columns come back without breaking any other
    # user_preferences invariant.
    re_up = _run_alembic(sqlite_db, "upgrade", "7d8e9f0a1b2c")
    assert re_up.returncode == 0, re_up.stderr or re_up.stdout

    conn = sqlite3.connect(sqlite_db)
    try:
        cols = {row[1] for row in conn.execute("PRAGMA table_info(user_preferences)")}
        assert {"week_start", "display_name", "version"} <= cols
    finally:
        conn.close()


def test_goals_achieved_at_column_roundtrip(sqlite_db: Path) -> None:
    """sub-0005-02 — the ``c5a7b9c1d3e4`` migration adds a nullable
    ``achieved_at`` column to ``goals``. It must:

    * Apply cleanly on top of the f5a6 state.
    * Survive a ``downgrade -1`` round-trip (drop the new column).
    * Stay nullable so a brand-new DB (empty ``goals`` table) sees
      no constraint violation.
    """
    up = _run_alembic(sqlite_db, "upgrade", "c5a7b9c1d3e4")
    assert up.returncode == 0, up.stderr or up.stdout

    conn = sqlite3.connect(sqlite_db)
    try:
        cols = {row[1] for row in conn.execute("PRAGMA table_info(goals)")}
        assert "achieved_at" in cols
    finally:
        conn.close()

    # Downgrade — the column must be gone after a single ``-1``.
    down = _run_alembic(sqlite_db, "downgrade", "f5a6b7c8d9e0")
    assert down.returncode == 0, down.stderr or down.stdout

    conn = sqlite3.connect(sqlite_db)
    try:
        cols = {row[1] for row in conn.execute("PRAGMA table_info(goals)")}
        assert "achieved_at" not in cols
    finally:
        conn.close()

    # Re-apply — the column comes back without data loss for other rows.
    re_up = _run_alembic(sqlite_db, "upgrade", "c5a7b9c1d3e4")
    assert re_up.returncode == 0, re_up.stderr or re_up.stdout

    conn = sqlite3.connect(sqlite_db)
    try:
        cols = {row[1] for row in conn.execute("PRAGMA table_info(goals)")}
        assert "achieved_at" in cols
    finally:
        conn.close()


def test_goals_migration_preserves_data_over_prior_state(
    sqlite_db: Path,
) -> None:
    """sub-0005-01 carry-over: SQLite < 3.35.0 portability.

    CI flagged that ``ALTER COLUMN ... DROP NOT NULL`` and
    ``ADD COLUMN ... NOT NULL DEFAULT <non-constant>`` aren't supported
    on older SQLite. The f5a6 migration was patched to wrap those ops
    in ``op.batch_alter_table(recreate="always")`` and to add
    ``start_date`` as nullable first, backfill it with
    ``UPDATE ... SET start_date = CURRENT_DATE``, then tighten to
    NOT NULL in a second batch. This test pins the data-preservation
    contract:

    * The pre-existing goal row survives the upgrade.
    * ``start_date`` is back-filled to a non-null value.
    * The downgrade round-trips back to the f0a5 schema with the
      goal row's ``current_amount_cents`` and renamed column still
      intact.
    """
    up_to_f0a5 = _run_alembic(sqlite_db, "upgrade", "b2c4d6e8f0a5")
    assert up_to_f0a5.returncode == 0, up_to_f0a5.stderr or up_to_f0a5.stdout

    conn = sqlite3.connect(sqlite_db)
    try:
        conn.executescript(
            """
            INSERT INTO users (id, email, password_hash, created_at, updated_at)
            VALUES ('11111111-1111-1111-1111-111111111111',
                    'goals-data@example.com',
                    'fakehash', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
            INSERT INTO goals (id, user_id, kind, name, target_amount_cents,
                              current_amount_cents, account_id,
                              created_at, updated_at)
            VALUES ('22222222-2222-2222-2222-222222222222',
                    '11111111-1111-1111-1111-111111111111',
                    'saving', 'Pre-existing', 5000000, 1500000, NULL,
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
            """
        )
        conn.commit()
    finally:
        conn.close()

    # Upgrade to f5a6 — every column-nullability / column-add op must
    # run inside the batch recreate path (verified indirectly: a bare
    # ``ALTER COLUMN DROP NOT NULL`` on this CI SQLite would throw
    # ``near "ALTER": syntax error`` here).
    up = _run_alembic(sqlite_db, "upgrade", "f5a6b7c8d9e0")
    assert up.returncode == 0, up.stderr or up.stdout

    conn = sqlite3.connect(sqlite_db)
    try:
        row = conn.execute(
            """
            SELECT current_amount_cents, linked_account_id, start_date
            FROM goals
            WHERE id = '22222222-2222-2222-2222-222222222222'
            """
        ).fetchone()
        assert row is not None
        # Pre-existing ``current_amount_cents`` survives the recreate.
        assert int(row[0]) == 1_500_000
        # ``linked_account_id`` is the renamed version of ``account_id``
        # and matches the persisted NULL.
        assert row[1] is None
        # ``start_date`` was back-filled to today's date (not NULL).
        assert row[2] is not None
    finally:
        conn.close()

    # Downgrade — table is recreated again with the original shape.
    down = _run_alembic(sqlite_db, "downgrade", "b2c4d6e8f0a5")
    assert down.returncode == 0, down.stderr or down.stdout

    conn = sqlite3.connect(sqlite_db)
    try:
        cols = {row[1] for row in conn.execute("PRAGMA table_info(goals)")}
        # New columns from f5a6 are gone.
        for new_col in (
            "start_date",
            "jangka_waktu_months",
            "tabungan_bulanan_cents",
            "monthly_expense_cents",
            "jumlah_tanggungan",
            "multiplier",
            "lama_mengumpulkan_bulan",
            "target_amount_snapshot_cents",
            "notes",
            "archived_at",
            "linked_account_id",
        ):
            assert new_col not in cols, f"{new_col!r} should be dropped on downgrade"
        # ``account_id`` is back.
        assert "account_id" in cols

        # Pre-existing data survives the round-trip — same
        # ``current_amount_cents`` value, ``account_id`` still NULL.
        row = conn.execute(
            "SELECT current_amount_cents, account_id "
            "FROM goals WHERE id = '22222222-2222-2222-2222-222222222222'"
        ).fetchone()
        assert int(row[0]) == 1_500_000
        assert row[1] is None
    finally:
        conn.close()


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


def test_debts_migration_preserves_data_and_backfills_monthly_payment(
    sqlite_db: Path,
) -> None:
    before = _run_alembic(sqlite_db, "upgrade", "c5a7b9c1d3e4")
    assert before.returncode == 0, before.stderr or before.stdout

    conn = sqlite3.connect(sqlite_db)
    try:
        conn.executescript(
            """
            INSERT INTO users (id, email, password_hash, created_at, updated_at)
            VALUES ('11111111-1111-1111-1111-111111111111',
                    'debt-migration@example.com', 'fakehash',
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
            INSERT INTO debts (id, user_id, name, kind, principal_cents,
                               interest_rate, tenor_months, start_date, note,
                               status, created_at, updated_at)
            VALUES ('22222222-2222-2222-2222-222222222222',
                    '11111111-1111-1111-1111-111111111111',
                    'Legacy mortgage', 'MORTGAGE', 12000000, 10, 12,
                    '2026-01-01', NULL, 'ACTIVE',
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
                   ('33333333-3333-3333-3333-333333333333',
                    '11111111-1111-1111-1111-111111111111',
                    'Open loan', 'LOAN', 5000000, 0, NULL,
                    '2026-02-01', NULL, 'ACTIVE',
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
            """
        )
        conn.commit()
    finally:
        conn.close()

    upgrade = _run_alembic(sqlite_db, "upgrade", "d6e8f0a1b2c3")
    assert upgrade.returncode == 0, upgrade.stderr or upgrade.stdout

    conn = sqlite3.connect(sqlite_db)
    try:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(debts)")}
        assert "bunga_pct" in columns
        assert "monthly_payment_cents" in columns
        assert "interest_rate" not in columns
        rows = conn.execute(
            "SELECT id, kind, bunga_pct, tenor_months, monthly_payment_cents FROM debts ORDER BY id"
        ).fetchall()
        assert rows[0] == (
            "22222222-2222-2222-2222-222222222222",
            "KPR",
            10,
            12,
            1_100_000,
        )
        assert rows[1] == (
            "33333333-3333-3333-3333-333333333333",
            "LOAN",
            0,
            None,
            None,
        )
    finally:
        conn.close()

    downgrade = _run_alembic(sqlite_db, "downgrade", "c5a7b9c1d3e4")
    assert downgrade.returncode == 0, downgrade.stderr or downgrade.stdout

    conn = sqlite3.connect(sqlite_db)
    try:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(debts)")}
        assert "interest_rate" in columns
        assert "bunga_pct" not in columns
        assert "monthly_payment_cents" not in columns
        legacy = conn.execute(
            "SELECT kind, interest_rate FROM debts "
            "WHERE id = '22222222-2222-2222-2222-222222222222'"
        ).fetchone()
        assert legacy == ("MORTGAGE", 10)
    finally:
        conn.close()


def test_debt_payments_source_account_roundtrip(sqlite_db: Path) -> None:
    """sub-0006-02 — ``b2c4d6e8f0a6`` migration adds ``source_account_id``
    (nullable FK to ``accounts.id``) to ``debt_payments``. It must:

    * Apply cleanly on top of the d6e8 state (which already extended
      the ``debts`` table for sub-0006-01).
    * Be nullable (no back-fill required — pre-existing rows have
      ``source_account_id IS NULL``).
    * Add the ``ix_debt_payments_source_account_id`` index.
    * Survive a ``downgrade -1`` round-trip (drop the new column +
      index + FK).
    """
    up = _run_alembic(sqlite_db, "upgrade", "b2c4d6e8f0a6")
    assert up.returncode == 0, up.stderr or up.stdout

    conn = sqlite3.connect(sqlite_db)
    try:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(debt_payments)")}
        assert "source_account_id" in columns

        # Index lands with the matching name (mirrors the FK column
        # naming convention used by every other index in this DB).
        indexes = {
            row[1]
            for row in conn.execute("PRAGMA index_list(debt_payments)")
            if not row[1].startswith("sqlite_autoindex_")
        }
        assert "ix_debt_payments_source_account_id" in indexes

        # FK is registered — verify via PRAGMA foreign_key_list on
        # SQLite (the ``op.create_foreign_key`` call inside the
        # batch_alter_table block translates to a ``REFERENCES``
        # clause on the new column).
        fk_columns = [row[3] for row in conn.execute("PRAGMA foreign_key_list(debt_payments)")]
        assert "source_account_id" in fk_columns
    finally:
        conn.close()

    # Downgrade — column, FK, and index must all be gone after one
    # ``-1``. The base schema (cd96a512ab4a) didn't have this column.
    down = _run_alembic(sqlite_db, "downgrade", "d6e8f0a1b2c3")
    assert down.returncode == 0, down.stderr or down.stdout

    conn = sqlite3.connect(sqlite_db)
    try:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(debt_payments)")}
        assert "source_account_id" not in columns

        indexes = {
            row[1]
            for row in conn.execute("PRAGMA index_list(debt_payments)")
            if not row[1].startswith("sqlite_autoindex_")
        }
        assert "ix_debt_payments_source_account_id" not in indexes
    finally:
        conn.close()

    # Re-apply — the column comes back without issue.
    re_up = _run_alembic(sqlite_db, "upgrade", "b2c4d6e8f0a6")
    assert re_up.returncode == 0, re_up.stderr or re_up.stdout

    conn = sqlite3.connect(sqlite_db)
    try:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(debt_payments)")}
        assert "source_account_id" in columns
    finally:
        conn.close()


def test_recurring_rules_table_roundtrip(sqlite_db: Path) -> None:
    """sub-0009-01 — the ``e1c5b9a7f2d3`` migration creates the
    ``recurring_rules`` table and three composite indexes
    (``ix_recurring_rules_user_next_run_on``,
    ``ix_recurring_rules_user_account``,
    ``ix_recurring_rules_user_active_next_run``). The migration must:

    * Apply cleanly on top of the ``7d8e9f0a1b2c`` state.
    * Survive a ``downgrade -1`` round-trip (drop the table + all three
      indexes).
    * Re-apply without data loss for unrelated rows.
    """
    up = _run_alembic(sqlite_db, "upgrade", "e1c5b9a7f2d3")
    assert up.returncode == 0, up.stderr or up.stdout

    expected_columns = {
        "account_id",
        "category_id",
        "kind",
        "cadence",
        "amount_cents",
        "currency",
        "start_on",
        "end_on",
        "next_run_on",
        "note",
        "is_active",
        "id",
        "user_id",
        "created_at",
        "updated_at",
    }
    expected_indexes = {
        "ix_recurring_rules_user_next_run_on",
        "ix_recurring_rules_user_account",
        "ix_recurring_rules_user_active_next_run",
    }

    conn = sqlite3.connect(sqlite_db)
    try:
        cols = {row[1] for row in conn.execute("PRAGMA table_info(recurring_rules)")}
        missing_cols = expected_columns - cols
        assert not missing_cols, f"missing columns after upgrade: {missing_cols}"

        idx = {
            row[1]
            for row in conn.execute("PRAGMA index_list(recurring_rules)")
            if not row[1].startswith("sqlite_autoindex_")
        }
        missing_idx = expected_indexes - idx
        assert not missing_idx, f"missing indexes after upgrade: {missing_idx}"
    finally:
        conn.close()

    # Downgrade — the table + indexes must be gone after one ``-1``.
    down = _run_alembic(sqlite_db, "downgrade", "7d8e9f0a1b2c")
    assert down.returncode == 0, down.stderr or down.stdout

    conn = sqlite3.connect(sqlite_db)
    try:
        table_names = _table_names(sqlite_db)
        assert "recurring_rules" not in table_names
    finally:
        conn.close()

    # Re-apply — the table comes back without disturbing other tables.
    re_up = _run_alembic(sqlite_db, "upgrade", "e1c5b9a7f2d3")
    assert re_up.returncode == 0, re_up.stderr or re_up.stdout

    conn = sqlite3.connect(sqlite_db)
    try:
        cols = {row[1] for row in conn.execute("PRAGMA table_info(recurring_rules)")}
        assert "id" in cols and "next_run_on" in cols
    finally:
        conn.close()
