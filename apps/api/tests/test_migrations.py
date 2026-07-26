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
}

EXPECTED_INDEXES = {
    ("users", "ix_users_email"),
    ("transactions", "ix_transactions_user_occurred_on"),
    ("transactions", "ix_transactions_account_occurred_on"),
    ("transactions", "ix_transactions_category"),
    ("accounts", "ix_accounts_user_id"),
    ("categories", "ix_categories_user_id"),
    ("category_rules", "ix_category_rules_user_id"),
    ("debts", "ix_debts_user_id"),
    ("goals", "ix_goals_user_id"),
    ("debt_payments", "ix_debt_payments_debt_id"),
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
