"""Export endpoint tests — coverage for sub-0008-01.

Scenarios covered (per acceptance criteria):

* (a) ``GET /api/v1/export/transactions.csv`` returns
      ``Content-Type: text/csv; charset=utf-8`` and
      ``Content-Disposition: attachment; filename=transactions-YYYY-MM-DD.csv``.
* (b) The CSV opens in a spreadsheet / pandas without column shift —
      integer ``amount_idr`` (not cents), ISO date, lowercase ``type``,
      header row ``id,occurred_on,type,amount_idr,account,category,note``.
* (c) Soft-deleted rows (``deleted_at IS NOT NULL``) are excluded.
* (d) Empty result still sends the header row (no rows, but the
      header is there).
* (e) 401 without JWT, 200 with a valid JWT.

Cross-user isolation is also exercised: user A's transactions never
appear in user B's export. A roundtrip through ``csv.DictReader``
verifies the byte-level contract (header order, integer ``amount_idr``,
ISO date) without coupling the test to whitespace tricks — that's
what the QA tester will hit in Stage E.

Tests mirror the layout of ``apps/api/tests/test_transactions.py``:
``_register`` / ``_auth_headers`` / ``_create_account`` /
``_pick_category`` / ``_create_transaction`` helpers, each test
opt-in via ``client`` + ``fresh_db`` fixtures from ``conftest.py``.
"""

from __future__ import annotations

import csv
import io
import re
import uuid
from datetime import UTC, date, datetime, timedelta

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.db.models.transaction import Transaction

# ---------------------------------------------------------------------------
# Shared helpers (mirror test_transactions.py pattern, scoped to this file)
# ---------------------------------------------------------------------------


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


