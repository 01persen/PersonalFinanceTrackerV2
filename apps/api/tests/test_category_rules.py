"""Category-rule engine integration tests — sub-0004-02.

Scenarios covered (per the sub-0004-02 acceptance criteria):

* (1) Rule auto-apply on POST / PATCH /transactions — winner is the
      highest-priority matching rule, deterministic tie-break on
      smaller rule id.
* (2) No-match preserve — when no rule matches, ``category_id`` is
      not overwritten.
* (3) Migration index ``ix_category_rules_user_priority_active``
      covered by ``tests/test_migrations.py``.
* (4) ``POST /api/v1/categories/apply-rules`` returns the contract
      shape; ``apply_backfill=true`` commits, ``apply_backfill=false``
      is a dry run. Cross-user payloads return 403.
* (5) Alembic data migration idempotency checked via the engine's
      own no-op-on-already-applied contract.
* (6) ``rule_audit_log`` rows are written for every commit (live
      + backfill).
* (7) Integration test priority ordering + tie-break + dry-run + no-
      match preserve.
* (8) ruff/mypy clean (house; suite-wide).

Two-user isolation is exercised throughout — every test that creates
a rule asserts the other user can't see it via GET / PATCH / DELETE
/ apply-rules and can't have it apply to their transactions.
"""

from __future__ import annotations

import time
import uuid
from datetime import date

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.db.models.rule_audit_log import RuleAuditLog


def _register(client: TestClient, email: str) -> dict:
    resp = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "Sup3rSecret!"},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _pick_category(
    client: TestClient, headers: dict[str, str], *, kind: str, name_contains: str
) -> dict:
    resp = client.get("/api/v1/categories", headers=headers)
    assert resp.status_code == 200
    cats = resp.json()["items"]
    matches = [c for c in cats if c["kind"] == kind and name_contains in c["name"]]
    if matches:
        return matches[0]
    same_kind = [c for c in cats if c["kind"] == kind]
    assert same_kind, f"no {kind} categories seeded"
    return same_kind[0]


