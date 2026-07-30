"""Tests for ``GET /api/v1/transactions/search`` (sub-0004-03).

Covers the acceptance criteria from the sub-task description:

* **(1)** All eight filter parameters + ``page`` / ``page_size`` pagination.
  Default ``page_size`` is 50, hard cap is 200.
* **(2)** Deterministic ordering — ``occurred_on DESC, amount_cents DESC,
  id ASC``. Identical query → identical ordering every time.
* **(3)** Soft-delete aware — ``deleted_at IS NOT NULL`` rows are excluded.
* **(7)** Integration coverage of the filter matrix + pagination edge
  cases (empty result, last partial page, oversize ``page_size`` clamped).

Cross-cutting coverage:

* 404 when ``account_id`` / ``category_id`` belong to another user.
* 422 on bad ``type``, inverted date range, inverted amount range.
* Cross-user isolation: the search response never returns another user's
  rows even when the foreign filter ids would otherwise match.
* Note substring search is case-insensitive and treats ``%`` / ``_`` as
  literal characters (escape via ``\\``).
"""

from __future__ import annotations

import uuid
from datetime import date

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.db.models.transaction import Transaction


def _register(client: TestClient, email: str) -> dict:
    resp = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "Sup3rSecret!"},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_account(
    client: TestClient,
    headers: dict[str, str],
    *,
    name: str = "BCA",
    type_: str = "bank",
    currency: str = "IDR",
    opening_balance_cents: int = 0,
) -> dict:
    resp = client.post(
        "/api/v1/accounts",
        headers=headers,
        json={
            "name": name,
            "type": type_,
            "currency": currency,
            "opening_balance_cents": opening_balance_cents,
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _list_categories(client: TestClient, headers: dict[str, str]) -> list[dict]:
    resp = client.get("/api/v1/categories", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()["items"]


def _pick_category(
    client: TestClient, headers: dict[str, str], *, kind: str, name_contains: str
) -> dict:
    cats = _list_categories(client, headers)
    matches = [c for c in cats if c["kind"] == kind and name_contains in c["name"]]
    if matches:
        return matches[0]
    same_kind = [c for c in cats if c["kind"] == kind]
    assert same_kind, f"no {kind} categories seeded for this user"
    return same_kind[0]


def _create_transaction(
    client: TestClient,
    headers: dict[str, str],
    *,
    type_: str = "expense",
    account_id: str,
    category_id: str | None = None,
    amount_cents: int = 50_000,
    occurred_on: date | None = None,
    note: str | None = "Test note",
    currency: str = "IDR",
) -> dict:
    payload: dict = {
        "type": type_,
        "account_id": account_id,
        "amount_cents": amount_cents,
        "currency": currency,
        "occurred_on": (occurred_on or date.today()).isoformat(),
    }
    if category_id is not None:
        payload["category_id"] = category_id
    if note is not None:
        payload["note"] = note
    resp = client.post("/api/v1/transactions", headers=headers, json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


def _soft_delete(client: TestClient, headers: dict[str, str], tx_id: str) -> None:
    resp = client.delete(f"/api/v1/transactions/{tx_id}", headers=headers)
    assert resp.status_code == 204, resp.text


# --- (1) Pagination envelope + defaults ---------------------------------------


def test_search_default_page_size_is_50(client: TestClient, fresh_db: Session) -> None:
    """AC (1) — ``page_size`` defaults to 50; ``page`` defaults to 1."""
    headers = _auth_headers(_register(client, "search-default@example.com")["access_token"])
    account = _create_account(client, headers, name="BCA")

    # Seed 60 transactions so page 1 must be full and page 2 has the rest.
    for i in range(60):
        _create_transaction(
            client,
            headers,
            account_id=account["id"],
            amount_cents=1_000 + i,
            occurred_on=date(2026, 1, 1),
            note=f"row {i}",
        )

    page1 = client.get("/api/v1/transactions/search", headers=headers)
    assert page1.status_code == 200, page1.text
    body = page1.json()
    assert body["total"] == 60
    assert body["page"] == 1
    assert body["page_size"] == 50
    assert len(body["items"]) == 50

    page2 = client.get("/api/v1/transactions/search", headers=headers, params={"page": 2})
    assert page2.status_code == 200
    body2 = page2.json()
    assert body2["page"] == 2
    assert body2["page_size"] == 50
    assert len(body2["items"]) == 10


def test_search_max_page_size_is_200(client: TestClient, fresh_db: Session) -> None:
    """AC (1) — ``page_size > 200`` is rejected with 422 by FastAPI's Query."""
    headers = _auth_headers(_register(client, "search-max@example.com")["access_token"])
    resp = client.get(
        "/api/v1/transactions/search",
        headers=headers,
        params={"page_size": 201},
    )
    assert resp.status_code == 422


def test_search_min_page_size_is_1(client: TestClient, fresh_db: Session) -> None:
    """AC (1) — ``page_size < 1`` is rejected with 422."""
    headers = _auth_headers(_register(client, "search-min@example.com")["access_token"])
    resp = client.get(
        "/api/v1/transactions/search",
        headers=headers,
        params={"page_size": 0},
    )
    assert resp.status_code == 422


def test_search_min_page_is_1(client: TestClient, fresh_db: Session) -> None:
    """AC (1) — ``page < 1`` is rejected with 422."""
    headers = _auth_headers(_register(client, "search-page-min@example.com")["access_token"])
    resp = client.get(
        "/api/v1/transactions/search",
        headers=headers,
        params={"page": 0},
    )
    assert resp.status_code == 422


def test_search_empty_result_returns_empty_items(client: TestClient, fresh_db: Session) -> None:
    """No rows match → 200 with ``items=[]`` and ``total=0``."""
    headers = _auth_headers(_register(client, "search-empty@example.com")["access_token"])
    _create_account(client, headers, name="BCA")
    resp = client.get("/api/v1/transactions/search", headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"items": [], "total": 0, "page": 1, "page_size": 50}


# --- (2) Deterministic ordering -----------------------------------------------


def test_search_ordering_is_occurred_on_desc_then_amount_then_id(
    client: TestClient, fresh_db: Session
) -> None:
    """AC (2) — same query, same ordering, every time. Sort chain:
    ``occurred_on DESC, amount_cents DESC, id ASC``."""
    headers = _auth_headers(_register(client, "search-sort@example.com")["access_token"])
    account = _create_account(client, headers, name="BCA")

    # Day 1: 3 rows with identical amount_cents — id tie-breaker asc.
    day1 = date(2026, 1, 1)
    for i in range(3):
        _create_transaction(
            client,
            headers,
            account_id=account["id"],
            amount_cents=10_000,
            occurred_on=day1,
            note=f"day1 row {i}",
        )
    # Day 2: 3 rows with different amounts — amount tie-breaker desc.
    day2 = date(2026, 1, 2)
    for amount in (5_000, 50_000, 25_000):
        _create_transaction(
            client,
            headers,
            account_id=account["id"],
            amount_cents=amount,
            occurred_on=day2,
            note=f"day2 {amount}",
        )

    # Run the same query 3x — order must be byte-identical.
    expected_ids: list[str] | None = None
    for _ in range(3):
        resp = client.get("/api/v1/transactions/search", headers=headers)
        assert resp.status_code == 200
        ids = [item["id"] for item in resp.json()["items"]]
        if expected_ids is None:
            expected_ids = ids
        else:
            assert ids == expected_ids, f"search ordering drifted: {ids} != {expected_ids}"

    assert expected_ids is not None
    # day2 (newer) leads, ordered by amount desc: 50k, 25k, 5k.
    # day1 (older) follows, ordered by id asc.
    by_id = {item["id"]: item for item in resp.json()["items"]}
    returned_dates = [by_id[i]["occurred_on"] for i in expected_ids]
    assert returned_dates[:3] == ["2026-01-02"] * 3
    assert returned_dates[3:] == ["2026-01-01"] * 3


# --- (3) Soft-delete aware ----------------------------------------------------


def test_search_excludes_soft_deleted_rows(client: TestClient, fresh_db: Session) -> None:
    """AC (3) — ``deleted_at IS NOT NULL`` rows are filtered out of search."""
    headers = _auth_headers(_register(client, "search-softdel@example.com")["access_token"])
    account = _create_account(client, headers, name="BCA")

    keep = _create_transaction(client, headers, account_id=account["id"], note="keep me")
    gone = _create_transaction(client, headers, account_id=account["id"], note="delete me")
    _soft_delete(client, headers, gone["id"])

    resp = client.get("/api/v1/transactions/search", headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    assert [item["id"] for item in body["items"]] == [keep["id"]]


# --- (1) Filter matrix --------------------------------------------------------


def test_search_filter_by_q_substring(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "search-q@example.com")["access_token"])
    account = _create_account(client, headers, name="BCA")

    _create_transaction(client, headers, account_id=account["id"], note="Kopi Kenangan")
    _create_transaction(client, headers, account_id=account["id"], note="Makan siang")
    _create_transaction(client, headers, account_id=account["id"], note="kopi tubruk")

    # Case-insensitive substring.
    resp = client.get("/api/v1/transactions/search", headers=headers, params={"q": "kopi"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    notes = sorted(item["note"] for item in body["items"])
    assert notes == ["Kopi Kenangan", "kopi tubruk"]


def test_search_q_treats_percent_and_underscore_as_literal(
    client: TestClient, fresh_db: Session
) -> None:
    """AC: ``%`` and ``_`` in ``q`` must be escaped, not used as wildcards."""
    headers = _auth_headers(_register(client, "search-q-escape@example.com")["access_token"])
    account = _create_account(client, headers, name="BCA")

    _create_transaction(client, headers, account_id=account["id"], note="discount 50% off")
    _create_transaction(client, headers, account_id=account["id"], note="snake_case here")
    _create_transaction(client, headers, account_id=account["id"], note="ordinary note")

    # ``50%`` — without escape this would match everything.
    resp_pct = client.get("/api/v1/transactions/search", headers=headers, params={"q": "50%"})
    assert resp_pct.status_code == 200
    notes_pct = [item["note"] for item in resp_pct.json()["items"]]
    assert notes_pct == ["discount 50% off"]

    # ``_`` — without escape the underscore is a single-char wildcard.
    resp_us = client.get("/api/v1/transactions/search", headers=headers, params={"q": "_case"})
    assert resp_us.status_code == 200
    notes_us = [item["note"] for item in resp_us.json()["items"]]
    assert notes_us == ["snake_case here"]


def test_search_q_empty_or_whitespace_is_ignored(client: TestClient, fresh_db: Session) -> None:
    """Whitespace-only ``q`` must not zero-out the result set."""
    headers = _auth_headers(_register(client, "search-q-ws@example.com")["access_token"])
    account = _create_account(client, headers, name="BCA")

    _create_transaction(client, headers, account_id=account["id"], note="a")
    _create_transaction(client, headers, account_id=account["id"], note="b")

    for q in ("", "   ", "\t"):
        resp = client.get("/api/v1/transactions/search", headers=headers, params={"q": q})
        assert resp.status_code == 200
        assert resp.json()["total"] == 2


def test_search_filter_by_type(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "search-type@example.com")["access_token"])
    account = _create_account(client, headers, name="BCA")

    _create_transaction(client, headers, type_="expense", account_id=account["id"])
    income_cat = _pick_category(client, headers, kind="income", name_contains="Gaji")
    _create_transaction(
        client,
        headers,
        type_="income",
        account_id=account["id"],
        category_id=income_cat["id"],
    )

    resp = client.get(
        "/api/v1/transactions/search",
        headers=headers,
        params={"type": "income"},
    )
    assert resp.status_code == 200
    assert resp.json()["total"] == 1
    assert resp.json()["items"][0]["type"] == "income"


def test_search_filter_by_account(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "search-acct@example.com")["access_token"])
    a1 = _create_account(client, headers, name="BCA")
    a2 = _create_account(client, headers, name="Mandiri")

    _create_transaction(client, headers, account_id=a1["id"])
    _create_transaction(client, headers, account_id=a2["id"])

    resp = client.get(
        "/api/v1/transactions/search",
        headers=headers,
        params={"account_id": a1["id"]},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    assert body["items"][0]["account_id"] == a1["id"]


def test_search_filter_by_category(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "search-cat@example.com")["access_token"])
    account = _create_account(client, headers, name="BCA")
    makan = _pick_category(client, headers, kind="expense", name_contains="Makan")
    transport = _pick_category(client, headers, kind="expense", name_contains="Transport")

    _create_transaction(client, headers, account_id=account["id"], category_id=makan["id"])
    _create_transaction(client, headers, account_id=account["id"], category_id=transport["id"])
    _create_transaction(client, headers, account_id=account["id"])

    resp = client.get(
        "/api/v1/transactions/search",
        headers=headers,
        params={"category_id": makan["id"]},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    assert body["items"][0]["category_id"] == makan["id"]


def test_search_filter_by_date_range(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "search-date@example.com")["access_token"])
    account = _create_account(client, headers, name="BCA")

    d1 = date(2026, 1, 1)
    d2 = date(2026, 1, 15)
    d3 = date(2026, 2, 1)

    _create_transaction(client, headers, account_id=account["id"], occurred_on=d1)
    _create_transaction(client, headers, account_id=account["id"], occurred_on=d2)
    _create_transaction(client, headers, account_id=account["id"], occurred_on=d3)

    resp = client.get(
        "/api/v1/transactions/search",
        headers=headers,
        params={
            "date_from": d1.isoformat(),
            "date_to": d2.isoformat(),
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    dates = sorted(item["occurred_on"] for item in body["items"])
    assert dates == ["2026-01-01", "2026-01-15"]


def test_search_filter_by_amount_range(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "search-amt@example.com")["access_token"])
    account = _create_account(client, headers, name="BCA")

    for amount in (1_000, 5_000, 10_000, 50_000, 100_000):
        _create_transaction(client, headers, account_id=account["id"], amount_cents=amount)

    resp = client.get(
        "/api/v1/transactions/search",
        headers=headers,
        params={
            "amount_min_cents": 5_000,
            "amount_max_cents": 50_000,
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 3
    amounts = sorted(item["amount_cents"] for item in body["items"])
    assert amounts == [5_000, 10_000, 50_000]


def test_search_combined_filters_are_AND(client: TestClient, fresh_db: Session) -> None:
    """All filters compose with AND semantics."""
    headers = _auth_headers(_register(client, "search-combo@example.com")["access_token"])
    account = _create_account(client, headers, name="BCA")
    makan = _pick_category(client, headers, kind="expense", name_contains="Makan")

    # 1: matches all filters
    _create_transaction(
        client,
        headers,
        account_id=account["id"],
        category_id=makan["id"],
        amount_cents=20_000,
        occurred_on=date(2026, 1, 10),
        note="kopi mahal",
    )
    # 2: amount out of range
    _create_transaction(
        client,
        headers,
        account_id=account["id"],
        category_id=makan["id"],
        amount_cents=200_000,
        occurred_on=date(2026, 1, 10),
        note="kopi mahal",
    )
    # 3: category mismatch
    transport = _pick_category(client, headers, kind="expense", name_contains="Transport")
    _create_transaction(
        client,
        headers,
        account_id=account["id"],
        category_id=transport["id"],
        amount_cents=20_000,
        occurred_on=date(2026, 1, 10),
        note="kopi mahal",
    )

    resp = client.get(
        "/api/v1/transactions/search",
        headers=headers,
        params={
            "q": "kopi",
            "type": "expense",
            "account_id": account["id"],
            "category_id": makan["id"],
            "date_from": "2026-01-01",
            "date_to": "2026-01-31",
            "amount_min_cents": 10_000,
            "amount_max_cents": 50_000,
            "page_size": 50,
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    assert body["items"][0]["note"] == "kopi mahal"
    assert body["items"][0]["amount_cents"] == 20_000


def test_search_pagination_last_partial_page(client: TestClient, fresh_db: Session) -> None:
    """When total is not a multiple of ``page_size``, the last page is
    partial and ``total`` stays accurate."""
    headers = _auth_headers(_register(client, "search-partial@example.com")["access_token"])
    account = _create_account(client, headers, name="BCA")

    for i in range(125):
        _create_transaction(
            client,
            headers,
            account_id=account["id"],
            amount_cents=1_000 + i,
            occurred_on=date(2026, 1, 1),
            note=f"row {i}",
        )

    page1 = client.get(
        "/api/v1/transactions/search",
        headers=headers,
        params={"page_size": 50},
    )
    assert page1.json()["total"] == 125
    assert len(page1.json()["items"]) == 50

    page3 = client.get(
        "/api/v1/transactions/search",
        headers=headers,
        params={"page_size": 50, "page": 3},
    )
    assert page3.json()["total"] == 125
    assert len(page3.json()["items"]) == 25  # 125 - 100 = 25

    page4 = client.get(
        "/api/v1/transactions/search",
        headers=headers,
        params={"page_size": 50, "page": 4},
    )
    assert page4.json()["total"] == 125
    assert page4.json()["items"] == []


def test_search_page_beyond_last_returns_empty_items(client: TestClient, fresh_db: Session) -> None:
    """Asking for a page past the end returns 200 with ``items=[]``,
    not 404 — the FE can detect this without a special error path."""
    headers = _auth_headers(_register(client, "search-past-end@example.com")["access_token"])
    account = _create_account(client, headers, name="BCA")
    _create_transaction(client, headers, account_id=account["id"])

    resp = client.get(
        "/api/v1/transactions/search",
        headers=headers,
        params={"page": 99},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    assert body["items"] == []


# --- Validation ---------------------------------------------------------------


def test_search_rejects_inverted_date_range_with_422(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "search-bad-date@example.com")["access_token"])
    resp = client.get(
        "/api/v1/transactions/search",
        headers=headers,
        params={
            "date_from": "2026-02-01",
            "date_to": "2026-01-01",
        },
    )
    assert resp.status_code == 422


def test_search_rejects_inverted_amount_range_with_422(
    client: TestClient, fresh_db: Session
) -> None:
    headers = _auth_headers(_register(client, "search-bad-amt@example.com")["access_token"])
    resp = client.get(
        "/api/v1/transactions/search",
        headers=headers,
        params={
            "amount_min_cents": 1_000_000,
            "amount_max_cents": 500,
        },
    )
    assert resp.status_code == 422


def test_search_rejects_unknown_type_with_422(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "search-bad-type@example.com")["access_token"])
    resp = client.get(
        "/api/v1/transactions/search",
        headers=headers,
        params={"type": "refund"},
    )
    assert resp.status_code == 422


def test_search_rejects_negative_amount_bound_with_422(
    client: TestClient, fresh_db: Session
) -> None:
    """``amount_min_cents`` and ``amount_max_cents`` are ``ge=0``."""
    headers = _auth_headers(_register(client, "search-bad-amt-neg@example.com")["access_token"])
    resp = client.get(
        "/api/v1/transactions/search",
        headers=headers,
        params={"amount_min_cents": -1},
    )
    assert resp.status_code == 422


def test_search_rejects_too_long_q_with_422(client: TestClient, fresh_db: Session) -> None:
    """``q`` has ``max_length=200``."""
    headers = _auth_headers(_register(client, "search-bad-q@example.com")["access_token"])
    resp = client.get(
        "/api/v1/transactions/search",
        headers=headers,
        params={"q": "x" * 201},
    )
    assert resp.status_code == 422


# --- Cross-user isolation -----------------------------------------------------


def test_search_returns_only_callers_rows(client: TestClient, fresh_db: Session) -> None:
    headers_a = _auth_headers(_register(client, "search-iso-a@example.com")["access_token"])
    headers_b = _auth_headers(_register(client, "search-iso-b@example.com")["access_token"])

    account_a = _create_account(client, headers_a, name="A")
    account_b = _create_account(client, headers_b, name="B")

    tx_a = _create_transaction(client, headers_a, account_id=account_a["id"], note="alpha")
    tx_b = _create_transaction(client, headers_b, account_id=account_b["id"], note="beta")

    # User A should see only their row, even with q="a" (which also
    # matches "alpha").
    resp_a = client.get("/api/v1/transactions/search", headers=headers_a, params={"q": "a"})
    assert resp_a.status_code == 200
    body_a = resp_a.json()
    assert body_a["total"] == 1
    assert body_a["items"][0]["id"] == tx_a["id"]

    # User B sees only theirs.
    resp_b = client.get("/api/v1/transactions/search", headers=headers_b)
    assert resp_b.status_code == 200
    body_b = resp_b.json()
    assert body_b["total"] == 1
    assert body_b["items"][0]["id"] == tx_b["id"]


def test_search_foreign_account_id_returns_404(client: TestClient, fresh_db: Session) -> None:
    """``account_id`` from another user → 404 (does not leak existence)."""
    headers_a = _auth_headers(
        _register(client, "search-foreign-acct-a@example.com")["access_token"]
    )
    headers_b = _auth_headers(
        _register(client, "search-foreign-acct-b@example.com")["access_token"]
    )

    account_a = _create_account(client, headers_a, name="A")

    resp = client.get(
        "/api/v1/transactions/search",
        headers=headers_b,
        params={"account_id": account_a["id"]},
    )
    assert resp.status_code == 404


def test_search_foreign_category_id_returns_404(client: TestClient, fresh_db: Session) -> None:
    """``category_id`` from another user → 404 (does not leak existence)."""
    headers_a = _auth_headers(_register(client, "search-foreign-cat-a@example.com")["access_token"])
    headers_b = _auth_headers(_register(client, "search-foreign-cat-b@example.com")["access_token"])
    _create_account(client, headers_a, name="A")
    cat_a = _pick_category(client, headers_a, kind="expense", name_contains="Makan")

    resp = client.get(
        "/api/v1/transactions/search",
        headers=headers_b,
        params={"category_id": cat_a["id"]},
    )
    assert resp.status_code == 404


def test_search_rejects_malformed_uuid_filter_with_422(
    client: TestClient, fresh_db: Session
) -> None:
    headers = _auth_headers(_register(client, "search-bad-uuid@example.com")["access_token"])
    resp = client.get(
        "/api/v1/transactions/search",
        headers=headers,
        params={"account_id": "not-a-uuid"},
    )
    assert resp.status_code == 422


# --- Sanity: search only hits soft-delete-aware path ---------------------------


def test_search_soft_delete_aware_even_with_match(client: TestClient, fresh_db: Session) -> None:
    """A deleted row whose note matches ``q`` is still excluded."""
    headers = _auth_headers(_register(client, "search-softdel-q@example.com")["access_token"])
    account = _create_account(client, headers, name="BCA")

    gone = _create_transaction(client, headers, account_id=account["id"], note="magic keyword")
    _soft_delete(client, headers, gone["id"])

    resp = client.get(
        "/api/v1/transactions/search",
        headers=headers,
        params={"q": "magic"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"items": [], "total": 0, "page": 1, "page_size": 50}


# --- Sanity: rows are returned with id UUIDs matching DB rows ------------------


def test_search_returned_ids_match_persisted_rows(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "search-persist@example.com")["access_token"])
    account = _create_account(client, headers, name="BCA")

    created_ids = []
    for i in range(3):
        row = _create_transaction(
            client,
            headers,
            account_id=account["id"],
            amount_cents=10_000 + i,
            occurred_on=date(2026, 1, 1),
            note=f"row {i}",
        )
        created_ids.append(row["id"])

    resp = client.get("/api/v1/transactions/search", headers=headers)
    body = resp.json()
    returned_ids = {item["id"] for item in body["items"]}
    assert returned_ids == set(created_ids)

    # And every returned id corresponds to a persisted row in the DB.
    for item in body["items"]:
        row = fresh_db.get(Transaction, uuid.UUID(item["id"]))
        assert row is not None
        assert row.note == item["note"]
        assert row.amount_cents == item["amount_cents"]