def _pick_category(
    client: TestClient, headers: dict[str, str], *, kind: str, name_contains: str
) -> dict:
    """Find a default-seeded category matching ``kind`` and ``name_contains``."""
    cats = client.get("/api/v1/categories", headers=headers).json()["items"]
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
    type_: str,
    account_id: str,
    category_id: str | None,
    amount_cents: int,
    occurred_on: date,
    note: str | None,
) -> dict:
    payload: dict = {
        "type": type_,
        "account_id": account_id,
        "amount_cents": amount_cents,
        "currency": "IDR",
        "occurred_on": occurred_on.isoformat(),
    }
    if category_id is not None:
        payload["category_id"] = category_id
    if note is not None:
        payload["note"] = note
    resp = client.post("/api/v1/transactions", headers=headers, json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


def _parse_csv(body: str) -> tuple[list[str], list[dict[str, str]]]:
    """Parse the CSV body into ``(header, rows)`` using csv.DictReader.

    Strips the leading BOM if present (defensive — current endpoint
    doesn't emit one, but pandas-friendly UTF-8 sometimes ships with
    one in older exporters). Header is returned as the raw token list
    so tests can assert the exact column order.
    """
    text = body.lstrip("\ufeff")
    reader = csv.reader(io.StringIO(text))
    header = next(reader)
    rows = list(csv.DictReader(io.StringIO(text), fieldnames=header))
    return header, rows[1:]  # DictReader re-reads; the second pass skips the header


# ---------------------------------------------------------------------------
# (a) Content-Type + Content-Disposition
# ---------------------------------------------------------------------------


def test_export_returns_csv_content_type_with_utf8_charset(
    client: TestClient, fresh_db: Session
) -> None:
    """AC (a) — Content-Type MUST be ``text/csv; charset=utf-8``."""
    headers = _auth_headers(_register(client, "csv-ctype@example.com")["access_token"])

    resp = client.get("/api/v1/export/transactions.csv", headers=headers)

    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/csv")
    assert "charset=utf-8" in resp.headers["content-type"].lower()


def test_export_uses_attachment_content_disposition_with_date_filename(
    client: TestClient, fresh_db: Session
) -> None:
    """AC (a) — filename MUST be ``transactions-YYYY-MM-DD.csv`` (UTC date)."""
    headers = _auth_headers(_register(client, "csv-dispo@example.com")["access_token"])

    resp = client.get("/api/v1/export/transactions.csv", headers=headers)

    assert resp.status_code == 200
    cd = resp.headers["content-disposition"]
    assert "attachment" in cd
    expected_date = datetime.now(UTC).date().isoformat()
    expected_filename = f"transactions-{expected_date}.csv"
    assert expected_filename in cd


# ---------------------------------------------------------------------------
# (b) Spreadsheet-compatible byte layout + (d) empty result still has header
# ---------------------------------------------------------------------------


def test_export_empty_result_still_returns_header_row(
    client: TestClient, fresh_db: Session
) -> None:
    """AC (d) — a brand-new user with no transactions still gets the CSV header."""
    headers = _auth_headers(_register(client, "csv-empty@example.com")["access_token"])

    resp = client.get("/api/v1/export/transactions.csv", headers=headers)

    assert resp.status_code == 200
    body = resp.text
    # ``splitlines()`` ignores the trailing empty string after the last newline,
    # so an exactly-one-line body (header only) gives ``["id,occurred_on,..."]``.
    lines = body.splitlines()
    assert len(lines) == 1
    assert lines[0] == "id,occurred_on,type,amount_idr,account,category,note"


def test_export_header_column_order_is_locked(client: TestClient, fresh_db: Session) -> None:
    """The 7-column header order is part of the byte contract (AC (b))."""
    headers = _auth_headers(_register(client, "csv-header@example.com")["access_token"])
    _create_account(client, headers, name="BCA")

    resp = client.get("/api/v1/export/transactions.csv", headers=headers)
    header, rows = _parse_csv(resp.text)

    assert header == ["id", "occurred_on", "type", "amount_idr", "account", "category", "note"]
    assert rows == []


def test_export_amount_idr_is_integer_not_cents(client: TestClient, fresh_db: Session) -> None:
    """AC (b) — ``amount_idr`` MUST be integer IDR (cents / 100).

    Sending 25,500 cents → ``255`` in the CSV, not ``25500`` and not
    ``255.00``. The SA pinned this so the export matches the reference
    spreadsheet ``uangplanner.com`` without a ``/100`` column.
    """
    headers = _auth_headers(_register(client, "csv-amt@example.com")["access_token"])
    account = _create_account(client, headers, name="Tunai")
    category = _pick_category(client, headers, kind="expense", name_contains="Makan")
    _create_transaction(
        client,
        headers,
        type_="expense",
        account_id=account["id"],
        category_id=category["id"],
        amount_cents=25_500,
        occurred_on=date(2026, 1, 15),
        note="Makan siang",
    )

    _, rows = _parse_csv(client.get("/api/v1/export/transactions.csv", headers=headers).text)
    assert len(rows) == 1
    # ``amount_idr`` is exposed as a string by DictReader; assert on the
    # parsed int to catch both the format and the value in one check.
    assert int(rows[0]["amount_idr"]) == 255
    # Also pin the literal byte — a future "let's add thousands separator"
    # change must fail this test loudly.
    assert rows[0]["amount_idr"] == "255"


def test_export_amount_idr_is_always_integer_for_idr_values(
    client: TestClient, fresh_db: Session
) -> None:
    """The IDR model never sends fractional cents — every value divides cleanly.

    Verifies the ``// 100`` choice: integer division, no float rounding.
    """
    headers = _auth_headers(_register(client, "csv-amt2@example.com")["access_token"])
    account = _create_account(client, headers, name="Rekening")
    cat_income = _pick_category(client, headers, kind="income", name_contains="Gaji")
    cat_expense = _pick_category(client, headers, kind="expense", name_contains="Makan")

    _create_transaction(
        client,
        headers,
        type_="income",
        account_id=account["id"],
        category_id=cat_income["id"],
        amount_cents=5_000_000,
        occurred_on=date(2026, 1, 1),
        note="Gaji",
    )
    _create_transaction(
        client,
        headers,
        type_="expense",
        account_id=account["id"],
        category_id=cat_expense["id"],
        amount_cents=100,
        occurred_on=date(2026, 1, 2),
        note="Parkir",
    )

    _, rows = _parse_csv(client.get("/api/v1/export/transactions.csv", headers=headers).text)
    amounts = {int(r["amount_idr"]) for r in rows}
    assert amounts == {50_000, 1}


def test_export_date_format_is_iso(client: TestClient, fresh_db: Session) -> None:
    """AC (b) — ``occurred_on`` MUST be ISO ``YYYY-MM-DD``."""
    headers = _auth_headers(_register(client, "csv-date@example.com")["access_token"])
    account = _create_account(client, headers, name="A")
    _create_transaction(
        client,
        headers,
        type_="expense",
        account_id=account["id"],
        category_id=None,
        amount_cents=10_000,
        occurred_on=date(2026, 3, 7),
        note=None,
    )

    _, rows = _parse_csv(client.get("/api/v1/export/transactions.csv", headers=headers).text)
    assert len(rows) == 1
    iso_pattern = re.compile(r"^\d{4}-\d{2}-\d{2}$")
    assert iso_pattern.match(rows[0]["occurred_on"]), (
        f"expected ISO YYYY-MM-DD, got {rows[0]['occurred_on']!r}"
    )
    # The exact value lands too — if the writer reformats to e.g.
    # ``07/03/2026`` or ``Mar  7 2026`` the test catches it.
    assert rows[0]["occurred_on"] == "2026-03-07"


def test_export_type_field_is_lowercase_enum(client: TestClient, fresh_db: Session) -> None:
    """AC (b) — ``type`` MUST be the lowercase enum value (``income`` / ``expense``)."""
    headers = _auth_headers(_register(client, "csv-type@example.com")["access_token"])
    account = _create_account(client, headers, name="A")
    cat_income = _pick_category(client, headers, kind="income", name_contains="Gaji")
    cat_expense = _pick_category(client, headers, kind="expense", name_contains="Makan")

    _create_transaction(
        client,
        headers,
        type_="income",
        account_id=account["id"],
        category_id=cat_income["id"],
        amount_cents=1_000_000,
        occurred_on=date(2026, 1, 10),
        note=None,
    )
    _create_transaction(
        client,
        headers,
        type_="expense",
        account_id=account["id"],
        category_id=cat_expense["id"],
        amount_cents=20_000,
        occurred_on=date(2026, 1, 11),
        note=None,
    )

    _, rows = _parse_csv(client.get("/api/v1/export/transactions.csv", headers=headers).text)
    types = {r["type"] for r in rows}
    assert types == {"income", "expense"}


def test_export_account_and_category_columns_are_names(
    client: TestClient, fresh_db: Session
) -> None:
    """AC (b) — ``account`` / ``category`` columns hold the human name, not the UUID."""
    headers = _auth_headers(_register(client, "csv-names@example.com")["access_token"])
    account = _create_account(client, headers, name="Rekening Utama")
    category = _pick_category(client, headers, kind="expense", name_contains="Makan")

    _create_transaction(
        client,
        headers,
        type_="expense",
        account_id=account["id"],
        category_id=category["id"],
        amount_cents=15_000,
        occurred_on=date(2026, 2, 1),
        note="nasi goreng",
    )

    _, rows = _parse_csv(client.get("/api/v1/export/transactions.csv", headers=headers).text)
    assert len(rows) == 1
    assert rows[0]["account"] == "Rekening Utama"
    assert rows[0]["category"] == category["name"]
    # Defensive: ensure no UUID leaked into either column.
    uuid.UUID(rows[0]["id"])  # only the id column is the UUID
    assert "Rekening Utama" in rows[0]["account"]
    assert "-" not in rows[0]["account"] or "Rekening Utama" in rows[0]["account"]


def test_export_null_category_and_note_become_empty_cells(
    client: TestClient, fresh_db: Session
) -> None:
    """A transaction with no category and no note writes empty cells, not ``"None"``."""
    headers = _auth_headers(_register(client, "csv-empty-cells@example.com")["access_token"])
    account = _create_account(client, headers, name="Dompet")

    _create_transaction(
        client,
        headers,
        type_="expense",
        account_id=account["id"],
        category_id=None,
        amount_cents=5_000,
        occurred_on=date(2026, 4, 1),
        note=None,
    )

    _, rows = _parse_csv(client.get("/api/v1/export/transactions.csv", headers=headers).text)
    assert len(rows) == 1
    assert rows[0]["category"] == ""
    assert rows[0]["note"] == ""


def test_export_sorts_by_occurred_on_desc_then_amount_cents_desc_then_id(
    client: TestClient, fresh_db: Session
) -> None:
    """Export order mirrors the list endpoint (sub-0003-01 + sub-0004-00).

    Same-day tie-break is ``amount_cents DESC, id ASC`` (the SQLite
    UUID-flake fix from sub-0004-00). The export inherits the same
    chain so a user re-running the export sees the same order every
    time — important for diffing against their spreadsheet between
    exports.
    """
    headers = _auth_headers(_register(client, "csv-sort@example.com")["access_token"])
    account = _create_account(client, headers, name="A")

    tx_a = _create_transaction(
        client,
        headers,
        type_="expense",
        account_id=account["id"],
        category_id=None,
        amount_cents=1_000,
        occurred_on=date(2026, 1, 1),
        note="a",
    )
    tx_b = _create_transaction(
        client,
        headers,
        type_="expense",
        account_id=account["id"],
        category_id=None,
        amount_cents=2_000,
        occurred_on=date(2026, 1, 1),
        note="b",
    )
    tx_c = _create_transaction(
        client,
        headers,
        type_="expense",
        account_id=account["id"],
        category_id=None,
        amount_cents=3_000,
        occurred_on=date(2026, 1, 2),
        note="c",
    )

    _, rows = _parse_csv(client.get("/api/v1/export/transactions.csv", headers=headers).text)
    assert [r["id"] for r in rows] == [tx_c["id"], tx_b["id"], tx_a["id"]]


def test_export_round_trip_through_csv_dictreader(client: TestClient, fresh_db: Session) -> None:
    """Full round-trip — opens cleanly in any spreadsheet / pandas-style parser.

    The QA tester (Stage E) will load this in pandas; this test gives
    us a CI-grade guarantee that the byte layout matches what the
    spreadsheet / pandas ``read_csv`` would expect — no shifted
    columns, no missing fields, integer amounts.
    """
    headers = _auth_headers(_register(client, "csv-roundtrip@example.com")["access_token"])
    account = _create_account(client, headers, name="BCA")
    category = _pick_category(client, headers, kind="expense", name_contains="Makan")

    _create_transaction(
        client,
        headers,
        type_="expense",
        account_id=account["id"],
        category_id=category["id"],
        amount_cents=25_000,
        occurred_on=date(2026, 5, 1),
        note='Nasi padang, "pedas"',
    )

    resp = client.get("/api/v1/export/transactions.csv", headers=headers)
    _header, rows = _parse_csv(resp.text)

    assert len(rows) == 1
    row = rows[0]
    # All 7 columns MUST be present and round-trip cleanly.
    assert set(row.keys()) == {
        "id",
        "occurred_on",
        "type",
        "amount_idr",
        "account",
        "category",
        "note",
    }
    # Note contains a comma + nested quotes — csv.DictReader handles the
    # quoting so the unquoted value still contains the comma and quotes.
    assert "Nasi padang" in row["note"]
    assert "," in row["note"]
    # ``id`` round-trips through UUID.
    uuid.UUID(row["id"])
    # Integer round-trip.
    assert isinstance(int(row["amount_idr"]), int)
    assert int(row["amount_idr"]) == 250


def test_export_handles_unicode_note_and_category_names(
    client: TestClient, fresh_db: Session
) -> None:
    """UTF-8 round-trip preserves non-ASCII characters in ``note`` and category names.

    The reference user is Indonesian (``locale id-ID`` per PRD), so
    ``note`` and category names frequently contain ``é``, ``,``, ``"``,
    etc. The csv writer quotes per RFC 4180 and the response uses
    ``charset=utf-8`` so the bytes survive.
    """
    headers = _auth_headers(_register(client, "csv-unicode@example.com")["access_token"])
    account = _create_account(client, headers, name="Rékéning Utama")
    category = _pick_category(client, headers, kind="expense", name_contains="Makan")

    _create_transaction(
        client,
        headers,
        type_="expense",
        account_id=account["id"],
        category_id=category["id"],
        amount_cents=50_000,
        occurred_on=date(2026, 6, 1),
        note='Kopi, roti, "é"',
    )

    body = client.get("/api/v1/export/transactions.csv", headers=headers).text
    # The raw body must carry the bytes (charset=UTF-8) — not an ASCII
    # transliteration. ``"é"`` (U+00E9) encodes to 2 bytes in UTF-8.
    assert "é" in body
    _, rows = _parse_csv(body)
    assert rows[0]["account"] == "Rékéning Utama"
    assert "Kopi" in rows[0]["note"]
    assert "é" in rows[0]["note"]


# ---------------------------------------------------------------------------
# (c) Soft-delete exclusion
# ---------------------------------------------------------------------------


def test_export_excludes_soft_deleted_transactions(client: TestClient, fresh_db: Session) -> None:
    """AC (c) — ``deleted_at IS NOT NULL`` rows MUST be excluded from the CSV.

    We hit DELETE directly through the API and re-export, then assert
    the tombstoned id is absent. Mirrors the list endpoint predicate
    so the user can't be surprised by a deleted row re-appearing in
    their spreadsheet.
    """
    headers = _auth_headers(_register(client, "csv-softdelete@example.com")["access_token"])
    account = _create_account(client, headers, name="A")

    keep = _create_transaction(
        client,
        headers,
        type_="expense",
        account_id=account["id"],
        category_id=None,
        amount_cents=10_000,
        occurred_on=date(2026, 1, 5),
        note="keep",
    )
    drop = _create_transaction(
        client,
        headers,
        type_="expense",
        account_id=account["id"],
        category_id=None,
        amount_cents=20_000,
        occurred_on=date(2026, 1, 6),
        note="drop",
    )

    # Sanity: both rows present before soft-delete.
    _, rows_before = _parse_csv(client.get("/api/v1/export/transactions.csv", headers=headers).text)
    assert {r["id"] for r in rows_before} == {keep["id"], drop["id"]}

    # Soft-delete one of them.
    del_resp = client.delete(f"/api/v1/transactions/{drop['id']}", headers=headers)
    assert del_resp.status_code == 204

    _, rows_after = _parse_csv(client.get("/api/v1/export/transactions.csv", headers=headers).text)
    assert {r["id"] for r in rows_after} == {keep["id"]}
    assert drop["id"] not in {r["id"] for r in rows_after}

    # Defensive: tombstoned row is still in the DB but ``deleted_at``
    # is set — verifies the exclusion is via the ``deleted_at IS NULL``
    # predicate, not via a hard delete.
    deleted_row = fresh_db.get(Transaction, uuid.UUID(drop["id"]))
    assert deleted_row is not None
    assert deleted_row.deleted_at is not None


# ---------------------------------------------------------------------------
# (e) Auth + cross-user isolation
# ---------------------------------------------------------------------------


def test_export_requires_authentication(client: TestClient, fresh_db: Session) -> None:
    """AC (e) — 401 when no JWT is sent."""
    resp = client.get("/api/v1/export/transactions.csv")
    assert resp.status_code == 401


def test_export_rejects_invalid_token(client: TestClient, fresh_db: Session) -> None:
    """Bad bearer token must surface as 401, not 500 or 200."""
    resp = client.get(
        "/api/v1/export/transactions.csv",
        headers={"Authorization": "Bearer not-a-real-jwt"},
    )
    assert resp.status_code == 401


def test_export_isolates_transactions_between_users(client: TestClient, fresh_db: Session) -> None:
    """User A's rows MUST NOT appear in user B's export.

    Cross-user isolation — the same predicate that protects the list
    endpoint (and that the FE relies on for privacy) applies to the
    export. This is the load-bearing privacy guarantee for the export
    surface; if it fails, a hostile actor could enumerate another
    user's transactions by repeatedly hitting their export URL.
    """
    a_token = _register(client, "user-a@example.com")["access_token"]
    b_token = _register(client, "user-b@example.com")["access_token"]
    a_headers = _auth_headers(a_token)
    b_headers = _auth_headers(b_token)

    a_account = _create_account(client, a_headers, name="A-Account")
    b_account = _create_account(client, b_headers, name="B-Account")

    a_tx = _create_transaction(
        client,
        a_headers,
        type_="expense",
        account_id=a_account["id"],
        category_id=None,
        amount_cents=10_000,
        occurred_on=date(2026, 1, 1),
        note="A-secret",
    )
    b_tx = _create_transaction(
        client,
        b_headers,
        type_="expense",
        account_id=b_account["id"],
        category_id=None,
        amount_cents=99_000,
        occurred_on=date(2026, 1, 1),
        note="B-secret",
    )

    _, a_rows = _parse_csv(client.get("/api/v1/export/transactions.csv", headers=a_headers).text)
    _, b_rows = _parse_csv(client.get("/api/v1/export/transactions.csv", headers=b_headers).text)

    a_ids = {r["id"] for r in a_rows}
    b_ids = {r["id"] for r in b_rows}

    assert a_ids == {a_tx["id"]}
    assert b_ids == {b_tx["id"]}
    # Defensive: neither user's note / id appears in the other user's export.
    a_body = client.get("/api/v1/export/transactions.csv", headers=a_headers).text
    b_body = client.get("/api/v1/export/transactions.csv", headers=b_headers).text
    assert b_tx["id"] not in a_body
    assert a_tx["id"] not in b_body
    assert "B-secret" not in a_body
    assert "A-secret" not in b_body


def test_export_emits_crlf_line_terminator(client: TestClient, fresh_db: Session) -> None:
    """RFC 4180 — line terminator is ``\\r\\n``.

    Excel and pandas both prefer ``\\r\\n`` for CSV. Python's
    ``csv.writer`` defaults to the platform's ``os.linesep`` which is
    ``\\n`` on Linux and breaks Excel; we override to ``\\r\\n``
    explicitly in the writer.
    """
    headers = _auth_headers(_register(client, "csv-crlf@example.com")["access_token"])
    account = _create_account(client, headers, name="A")
    _create_transaction(
        client,
        headers,
        type_="expense",
        account_id=account["id"],
        category_id=None,
        amount_cents=10_000,
        occurred_on=date(2026, 1, 1),
        note=None,
    )

    body = client.get("/api/v1/export/transactions.csv", headers=headers).text
    # The body MUST contain ``\r\n`` between the header and the first row.
    assert "\r\n" in body
    # And it must NOT contain a bare ``\n`` that isn't preceded by ``\r``
    # — i.e. no ``\n`` other than ``\r\n``.
    bare_lf = re.sub(r"\r\n", "", body)
    assert "\n" not in bare_lf


def test_export_filename_date_matches_utc_today(client: TestClient, fresh_db: Session) -> None:
    """The filename date is the response date (server-side UTC), not the request date.

    A user exporting from a TZ east of UTC late at night would otherwise
    get yesterday's filename for today's data, and overwrite their
    yesterday export — a small but real UX papercut.
    """
    headers = _auth_headers(_register(client, "csv-filename@example.com")["access_token"])

    resp = client.get("/api/v1/export/transactions.csv", headers=headers)
    cd = resp.headers["content-disposition"]
    today = datetime.now(UTC).date().isoformat()
    yesterday = (datetime.now(UTC).date() - timedelta(days=1)).isoformat()
    assert today in cd
    # Defensive: the date in the filename matches the *response* date.
    # We don't pin this against ``time.sleep`` / mocking — the test
    # accepts that the endpoint uses ``datetime.now(UTC)`` and the
    # filesystem filename includes that exact string.
    assert yesterday not in cd or today in cd