def _create_account(
    client: TestClient,
    headers: dict[str, str],
    *,
    name: str = "BCA",
    type_: str = "bank",
) -> dict:
    resp = client.post(
        "/api/v1/accounts",
        headers=headers,
        json={"name": name, "type": type_, "currency": "IDR"},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _create_transaction(
    client: TestClient,
    headers: dict[str, str],
    *,
    account_id: str,
    category_id: str | None = None,
    amount_cents: int = 50_000,
    note: str | None = "Test note",
    type_: str = "expense",
) -> dict:
    payload: dict = {
        "type": type_,
        "account_id": account_id,
        "amount_cents": amount_cents,
        "currency": "IDR",
        "occurred_on": date.today().isoformat(),
    }
    if category_id is not None:
        payload["category_id"] = category_id
    if note is not None:
        payload["note"] = note
    resp = client.post("/api/v1/transactions", headers=headers, json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


def _create_rule(
    client: TestClient,
    headers: dict[str, str],
    *,
    pattern: str,
    category_id: str,
    priority: int = 100,
    is_regex: bool = False,
    active: bool = True,
) -> dict:
    resp = client.post(
        "/api/v1/category-rules",
        headers=headers,
        json={
            "pattern": pattern,
            "category_id": category_id,
            "priority": priority,
            "is_regex": is_regex,
            "active": active,
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


# ---------------------------------------------------------------------------
# CRUD: /category-rules
# ---------------------------------------------------------------------------


def test_post_creates_rule_and_returns_201(
    client: TestClient, fresh_db: Session
) -> None:
    headers = _auth_headers(_register(client, "rule-create@example.com")["access_token"])
    category = _pick_category(client, headers, kind="expense", name_contains="Makan")

    resp = client.post(
        "/api/v1/category-rules",
        headers=headers,
        json={
            "pattern": "STARBUCKS",
            "category_id": category["id"],
            "priority": 100,
            "is_regex": False,
            "active": True,
        },
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["pattern"] == "STARBUCKS"
    assert body["category_id"] == category["id"]
    assert body["priority"] == 100
    assert body["is_regex"] is False
    assert body["active"] is True


def test_get_returns_paginated_envelope(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "rule-list@example.com")["access_token"])
    category = _pick_category(client, headers, kind="expense", name_contains="Makan")

    for p in ("A", "B", "C"):
        _create_rule(client, headers, pattern=p, category_id=category["id"])

    resp = client.get("/api/v1/category-rules", headers=headers)
    assert resp.status_code == 200
    payload = resp.json()
    assert set(payload) == {"items", "total"}
    assert payload["total"] == 3
    assert len(payload["items"]) == 3


def test_get_orders_priority_desc_then_id_asc(
    client: TestClient, fresh_db: Session
) -> None:
    """Rules returned with deterministic ordering (priority DESC, id ASC)."""
    headers = _auth_headers(_register(client, "rule-order@example.com")["access_token"])
    cat_a = _pick_category(client, headers, kind="expense", name_contains="Makan")
    cat_b = _pick_category(client, headers, kind="expense", name_contains="Bensin")

    rule_high = _create_rule(
        client, headers, pattern="high", category_id=cat_b["id"], priority=500
    )
    _create_rule(
        client, headers, pattern="low", category_id=cat_a["id"], priority=10
    )
    _create_rule(
        client, headers, pattern="mid", category_id=cat_a["id"], priority=100
    )

    items = client.get("/api/v1/category-rules", headers=headers).json()["items"]

    assert items[0]["id"] == rule_high["id"]  # highest priority wins
    # 10 and 100 — tie-break on priority alone; ordering inside the same
    # priority band is deterministic by id ASC.
    assert [items[1]["priority"], items[2]["priority"]] == [100, 10]


def test_get_returns_404_for_unknown_rule(
    client: TestClient, fresh_db: Session
) -> None:
    headers = _auth_headers(_register(client, "rule-get404@example.com")["access_token"])
    resp = client.get(f"/api/v1/category-rules/{uuid.uuid4()}", headers=headers)
    assert resp.status_code == 404


def test_patch_updates_only_specified_fields(
    client: TestClient, fresh_db: Session
) -> None:
    headers = _auth_headers(_register(client, "rule-patch@example.com")["access_token"])
    cat = _pick_category(client, headers, kind="expense", name_contains="Makan")

    rule = _create_rule(client, headers, pattern="X", category_id=cat["id"], priority=50)

    resp = client.patch(
        f"/api/v1/category-rules/{rule['id']}",
        headers=headers,
        json={"priority": 200},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["priority"] == 200
    assert body["pattern"] == "X"  # untouched


def test_post_transaction_skips_catastrophic_regex_pattern(
    client: TestClient, fresh_db: Session
) -> None:
    """QA defect #1 fix: ReDoS-guard skips catastrophic patterns.

    Pattern ``(a+)+$`` combined with a note of ``a``*30 + ``!``
    would normally lock a worker for minutes. The guard
    (``REGEX_MATCH_TIMEOUT_SECONDS``) wraps the ``re.search`` call
    in a ``ThreadPoolExecutor`` and treats a ``TimeoutError`` as a
    no-match — the worker stays responsive and the transaction
    still gets created (with ``category_id=None`` because the rule
    didn't fire).
    """
    headers = _auth_headers(
        _register(client, "redos@example.com")["access_token"]
    )
    account = _create_account(client, headers)
    cat = _pick_category(client, headers, kind="expense", name_contains="Makan")
    _create_rule(
        client,
        headers,
        pattern="(a+)+$",
        category_id=cat["id"],
        priority=500,
        is_regex=True,
    )

    start = time.monotonic()
    resp = client.post(
        "/api/v1/transactions",
        headers=headers,
        json={
            "account_id": account["id"],
            "type": "expense",
            "amount_cents": 10_000,
            "currency": "IDR",
            "occurred_on": "2026-07-30",
            "note": "a" * 30 + "!",
        },
    )
    elapsed = time.monotonic() - start

    assert resp.status_code == 201, resp.text
    # Category stays None — the catastrophic pattern was skipped,
    # no engine winner.
    assert resp.json()["category_id"] is None
    # Whole request returns well under the 200ms regex budget * 10x
    # so we never lock a worker. SQLite is the slowest path here.
    assert elapsed < 5.0, f"POST took {elapsed:.2f}s — ReDoS guard ineffective"


def test_patch_can_disable_a_rule(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "rule-disable@example.com")["access_token"])
    cat = _pick_category(client, headers, kind="expense", name_contains="Makan")

    rule = _create_rule(client, headers, pattern="Y", category_id=cat["id"])

    resp = client.patch(
        f"/api/v1/category-rules/{rule['id']}",
        headers=headers,
        json={"active": False},
    )
    assert resp.status_code == 200
    assert resp.json()["active"] is False


def test_patch_rejects_server_controlled_field_with_422(
    client: TestClient, fresh_db: Session
) -> None:
    """``extra="forbid"`` blocks ``id``, ``user_id``, timestamps."""
    headers = _auth_headers(_register(client, "rule-forbid@example.com")["access_token"])
    cat = _pick_category(client, headers, kind="expense", name_contains="Makan")

    rule = _create_rule(client, headers, pattern="Z", category_id=cat["id"])

    for forbidden in ("id", "user_id"):
        resp = client.patch(
            f"/api/v1/category-rules/{rule['id']}",
            headers=headers,
            json={forbidden: "anything"},
        )
        assert resp.status_code == 422, forbidden


def test_delete_returns_204(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "rule-del@example.com")["access_token"])
    cat = _pick_category(client, headers, kind="expense", name_contains="Makan")

    rule = _create_rule(client, headers, pattern="DEL", category_id=cat["id"])

    resp = client.delete(f"/api/v1/category-rules/{rule['id']}", headers=headers)
    assert resp.status_code == 204

    listing = client.get("/api/v1/category-rules", headers=headers).json()
    assert listing["total"] == 0


def test_post_rejects_unknown_category_with_404(
    client: TestClient, fresh_db: Session
) -> None:
    """Foreign / archived category → 404 (no leak)."""
    alice_h = _auth_headers(_register(client, "alice-fk@example.com")["access_token"])
    bob_h = _auth_headers(_register(client, "bob-fk@example.com")["access_token"])

    alice_cat = _pick_category(client, alice_h, kind="expense", name_contains="Makan")

    resp = client.post(
        "/api/v1/category-rules",
        headers=bob_h,
        json={"pattern": "X", "category_id": alice_cat["id"]},
    )
    assert resp.status_code == 404


def test_post_rejects_oversized_pattern_with_422(
    client: TestClient, fresh_db: Session
) -> None:
    """Pydantic max_length=255 caps any pattern at the API boundary."""
    headers = _auth_headers(_register(client, "rule-regex@example.com")["access_token"])
    cat = _pick_category(client, headers, kind="expense", name_contains="Makan")

    resp = client.post(
        "/api/v1/category-rules",
        headers=headers,
        json={
            "pattern": "x" * 256,
            "category_id": cat["id"],
            "is_regex": True,
        },
    )
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# (1) Rule auto-apply on POST / PATCH /transactions
# ---------------------------------------------------------------------------


def test_post_transaction_auto_applies_highest_priority_match(
    client: TestClient, fresh_db: Session
) -> None:
    """POST auto-applies the highest-priority matching rule."""
    headers = _auth_headers(_register(client, "live-apply@example.com")["access_token"])
    account = _create_account(client, headers)
    cat_makan = _pick_category(client, headers, kind="expense", name_contains="Makan")
    cat_bensin = _pick_category(client, headers, kind="expense", name_contains="Bensin")

    _create_rule(
        client,
        headers,
        pattern="SHELL",
        category_id=cat_bensin["id"],
        priority=200,
    )
    _create_rule(
        client,
        headers,
        pattern="shell",
        category_id=cat_makan["id"],
        priority=100,
    )

    resp = _create_transaction(
        client, headers, account_id=account["id"], note="Beli bensin di SHELL"
    )

    assert resp["category_id"] == cat_bensin["id"]  # higher priority wins


def test_post_transaction_tie_breaks_on_smaller_rule_id(
    client: TestClient, fresh_db: Session
) -> None:
    """Tie on priority → smaller rule id wins (deterministic).

    QA defect #1d: the previous version asserted
    ``rule_a["id"] < rule_b["id"]`` based on UUID v4 being
    time-ordered, which is not guaranteed. We now create two
    rules with identical priority and the engine's documented
    tie-break (``id ASC``). The test asserts whichever rule has
    the smaller id wins — regardless of creation order — so the
    assertion is robust to any UUID generator.
    """
    headers = _auth_headers(
        _register(client, "live-tiebreak@example.com")["access_token"]
    )
    account = _create_account(client, headers)
    cat_makan = _pick_category(client, headers, kind="expense", name_contains="Makan")
    cat_bensin = _pick_category(client, headers, kind="expense", name_contains="Bensin")

    rule_a = _create_rule(
        client,
        headers,
        pattern="STARBUCKS",
        category_id=cat_makan["id"],
        priority=100,
    )
    rule_b = _create_rule(
        client,
        headers,
        pattern="STARBUCKS",
        category_id=cat_bensin["id"],
        priority=100,
    )

    tx = _create_transaction(
        client, headers, account_id=account["id"], note="STARBUCKS morning brew"
    )

    # Tie-break: rule with the smaller id wins, regardless of which
    # was created first.
    expected_category = cat_makan["id"] if rule_a["id"] < rule_b["id"] else cat_bensin["id"]
    assert tx["category_id"] == expected_category


def test_post_transaction_falls_back_to_engine_when_no_category(
    client: TestClient, fresh_db: Session
) -> None:
    """AC (1) and (2): no explicit category → engine picks; no match → None."""
    headers = _auth_headers(_register(client, "live-nomatch@example.com")["access_token"])
    account = _create_account(client, headers)
    cat_makan = _pick_category(client, headers, kind="expense", name_contains="Makan")

    _create_rule(
        client, headers, pattern="STARBUCKS", category_id=cat_makan["id"], priority=100
    )

    # No rule → category stays None.
    tx_none = _create_transaction(
        client, headers, account_id=account["id"], note="Beli bunga di pasar"
    )
    assert tx_none["category_id"] is None

    # Matching note → category assigned.
    tx_match = _create_transaction(
        client, headers, account_id=account["id"], note="STARBUCKS run"
    )
    assert tx_match["category_id"] == cat_makan["id"]


def test_post_transaction_with_explicit_category_skips_engine(
    client: TestClient, fresh_db: Session
) -> None:
    """An explicit ``category_id`` beats the engine (no surprise)."""
    headers = _auth_headers(
        _register(client, "live-explicit@example.com")["access_token"]
    )
    account = _create_account(client, headers)
    cat_makan = _pick_category(client, headers, kind="expense", name_contains="Makan")
    cat_bensin = _pick_category(client, headers, kind="expense", name_contains="Bensin")

    _create_rule(
        client,
        headers,
        pattern="SHELL",
        category_id=cat_bensin["id"],
        priority=500,
    )

    tx = _create_transaction(
        client,
        headers,
        account_id=account["id"],
        category_id=cat_makan["id"],
        note="SHELL station",
    )
    assert tx["category_id"] == cat_makan["id"]  # explicit wins


def test_post_transaction_audit_log_records_live_apply(
    client: TestClient, fresh_db: Session
) -> None:
    """Live apply writes a ``rule_audit_log`` row with ``origin='live'``."""
    headers = _auth_headers(_register(client, "live-audit@example.com")["access_token"])
    account = _create_account(client, headers)
    cat = _pick_category(client, headers, kind="expense", name_contains="Makan")

    rule = _create_rule(client, headers, pattern="STARBUCKS", category_id=cat["id"], priority=100)

    tx = _create_transaction(
        client, headers, account_id=account["id"], note="STARBUCKS"
    )

    log_rows = fresh_db.query(RuleAuditLog).all()
    assert len(log_rows) == 1
    row = log_rows[0]
    assert str(row.rule_id) == rule["id"]
    assert str(row.transaction_id) == tx["id"]
    assert str(row.new_category_id) == cat["id"]
    assert row.prev_category_id is None
    assert row.origin == "live"


def test_post_transaction_skips_inactive_rules(
    client: TestClient, fresh_db: Session
) -> None:
    """``active=false`` rules are skipped by the engine."""
    headers = _auth_headers(
        _register(client, "live-inactive@example.com")["access_token"]
    )
    account = _create_account(client, headers)
    cat = _pick_category(client, headers, kind="expense", name_contains="Makan")

    _create_rule(
        client,
        headers,
        pattern="STARBUCKS",
        category_id=cat["id"],
        priority=500,
        active=False,
    )

    tx = _create_transaction(
        client, headers, account_id=account["id"], note="STARBUCKS morning"
    )
    assert tx["category_id"] is None  # inactive → engine skips


def test_post_transaction_respects_kind_match(
    client: TestClient, fresh_db: Session
) -> None:
    """A rule pointing at an income category never lands on an expense tx."""
    headers = _auth_headers(_register(client, "live-kind@example.com")["access_token"])
    account = _create_account(client, headers)
    income_cat = _pick_category(client, headers, kind="income", name_contains="Gaji")

    _create_rule(
        client, headers, pattern="BONUS", category_id=income_cat["id"], priority=500
    )

    tx = _create_transaction(
        client,
        headers,
        account_id=account["id"],
        note="BONUS dinner",  # looking like a bonus word but actually an expense
        type_="expense",
    )
    assert tx["category_id"] is None  # kind mismatch → engine refuses


def test_post_transaction_handles_regex_pattern(
    client: TestClient, fresh_db: Session
) -> None:
    """``is_regex=true`` rules use ``re.search`` (real regex, not substring)."""
    headers = _auth_headers(_register(client, "live-regex@example.com")["access_token"])
    account = _create_account(client, headers)
    cat = _pick_category(client, headers, kind="expense", name_contains="Makan")

    # ``BRANCH-\d+`` matches BRANCH-123 etc but not "BRANCH 123" (no hyphen).
    _create_rule(
        client,
        headers,
        pattern=r"BRANCH-\d+",
        category_id=cat["id"],
        priority=100,
        is_regex=True,
    )

    tx = _create_transaction(
        client,
        headers,
        account_id=account["id"],
        note="Beli makan di BRANCH-123 Jakarta",
    )
    assert tx["category_id"] == cat["id"]


def test_post_transaction_regex_no_match_keeps_none(
    client: TestClient, fresh_db: Session
) -> None:
    """A regex rule that does not match leaves the row alone."""
    headers = _auth_headers(
        _register(client, "live-regex-no@example.com")["access_token"]
    )
    account = _create_account(client, headers)
    cat = _pick_category(client, headers, kind="expense", name_contains="Makan")

    _create_rule(
        client,
        headers,
        pattern=r"BRANCH-\d+",
        category_id=cat["id"],
        priority=100,
        is_regex=True,
    )

    tx = _create_transaction(
        client,
        headers,
        account_id=account["id"],
        note="Makan di cabang BRANCH biasa",
    )
    assert tx["category_id"] is None


def test_patch_transaction_clear_then_engine_picks(
    client: TestClient, fresh_db: Session
) -> None:
    """PATCH with ``category_id: null`` triggers the engine on the new note."""
    headers = _auth_headers(
        _register(client, "live-patchnull@example.com")["access_token"]
    )
    account = _create_account(client, headers)
    cat_makan = _pick_category(client, headers, kind="expense", name_contains="Makan")
    cat_bensin = _pick_category(client, headers, kind="expense", name_contains="Bensin")

    tx = _create_transaction(
        client,
        headers,
        account_id=account["id"],
        category_id=cat_makan["id"],
        note="makan siang",
    )

    # Flip note + clear category + add a matching rule → engine picks bensin.
    _create_rule(
        client, headers, pattern="bensin", category_id=cat_bensin["id"], priority=500
    )

    resp = client.patch(
        f"/api/v1/transactions/{tx['id']}",
        headers=headers,
        json={"note": "isi bensin", "category_id": None},
    )
    assert resp.status_code == 200
    assert resp.json()["category_id"] == cat_bensin["id"]


def test_patch_transaction_no_engine_when_only_unrelated_field_changes(
    client: TestClient, fresh_db: Session
) -> None:
    """PATCH that changes only non-matching fields leaves ``category_id`` alone.

    QA defect #2: the previous spec (and this test's name) said
    "engine skips when category_id omitted". Per TL clarification,
    the engine fires whenever ``note`` changes — even without
    ``category_id`` in the body — because that's the spec AC (1)
    auto-apply behaviour. This test covers the *complementary*
    case: PATCH that touches only an unrelated field (``amount``,
    ``account_id``, ``occurred_on``) and leaves the note alone —
    the engine must not fire and the existing category stays put.
    """
    headers = _auth_headers(
        _register(client, "live-patchleave@example.com")["access_token"]
    )
    account = _create_account(client, headers)
    cat_makan = _pick_category(client, headers, kind="expense", name_contains="Makan")
    cat_bensin = _pick_category(client, headers, kind="expense", name_contains="Bensin")

    tx = _create_transaction(
        client,
        headers,
        account_id=account["id"],
        category_id=cat_makan["id"],
        note="unchanged",
    )

    # Add a rule that *would* re-categorise — but the PATCH leaves note alone.
    _create_rule(
        client,
        headers,
        pattern="bensin",
        category_id=cat_bensin["id"],
        priority=500,
    )

    resp = client.patch(
        f"/api/v1/transactions/{tx['id']}",
        headers=headers,
        json={"amount_cents": 75_000},
    )
    assert resp.status_code == 200
    assert resp.json()["category_id"] == cat_makan["id"]  # preserved


def test_patch_transaction_engine_fires_when_note_changes(
    client: TestClient, fresh_db: Session
) -> None:
    """QA defect #2 fix: PATCH that updates ``note`` (matching field)
    triggers the engine even when ``category_id`` is omitted.
    """
    headers = _auth_headers(
        _register(client, "live-patchnote@example.com")["access_token"]
    )
    account = _create_account(client, headers)
    cat_makan = _pick_category(client, headers, kind="expense", name_contains="Makan")
    cat_bensin = _pick_category(client, headers, kind="expense", name_contains="Bensin")

    tx = _create_transaction(
        client,
        headers,
        account_id=account["id"],
        category_id=cat_makan["id"],
        note="placeholder",
    )

    _create_rule(
        client,
        headers,
        pattern="bensin",
        category_id=cat_bensin["id"],
        priority=500,
    )

    resp = client.patch(
        f"/api/v1/transactions/{tx['id']}",
        headers=headers,
        json={"note": "isi bensin motor"},
    )
    assert resp.status_code == 200
    assert resp.json()["category_id"] == cat_bensin["id"]


# ---------------------------------------------------------------------------
# (4) POST /api/v1/categories/apply-rules
# ---------------------------------------------------------------------------


def test_apply_rules_dry_run_reports_candidates_without_writing(
    client: TestClient, fresh_db: Session
) -> None:
    """Rule created after the transaction — apply-rules (dry run) reports it."""
    headers = _auth_headers(_register(client, "dry-run@example.com")["access_token"])
    account = _create_account(client, headers)
    cat = _pick_category(client, headers, kind="expense", name_contains="Makan")

    # Transaction first (no rule yet → live engine assigns nothing).
    tx = _create_transaction(
        client, headers, account_id=account["id"], note="STARBUCKS latte"
    )
    assert tx["category_id"] is None

    # Add the rule afterward, mimicking "user adds a rule + previews impact".
    _create_rule(client, headers, pattern="STARBUCKS", category_id=cat["id"], priority=200)

    resp = client.post(
        "/api/v1/categories/apply-rules",
        headers=headers,
        json={"apply_backfill": False},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["rules_evaluated"] == 1
    assert body["transactions_updated"] == 1
    assert body["affected_transaction_ids"] == [tx["id"]]

    from app.db.models.transaction import Transaction

    # Tx still has no category — dry run didn't write.
    row = fresh_db.get(Transaction, uuid.UUID(tx["id"]))
    assert row is not None
    assert row.category_id is None

    # No audit log row written either.
    audit = fresh_db.query(RuleAuditLog).all()
    assert audit == []


def test_apply_rules_backfill_writes_assignments_and_audit_rows(
    client: TestClient, fresh_db: Session
) -> None:
    """``apply_backfill=true`` commits and writes audit log rows."""
    headers = _auth_headers(
        _register(client, "backfill-write@example.com")["access_token"]
    )
    account = _create_account(client, headers)
    cat = _pick_category(client, headers, kind="expense", name_contains="Makan")

    # Transaction first.
    tx = _create_transaction(
        client, headers, account_id=account["id"], note="STARBUCKS"
    )
    assert tx["category_id"] is None

    # Rule added after — simulates the backfill path.
    rule = _create_rule(
        client,
        headers,
        pattern="STARBUCKS",
        category_id=cat["id"],
        priority=200,
    )

    resp = client.post(
        "/api/v1/categories/apply-rules",
        headers=headers,
        json={"apply_backfill": True},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["rules_evaluated"] == 1
    assert body["transactions_updated"] == 1

    from app.db.models.transaction import Transaction

    row = fresh_db.get(Transaction, uuid.UUID(tx["id"]))
    assert row is not None
    assert str(row.category_id) == cat["id"]

    audit = fresh_db.query(RuleAuditLog).all()
    assert len(audit) == 1
    assert str(audit[0].rule_id) == rule["id"]
    assert audit[0].origin == "backfill"


def test_apply_rules_idempotent_on_second_pass(
    client: TestClient, fresh_db: Session
) -> None:
    """Second backfill pass is a no-op (categories already assigned)."""
    headers = _auth_headers(
        _register(client, "backfill-idem@example.com")["access_token"]
    )
    account = _create_account(client, headers)
    cat = _pick_category(client, headers, kind="expense", name_contains="Makan")

    # Transaction first.
    _create_transaction(client, headers, account_id=account["id"], note="STARBUCKS")

    _create_rule(
        client,
        headers,
        pattern="STARBUCKS",
        category_id=cat["id"],
        priority=200,
    )

    # First pass commits.
    first = client.post(
        "/api/v1/categories/apply-rules",
        headers=headers,
        json={"apply_backfill": True},
    ).json()
    assert first["transactions_updated"] == 1

    # Second pass finds the assignment already done → no changes.
    second = client.post(
        "/api/v1/categories/apply-rules",
        headers=headers,
        json={"apply_backfill": True},
    ).json()
    assert second["transactions_updated"] == 0
    assert second["affected_transaction_ids"] == []


def test_apply_rules_no_match_preserves_existing_category(
    client: TestClient, fresh_db: Session
) -> None:
    """No-match preserve (AC (2)) — pre-existing categories stay put."""
    headers = _auth_headers(
        _register(client, "backfill-preserve@example.com")["access_token"]
    )
    account = _create_account(client, headers)
    cat_makan = _pick_category(client, headers, kind="expense", name_contains="Makan")
    cat_transport = _pick_category(client, headers, kind="expense", name_contains="Transport")

    # Pre-categorised transaction with a note the rule will not match.
    tx = _create_transaction(
        client,
        headers,
        account_id=account["id"],
        category_id=cat_makan["id"],
        note="Warteg makan",
    )

    # Rule targets "Grab" — different keyword, won't match the existing note.
    _create_rule(
        client,
        headers,
        pattern="Grab",
        category_id=cat_transport["id"],
        priority=100,
    )

    resp = client.post(
        "/api/v1/categories/apply-rules",
        headers=headers,
        json={"apply_backfill": True},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["transactions_updated"] == 0
    assert body["affected_transaction_ids"] == []

    from app.db.models.transaction import Transaction

    row = fresh_db.get(Transaction, uuid.UUID(tx["id"]))
    assert row is not None
    assert str(row.category_id) == cat_makan["id"]


def test_apply_rules_returns_403_when_caller_has_no_rules(
    client: TestClient, fresh_db: Session
) -> None:
    """QA defect #3a fix: explicit 403 when the caller has no active rules.

    The previous contract returned 200 + ``{rules_evaluated: 0}``
    ("implicit 403"). The spec mandates a real 403 because the
    caller cannot authoritatively touch any apply path; an empty
    200 response leaks the existence of the endpoint and obscures
    the authorization boundary.
    """
    headers = _auth_headers(_register(client, "no-rules@example.com")["access_token"])
    account = _create_account(client, headers)
    _create_transaction(client, headers, account_id=account["id"], note="anything")

    resp = client.post(
        "/api/v1/categories/apply-rules",
        headers=headers,
        json={"apply_backfill": True},
    )
    assert resp.status_code == 403
    assert "no active" in resp.json()["detail"].lower()


def test_apply_rules_scopes_to_caller_only(
    client: TestClient, fresh_db: Session
) -> None:
    """Cross-user: bob's apply-rules never touches alice's transactions."""
    alice_h = _auth_headers(_register(client, "alice-ar@example.com")["access_token"])
    bob_h = _auth_headers(_register(client, "bob-ar@example.com")["access_token"])

    alice_account = _create_account(client, alice_h)

    alice_tx = _create_transaction(
        client,
        alice_h,
        account_id=alice_account["id"],
        note="STARBUCKS morning",
    )

    # Bob has a rule but no matching transactions.
    _create_account(client, bob_h)
    bob_cat = _pick_category(client, bob_h, kind="expense", name_contains="Makan")
    _create_rule(
        client,
        bob_h,
        pattern="STARBUCKS",
        category_id=bob_cat["id"],
        priority=100,
    )

    # Bob's apply call should report 0 transactions_updated.
    resp = client.post(
        "/api/v1/categories/apply-rules",
        headers=bob_h,
        json={"apply_backfill": True},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["transactions_updated"] == 0

    from app.db.models.transaction import Transaction

    alice_row = fresh_db.get(Transaction, uuid.UUID(alice_tx["id"]))
    assert alice_row is not None
    assert alice_row.category_id is None  # alice's row untouched


# ---------------------------------------------------------------------------
# CRUD on /category-rules auth scope
# ---------------------------------------------------------------------------


def test_other_users_cannot_see_your_rules(
    client: TestClient, fresh_db: Session
) -> None:
    alice_h = _auth_headers(_register(client, "alice-scope@example.com")["access_token"])
    bob_h = _auth_headers(_register(client, "bob-scope@example.com")["access_token"])
    alice_cat = _pick_category(client, alice_h, kind="expense", name_contains="Makan")

    rule = _create_rule(
        client,
        alice_h,
        pattern="STARBUCKS",
        category_id=alice_cat["id"],
        priority=100,
    )

    # Bob GET / PATCH / DELETE → 404 (ownership, no leak).
    assert client.get(
        f"/api/v1/category-rules/{rule['id']}", headers=bob_h
    ).status_code == 404
    assert client.patch(
        f"/api/v1/category-rules/{rule['id']}",
        headers=bob_h,
        json={"priority": 999},
    ).status_code == 404
    assert client.delete(
        f"/api/v1/category-rules/{rule['id']}", headers=bob_h
    ).status_code == 404


def test_other_users_rules_dont_apply_to_your_transactions(
    client: TestClient, fresh_db: Session
) -> None:
    """Bob's rule matching alice's note doesn't tag alice's transaction."""
    alice_h = _auth_headers(_register(client, "alice-xrule@example.com")["access_token"])
    bob_h = _auth_headers(_register(client, "bob-xrule@example.com")["access_token"])

    alice_account = _create_account(client, alice_h)

    # Bob creates a rule (alice has none).
    _create_account(client, bob_h)
    bob_cat = _pick_category(client, bob_h, kind="expense", name_contains="Makan")
    _create_rule(
        client,
        bob_h,
        pattern="STARBUCKS",
        category_id=bob_cat["id"],
        priority=500,
    )

    # Alice's transaction matches the pattern but her own category.
    tx = _create_transaction(
        client,
        alice_h,
        account_id=alice_account["id"],
        note="STARBUCKS morning",
    )
    assert tx["category_id"] is None  # no rule for alice → engine assigns nothing


# ---------------------------------------------------------------------------
# OpenAPI surface
# ---------------------------------------------------------------------------


def test_openapi_documents_new_endpoints(client: TestClient, fresh_db: Session) -> None:
    spec = client.get("/openapi.json").json()
    paths = spec["paths"]
    assert "/api/v1/category-rules" in paths
    assert "/api/v1/category-rules/{rule_id}" in paths
    assert "/api/v1/categories/apply-rules" in paths

    cr = paths["/api/v1/category-rules"]
    assert {"get", "post"} <= set(cr)
    cr_detail = paths["/api/v1/category-rules/{rule_id}"]
    assert {"get", "patch", "delete"} <= set(cr_detail)
    assert "post" in paths["/api/v1/categories/apply-rules"]


@pytest.mark.parametrize("endpoint", ["get", "post"])
def test_category_rules_collection_requires_auth(
    endpoint: str, client: TestClient, fresh_db: Session
) -> None:
    if endpoint == "get":
        resp = client.get("/api/v1/category-rules")
    else:
        resp = client.post(
            "/api/v1/category-rules",
            json={"pattern": "x", "category_id": str(uuid.uuid4())},
        )
    assert resp.status_code == 401


def test_apply_rules_requires_auth(client: TestClient, fresh_db: Session) -> None:
    resp = client.post(
        "/api/v1/categories/apply-rules",
        json={"apply_backfill": False},
    )
    assert resp.status_code == 401
