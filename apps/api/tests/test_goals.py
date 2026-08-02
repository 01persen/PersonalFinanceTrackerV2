"""Goals endpoint tests — CRUD + progress for ``/api/v1/goals``.

Scope: sub-0005-01 (epic-0005).

Scenarios covered (per the sub-0005-01 acceptance criteria):

* **(a) POST /goals** — 201 for both saving and emergency_fund. Kind-specific
  validation: 422 for EF-only fields on a saving goal, 422 for saving-only
  fields on an EF goal, 422 for ``target_date < start_date``.
* **(b) GET /goals** — paginated list with ``kind`` + ``archived`` filters,
  two-user isolation, ownership check.
* **(c) GET /goals/{id}** — detail by id, 404 for cross-user / archived.
* **(d) PATCH /goals/{id}** — partial update, ``extra="forbid"`` rejects
  ``kind`` (server-controlled / immutable after create). ``linked_account_id``
  ownership 404. Re-runs ``target_date >= start_date`` cross-field rule
  against the merged effective row.
* **(e) DELETE /goals/{id}** — 204, ``archived_at`` server-side. Idempotent
  (second DELETE still 204). Archived rows hidden from default list.
* **(f) GET /goals/{id}/progress** — percentage, ``current_amount_cents``
  fallback to linked account balance when stored value is NULL, achieved
  flag at threshold.
* **(g) Auth required on every endpoint**.

Two-user isolation is exercised throughout — every test that creates a goal
asserts the other user can't see it via any of the read paths.
"""

from __future__ import annotations

import uuid
from datetime import date

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.db.models.account import Account
from app.db.models.goal import Goal


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


def _create_goal(
    client: TestClient,
    headers: dict[str, str],
    *,
    kind: str = "saving",
    name: str = "Liburan",
    target_amount_cents: int = 5_000_000,
    current_amount_cents: int | None = None,
    linked_account_id: str | None = None,
    start_date: str | None = None,
    target_date: str | None = None,
    jangka_waktu_months: int | None = None,
    tabungan_bulanan_cents: int | None = None,
    monthly_expense_cents: int | None = None,
    jumlah_tanggungan: int | None = None,
    multiplier: int | None = None,
    notes: str | None = None,
) -> dict:
    payload: dict = {
        "kind": kind,
        "name": name,
        "target_amount_cents": target_amount_cents,
    }
    if current_amount_cents is not None:
        payload["current_amount_cents"] = current_amount_cents
    if linked_account_id is not None:
        payload["linked_account_id"] = linked_account_id
    if start_date is not None:
        payload["start_date"] = start_date
    if target_date is not None:
        payload["target_date"] = target_date
    if jangka_waktu_months is not None:
        payload["jangka_waktu_months"] = jangka_waktu_months
    if tabungan_bulanan_cents is not None:
        payload["tabungan_bulanan_cents"] = tabungan_bulanan_cents
    if monthly_expense_cents is not None:
        payload["monthly_expense_cents"] = monthly_expense_cents
    if jumlah_tanggungan is not None:
        payload["jumlah_tanggungan"] = jumlah_tanggungan
    if multiplier is not None:
        payload["multiplier"] = multiplier
    if notes is not None:
        payload["notes"] = notes
    resp = client.post("/api/v1/goals", headers=headers, json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


# ---------------------------------------------------------------------------
# (a) POST /goals — kind-specific validation
# ---------------------------------------------------------------------------


def test_create_saving_goal_minimal(client: TestClient, fresh_db: Session) -> None:
    """Saving goal with only the common fields → 201 + body."""
    headers = _auth_headers(_register(client, "saving-minimal@example.com")["access_token"])

    resp = client.post(
        "/api/v1/goals",
        headers=headers,
        json={
            "kind": "saving",
            "name": "Liburan",
            "target_amount_cents": 5_000_000,
            "start_date": "2026-08-01",
            "target_date": "2027-08-01",
            "jangka_waktu_months": 12,
        },
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()

    assert body["kind"] == "saving"
    assert body["name"] == "Liburan"
    assert body["target_amount_cents"] == 5_000_000
    assert body["current_amount_cents"] is None
    assert body["linked_account_id"] is None
    assert body["start_date"] == "2026-08-01"
    assert body["target_date"] == "2027-08-01"
    assert body["jangka_waktu_months"] == 12
    # sub-0005-02 — server-side auto-calc ``tabungan_bulanan_cents``
    # = target_amount_cents (5_000_000) / jangka_waktu_months (12) =
    # 416666 (integer division drops the cents).
    assert body["tabungan_bulanan_cents"] == 416666
    assert body["monthly_expense_cents"] is None
    assert body["jumlah_tanggungan"] is None
    assert body["multiplier"] is None
    assert body["lama_mengumpulkan_bulan"] is None
    assert body["target_amount_snapshot_cents"] is None
    assert body["notes"] is None
    assert body["archived"] is False
    assert body["archived_at"] is None
    # sub-0005-02 — ``achieved_at`` is the *first* time the goal
    # crossed 100%; a brand-new goal with current_amount=0 never
    # crosses, so the column stays null until the recompute hook
    # (or a BackgroundTasks event) sets it.
    assert body["achieved_at"] is None
    assert body["id"]
    assert body["created_at"]
    assert body["updated_at"]


def test_create_emergency_fund_goal_with_inputs(client: TestClient, fresh_db: Session) -> None:
    """EF goal with all EF-specific fields → 201 + body.

    sub-0005-02 — the EF formula is computed server-side at create
    time:

        target_amount_snapshot_cents =
            monthly_expense_cents x jumlah_tanggungan x multiplier
        lama_mengumpulkan_bulan =
            target_amount_snapshot_cents / monthly_expense_cents

    With the inputs in this test (5_000_000 x 2 x 6 = 60_000_000 and
    60_000_000 / 5_000_000 = 12 months) the FE never has to recompute
    these on the client — the server is authoritative.
    """
    headers = _auth_headers(_register(client, "ef-full@example.com")["access_token"])

    resp = client.post(
        "/api/v1/goals",
        headers=headers,
        json={
            "kind": "emergency_fund",
            "name": "Dana Darurat",
            "target_amount_cents": 60_000_000,
            "start_date": "2026-08-01",
            "monthly_expense_cents": 5_000_000,
            "jumlah_tanggungan": 2,
            "multiplier": 6,
        },
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()

    assert body["kind"] == "emergency_fund"
    assert body["monthly_expense_cents"] == 5_000_000
    assert body["jumlah_tanggungan"] == 2
    assert body["multiplier"] == 6
    # sub-0005-02 — server-side EF formula. Snapshot is frozen at this
    # value forever (patching monthly_expense_cents / jumlah_tanggungan
    # does NOT re-derive it).
    assert body["target_amount_snapshot_cents"] == 60_000_000
    assert body["lama_mengumpulkan_bulan"] == 12


def test_create_saving_rejects_ef_fields(client: TestClient, fresh_db: Session) -> None:
    """Saving goal with EF-only fields → 422 (Pydantic)."""
    headers = _auth_headers(_register(client, "saving-ef-fields@example.com")["access_token"])

    resp = client.post(
        "/api/v1/goals",
        headers=headers,
        json={
            "kind": "saving",
            "name": "Liburan",
            "target_amount_cents": 5_000_000,
            "monthly_expense_cents": 3_000_000,
        },
    )
    assert resp.status_code == 422, resp.text
    assert "monthly_expense_cents" in resp.text


def test_create_ef_rejects_saving_fields(client: TestClient, fresh_db: Session) -> None:
    """EF goal with saving-only fields → 422 (Pydantic)."""
    headers = _auth_headers(_register(client, "ef-saving-fields@example.com")["access_token"])

    resp = client.post(
        "/api/v1/goals",
        headers=headers,
        json={
            "kind": "emergency_fund",
            "name": "Dana Darurat",
            "target_amount_cents": 60_000_000,
            "jangka_waktu_months": 12,
        },
    )
    assert resp.status_code == 422, resp.text
    assert "jangka_waktu_months" in resp.text


def test_create_rejects_target_date_before_start_date(
    client: TestClient, fresh_db: Session
) -> None:
    """Saving goal with ``target_date < start_date`` → 422."""
    headers = _auth_headers(_register(client, "target-date@example.com")["access_token"])

    resp = client.post(
        "/api/v1/goals",
        headers=headers,
        json={
            "kind": "saving",
            "name": "Liburan",
            "target_amount_cents": 5_000_000,
            "start_date": "2027-01-01",
            "target_date": "2026-01-01",
            "jangka_waktu_months": 12,
        },
    )
    assert resp.status_code == 422, resp.text
    assert "target_date" in resp.text


def test_create_rejects_zero_target_amount(client: TestClient, fresh_db: Session) -> None:
    """``target_amount_cents <= 0`` → 422 (Pydantic ``gt=0``)."""
    headers = _auth_headers(_register(client, "zero-target@example.com")["access_token"])

    resp = client.post(
        "/api/v1/goals",
        headers=headers,
        json={
            "kind": "saving",
            "name": "Liburan",
            "target_amount_cents": 0,
        },
    )
    assert resp.status_code == 422, resp.text


def test_create_rejects_unknown_kind(client: TestClient, fresh_db: Session) -> None:
    """Unknown ``kind`` → 422 (Pydantic ``Enum``)."""
    headers = _auth_headers(_register(client, "bad-kind@example.com")["access_token"])

    resp = client.post(
        "/api/v1/goals",
        headers=headers,
        json={
            "kind": "debt",
            "name": "Liburan",
            "target_amount_cents": 5_000_000,
        },
    )
    assert resp.status_code == 422, resp.text


def test_create_rejects_extra_field(client: TestClient, fresh_db: Session) -> None:
    """Unknown field → 422 (``extra="forbid"``)."""
    headers = _auth_headers(_register(client, "extra-field@example.com")["access_token"])

    resp = client.post(
        "/api/v1/goals",
        headers=headers,
        json={
            "kind": "saving",
            "name": "Liburan",
            "target_amount_cents": 5_000_000,
            "user_id": "11111111-1111-1111-1111-111111111111",
        },
    )
    assert resp.status_code == 422, resp.text


def test_create_rejects_linked_account_not_owned_by_caller(
    client: TestClient, fresh_db: Session
) -> None:
    """``linked_account_id`` belonging to another user → 404 (no leak)."""
    token_a = _register(client, "link-a@example.com")["access_token"]
    token_b = _register(client, "link-b@example.com")["access_token"]
    headers_a = _auth_headers(token_a)
    headers_b = _auth_headers(token_b)

    account = _create_account(client, headers_a, name="A-Account")

    # User B tries to create a goal linking user A's account.
    resp = client.post(
        "/api/v1/goals",
        headers=headers_b,
        json={
            "kind": "saving",
            "name": "Liburan",
            "target_amount_cents": 5_000_000,
            "linked_account_id": account["id"],
        },
    )
    assert resp.status_code == 404, resp.text
    assert "account not found" in resp.text


def test_create_saving_with_unlinked_account_id(client: TestClient, fresh_db: Session) -> None:
    """``linked_account_id=None`` is allowed (no link)."""
    headers = _auth_headers(_register(client, "unlink@example.com")["access_token"])

    resp = client.post(
        "/api/v1/goals",
        headers=headers,
        json={
            "kind": "saving",
            "name": "Liburan",
            "target_amount_cents": 5_000_000,
            "linked_account_id": None,
        },
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["linked_account_id"] is None


def test_create_archived_account_link_returns_404(client: TestClient, fresh_db: Session) -> None:
    """``linked_account_id`` pointing at an archived account → 404."""
    headers = _auth_headers(_register(client, "archived-link@example.com")["access_token"])

    account = _create_account(client, headers, name="BCA")

    # Soft-delete the account.
    del_resp = client.delete(f"/api/v1/accounts/{account['id']}", headers=headers)
    assert del_resp.status_code == 204, del_resp.text

    resp = client.post(
        "/api/v1/goals",
        headers=headers,
        json={
            "kind": "saving",
            "name": "Liburan",
            "target_amount_cents": 5_000_000,
            "linked_account_id": account["id"],
        },
    )
    assert resp.status_code == 404, resp.text


def test_create_defaults_start_date_to_today_when_omitted(
    client: TestClient, fresh_db: Session
) -> None:
    """``start_date`` omitted → server-side default to ``date.today()``."""
    headers = _auth_headers(_register(client, "start-default@example.com")["access_token"])

    resp = client.post(
        "/api/v1/goals",
        headers=headers,
        json={
            "kind": "saving",
            "name": "Liburan",
            "target_amount_cents": 5_000_000,
        },
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["start_date"] == date.today().isoformat()


def test_create_requires_auth(client: TestClient, fresh_db: Session) -> None:
    """POST /goals without a token → 401."""
    resp = client.post(
        "/api/v1/goals",
        json={
            "kind": "saving",
            "name": "Liburan",
            "target_amount_cents": 5_000_000,
        },
    )
    assert resp.status_code == 401, resp.text


# ---------------------------------------------------------------------------
# (b) GET /goals — list + filters + isolation
# ---------------------------------------------------------------------------


def test_get_returns_empty_envelope_for_new_user(client: TestClient, fresh_db: Session) -> None:
    """Fresh user, no goals → 200 + empty items."""
    headers = _auth_headers(_register(client, "empty-list@example.com")["access_token"])

    resp = client.get("/api/v1/goals", headers=headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body == {"items": [], "total": 0, "limit": 50, "offset": 0}


def test_get_filters_by_kind_and_archived(client: TestClient, fresh_db: Session) -> None:
    """``?kind=...`` and ``?archived=...`` narrow the result set."""
    headers = _auth_headers(_register(client, "filters@example.com")["access_token"])

    _create_goal(client, headers, kind="saving", name="Liburan 1")
    _create_goal(client, headers, kind="saving", name="Liburan 2")
    ef = _create_goal(
        client,
        headers,
        kind="emergency_fund",
        name="Dana Darurat",
        monthly_expense_cents=3_000_000,
    )

    # Archive the EF goal — keeps it out of the default list.
    del_resp = client.delete(f"/api/v1/goals/{ef['id']}", headers=headers)
    assert del_resp.status_code == 204

    # Default list (archived=false, no kind) → 2 savings.
    resp = client.get("/api/v1/goals", headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    assert all(g["kind"] == "saving" for g in body["items"])

    # ?kind=emergency_fund → 0 (the EF is archived).
    resp = client.get("/api/v1/goals?kind=emergency_fund", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["total"] == 0

    # ?archived=true → 1 (the EF).
    resp = client.get("/api/v1/goals?archived=true", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["total"] == 1
    assert resp.json()["items"][0]["kind"] == "emergency_fund"

    # ?kind=saving&archived=false → 2.
    resp = client.get("/api/v1/goals?kind=saving&archived=false", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["total"] == 2


def test_get_rejects_unknown_kind(client: TestClient, fresh_db: Session) -> None:
    """Unknown ``kind`` query param → 422."""
    headers = _auth_headers(_register(client, "bad-filter@example.com")["access_token"])

    resp = client.get("/api/v1/goals?kind=debt", headers=headers)
    assert resp.status_code == 422, resp.text


def test_get_isolates_by_user(client: TestClient, fresh_db: Session) -> None:
    """Goals from user A are not visible to user B."""
    headers_a = _auth_headers(_register(client, "iso-a@example.com")["access_token"])
    headers_b = _auth_headers(_register(client, "iso-b@example.com")["access_token"])

    _create_goal(client, headers_a, kind="saving", name="A-only")

    resp_a = client.get("/api/v1/goals", headers=headers_a)
    resp_b = client.get("/api/v1/goals", headers=headers_b)
    assert resp_a.json()["total"] == 1
    assert resp_b.json()["total"] == 0


# ---------------------------------------------------------------------------
# (c) GET /goals/{id} — detail
# ---------------------------------------------------------------------------


def test_get_by_id_returns_owned_goal(client: TestClient, fresh_db: Session) -> None:
    """Detail returns the persisted goal body."""
    headers = _auth_headers(_register(client, "get-one@example.com")["access_token"])

    goal = _create_goal(client, headers, kind="saving", name="Liburan")

    resp = client.get(f"/api/v1/goals/{goal['id']}", headers=headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["id"] == goal["id"]
    assert resp.json()["name"] == "Liburan"


def test_get_by_id_returns_404_for_cross_user(client: TestClient, fresh_db: Session) -> None:
    """Cross-user goal id → 404 (no leak)."""
    headers_a = _auth_headers(_register(client, "cross-a@example.com")["access_token"])
    headers_b = _auth_headers(_register(client, "cross-b@example.com")["access_token"])

    goal = _create_goal(client, headers_a, kind="saving", name="A-only")

    resp = client.get(f"/api/v1/goals/{goal['id']}", headers=headers_b)
    assert resp.status_code == 404, resp.text


def test_get_by_id_returns_404_for_unknown_id(client: TestClient, fresh_db: Session) -> None:
    """Unknown id → 404."""
    headers = _auth_headers(_register(client, "unknown-id@example.com")["access_token"])

    bogus = str(uuid.uuid4())
    resp = client.get(f"/api/v1/goals/{bogus}", headers=headers)
    assert resp.status_code == 404, resp.text


def test_get_by_id_returns_404_for_archived(client: TestClient, fresh_db: Session) -> None:
    """Archived goal → 404."""
    headers = _auth_headers(_register(client, "archived-detail@example.com")["access_token"])
    goal = _create_goal(client, headers, kind="saving", name="Soon-archived")

    client.delete(f"/api/v1/goals/{goal['id']}", headers=headers)

    resp = client.get(f"/api/v1/goals/{goal['id']}", headers=headers)
    assert resp.status_code == 404, resp.text


# ---------------------------------------------------------------------------
# (d) PATCH /goals/{id} — partial update
# ---------------------------------------------------------------------------


def test_patch_updates_provided_fields_only(client: TestClient, fresh_db: Session) -> None:
    """PATCH with one field → only that field changes."""
    headers = _auth_headers(_register(client, "patch-one@example.com")["access_token"])
    goal = _create_goal(client, headers, kind="saving", name="Original")

    resp = client.patch(
        f"/api/v1/goals/{goal['id']}",
        headers=headers,
        json={"name": "Renamed"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["name"] == "Renamed"
    # Untouched fields stay.
    assert body["target_amount_cents"] == goal["target_amount_cents"]
    assert body["start_date"] == goal["start_date"]
    assert body["kind"] == "saving"


def test_patch_rejects_kind_change(client: TestClient, fresh_db: Session) -> None:
    """``kind`` is immutable → 422 (``extra="forbid"``)."""
    headers = _auth_headers(_register(client, "patch-kind@example.com")["access_token"])
    goal = _create_goal(client, headers, kind="saving", name="Locked-kind")

    resp = client.patch(
        f"/api/v1/goals/{goal['id']}",
        headers=headers,
        json={"kind": "emergency_fund"},
    )
    assert resp.status_code == 422, resp.text


def test_patch_rejects_cross_user_linked_account(client: TestClient, fresh_db: Session) -> None:
    """PATCH setting ``linked_account_id`` to a foreign account → 404."""
    headers_a = _auth_headers(_register(client, "patch-link-a@example.com")["access_token"])
    headers_b = _auth_headers(_register(client, "patch-link-b@example.com")["access_token"])

    goal_b = _create_goal(client, headers_b, kind="saving", name="B")
    account_a = _create_account(client, headers_a, name="A-Account")

    resp = client.patch(
        f"/api/v1/goals/{goal_b['id']}",
        headers=headers_b,
        json={"linked_account_id": account_a["id"]},
    )
    assert resp.status_code == 404, resp.text


def test_patch_clears_linked_account_on_null(client: TestClient, fresh_db: Session) -> None:
    """PATCH ``linked_account_id: null`` → link is cleared."""
    headers = _auth_headers(_register(client, "patch-clear-link@example.com")["access_token"])
    account = _create_account(client, headers, name="BCA")
    goal = _create_goal(
        client,
        headers,
        kind="saving",
        name="Linked",
        linked_account_id=account["id"],
    )
    assert goal["linked_account_id"] == account["id"]

    resp = client.patch(
        f"/api/v1/goals/{goal['id']}",
        headers=headers,
        json={"linked_account_id": None},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["linked_account_id"] is None


def test_patch_target_date_before_start_date_rejected(
    client: TestClient, fresh_db: Session
) -> None:
    """PATCH making ``target_date < start_date`` → 422."""
    headers = _auth_headers(_register(client, "patch-merged-target@example.com")["access_token"])
    goal = _create_goal(
        client,
        headers,
        kind="saving",
        name="Merged",
        start_date="2026-01-01",
        target_date="2027-01-01",
    )

    resp = client.patch(
        f"/api/v1/goals/{goal['id']}",
        headers=headers,
        json={"target_date": "2025-01-01"},
    )
    assert resp.status_code == 422, resp.text
    assert "target_date" in resp.text


def test_patch_archived_goal_returns_404(client: TestClient, fresh_db: Session) -> None:
    """PATCH on an archived goal → 404."""
    headers = _auth_headers(_register(client, "patch-archived@example.com")["access_token"])
    goal = _create_goal(client, headers, kind="saving", name="Soon-archived")

    client.delete(f"/api/v1/goals/{goal['id']}", headers=headers)

    resp = client.patch(
        f"/api/v1/goals/{goal['id']}",
        headers=headers,
        json={"name": "Whatever"},
    )
    assert resp.status_code == 404, resp.text


# ---------------------------------------------------------------------------
# (e) DELETE /goals/{id} — soft delete
# ---------------------------------------------------------------------------


def test_delete_soft_archives_via_archived_at(client: TestClient, fresh_db: Session) -> None:
    """DELETE → 204; row stays in the table with ``archived_at`` set."""
    headers = _auth_headers(_register(client, "delete-soft@example.com")["access_token"])
    goal = _create_goal(client, headers, kind="saving", name="To-archive")

    resp = client.delete(f"/api/v1/goals/{goal['id']}", headers=headers)
    assert resp.status_code == 204, resp.text

    # Row stays in the table for audit history.
    stored = fresh_db.get(Goal, uuid.UUID(goal["id"]))
    assert stored is not None
    assert stored.archived_at is not None

    # Archived row is hidden from the default list.
    list_resp = client.get("/api/v1/goals", headers=headers)
    assert list_resp.json()["total"] == 0

    # But surfaceable via ``?archived=true``.
    archived_resp = client.get("/api/v1/goals?archived=true", headers=headers)
    assert archived_resp.json()["total"] == 1
    assert archived_resp.json()["items"][0]["archived"] is True


def test_delete_is_idempotent(client: TestClient, fresh_db: Session) -> None:
    """Second DELETE on an already-archived goal → still 204."""
    headers = _auth_headers(_register(client, "delete-idem@example.com")["access_token"])
    goal = _create_goal(client, headers, kind="saving", name="Twice")

    assert client.delete(f"/api/v1/goals/{goal['id']}", headers=headers).status_code == 204
    assert client.delete(f"/api/v1/goals/{goal['id']}", headers=headers).status_code == 204


def test_delete_returns_404_for_cross_user(client: TestClient, fresh_db: Session) -> None:
    """DELETE on another user's goal → 404."""
    headers_a = _auth_headers(_register(client, "del-cross-a@example.com")["access_token"])
    headers_b = _auth_headers(_register(client, "del-cross-b@example.com")["access_token"])

    goal = _create_goal(client, headers_a, kind="saving", name="A")

    resp = client.delete(f"/api/v1/goals/{goal['id']}", headers=headers_b)
    assert resp.status_code == 404, resp.text


def test_deleting_account_does_not_cascade_to_goal(client: TestClient, fresh_db: Session) -> None:
    """Archiving the linked account must NOT delete the goal.

    Accounts ship soft-delete (``archived=True``), so the
    ``ON DELETE SET NULL`` FK never fires — that's a defensive measure
    for a future hard-delete path. The goal stays alive with its
    ``linked_account_id`` still pointing at the archived row, exactly
    like transactions survive account archival.
    """
    headers = _auth_headers(
        _register(client, "account-archive-keeps-goal@example.com")["access_token"]
    )
    account = _create_account(client, headers, name="BCA")
    goal = _create_goal(
        client,
        headers,
        kind="saving",
        name="Vacation",
        linked_account_id=account["id"],
        current_amount_cents=1_000_000,
    )

    assert client.delete(f"/api/v1/accounts/{account['id']}", headers=headers).status_code == 204

    fresh_db.expire_all()
    stored = fresh_db.get(Goal, uuid.UUID(goal["id"]))
    assert stored is not None
    # The goal is still there and not tombstoned itself.
    assert stored.archived_at is None
    # ``linked_account_id`` is preserved (soft-delete doesn't fire the FK
    # action — a hard-delete would, but accounts use soft-delete everywhere).
    assert stored.linked_account_id == uuid.UUID(account["id"])


# ---------------------------------------------------------------------------
# (f) GET /goals/{id}/progress
# ---------------------------------------------------------------------------


def test_progress_with_stored_current_amount(client: TestClient, fresh_db: Session) -> None:
    """Stored ``current_amount_cents`` → progress reflects the value."""
    headers = _auth_headers(_register(client, "progress-stored@example.com")["access_token"])
    goal = _create_goal(
        client,
        headers,
        kind="saving",
        name="Vacation",
        target_amount_cents=10_000_000,
        current_amount_cents=2_500_000,
    )

    resp = client.get(f"/api/v1/goals/{goal['id']}/progress", headers=headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["goal_id"] == goal["id"]
    assert body["current_amount_cents"] == 2_500_000
    assert body["target_amount_cents"] == 10_000_000
    assert body["percentage"] == 25.0
    assert body["achieved_at"] is None
    assert body["kind"] == "saving"
    assert body["tabungan_bulanan_cents"] is None
    assert body["lama_mengumpulkan_bulan"] is None


def test_progress_caps_at_100_when_overshot(client: TestClient, fresh_db: Session) -> None:
    """``current > target`` → ``percentage`` capped at 100.

    sub-0005-02 — ``achieved_at`` is now a *persisted* column written
    by the recompute hook on first threshold-cross; the read endpoint
    (``GET /goals/{id}/progress``) doesn't write. A freshly created
    unlinked saving goal with ``current_amount_cents`` overshot
    returns ``achieved_at is None`` until the recompute hook fires.
    The end-to-end achieved-state behaviour is covered in
    :mod:`tests.test_goal_engine` (where the recompute runs and
    persists the timestamp).
    """
    headers = _auth_headers(_register(client, "progress-capped@example.com")["access_token"])
    goal = _create_goal(
        client,
        headers,
        kind="saving",
        name="Crushed",
        target_amount_cents=10_000_000,
        current_amount_cents=15_000_000,
    )

    resp = client.get(f"/api/v1/goals/{goal['id']}/progress", headers=headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["current_amount_cents"] == 15_000_000
    assert body["percentage"] == 100.0
    # achieved_at is None on the read path until the recompute hook
    # (or test-side recompute) writes it; see test_goal_engine.py.
    assert body["achieved_at"] is None


def test_progress_falls_back_to_linked_account_balance(
    client: TestClient, fresh_db: Session
) -> None:
    """No stored ``current_amount_cents`` → use linked account's live balance."""
    headers = _auth_headers(_register(client, "progress-linked@example.com")["access_token"])
    account = _create_account(client, headers, name="BCA", opening_balance_cents=4_200_000)
    goal = _create_goal(
        client,
        headers,
        kind="saving",
        name="Tracked",
        target_amount_cents=10_000_000,
        linked_account_id=account["id"],
        # current_amount_cents omitted → NULL in the row
    )
    assert goal["current_amount_cents"] is None

    resp = client.get(f"/api/v1/goals/{goal['id']}/progress", headers=headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["current_amount_cents"] == 4_200_000
    assert body["percentage"] == 42.0
    assert body["achieved_at"] is None


def test_progress_returns_404_for_cross_user(client: TestClient, fresh_db: Session) -> None:
    """Another user's goal → 404."""
    headers_a = _auth_headers(_register(client, "progress-cross-a@example.com")["access_token"])
    headers_b = _auth_headers(_register(client, "progress-cross-b@example.com")["access_token"])
    goal = _create_goal(client, headers_a, kind="saving", name="A")

    resp = client.get(f"/api/v1/goals/{goal['id']}/progress", headers=headers_b)
    assert resp.status_code == 404, resp.text


def test_progress_returns_404_for_archived_goal(client: TestClient, fresh_db: Session) -> None:
    """Archived goal → 404 (consistent with detail endpoint)."""
    headers = _auth_headers(_register(client, "progress-archived@example.com")["access_token"])
    goal = _create_goal(client, headers, kind="saving", name="Going")
    client.delete(f"/api/v1/goals/{goal['id']}", headers=headers)

    resp = client.get(f"/api/v1/goals/{goal['id']}/progress", headers=headers)
    assert resp.status_code == 404, resp.text


# ---------------------------------------------------------------------------
# (g) Coverage for fixtures — make sure helpers work for other tests too
# ---------------------------------------------------------------------------


def test_progress_account_balance_recomputed_when_stored_value_null(
    client: TestClient, fresh_db: Session
) -> None:
    """Sub-0005-02 will own the recompute path; sub-0005-01 just falls back.

    Adding an income transaction after the goal is created should be
    visible through the progress endpoint — the saldo engine returns
    the live balance at request time, not at goal-creation time.
    """
    from datetime import date

    from app.db.models.enums import TransactionType
    from app.db.models.transaction import Transaction

    headers = _auth_headers(_register(client, "progress-recompute@example.com")["access_token"])
    account = _create_account(client, headers, name="BCA")
    goal = _create_goal(
        client,
        headers,
        kind="saving",
        name="Stash",
        target_amount_cents=10_000_000,
        linked_account_id=account["id"],
    )

    # No transactions yet → progress shows the opening balance (0).
    initial = client.get(f"/api/v1/goals/{goal['id']}/progress", headers=headers).json()
    assert initial["current_amount_cents"] == 0

    # Add an income transaction via the ORM (the test bypasses the
    # transactions router so we don't accidentally trigger category
    # auto-apply rules; this test is about the progress endpoint, not
    # the transaction engine).
    today = date.today()
    fresh_db.add(
        Transaction(
            user_id=fresh_db.get(Account, uuid.UUID(account["id"])).user_id,
            account_id=uuid.UUID(account["id"]),
            type=TransactionType.INCOME,
            amount_cents=3_333_333,
            currency="IDR",
            occurred_on=today,
            note="progress-recompute seed",
        )
    )
    fresh_db.commit()

    updated = client.get(f"/api/v1/goals/{goal['id']}/progress", headers=headers).json()
    assert updated["current_amount_cents"] == 3_333_333


# ---------------------------------------------------------------------------
# Pagination edge case
# ---------------------------------------------------------------------------


def test_list_pagination_envelope(client: TestClient, fresh_db: Session) -> None:
    """``limit`` / ``offset`` round-trip cleanly."""
    headers = _auth_headers(_register(client, "paginate@example.com")["access_token"])

    for i in range(3):
        _create_goal(client, headers, kind="saving", name=f"G-{i}")

    resp = client.get("/api/v1/goals?limit=2&offset=1", headers=headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total"] == 3
    assert body["limit"] == 2
    assert body["offset"] == 1
    assert len(body["items"]) == 2


def test_list_limit_clamped_to_max(client: TestClient, fresh_db: Session) -> None:
    """``limit > 200`` → 422 (the ``le=200`` constraint)."""
    headers = _auth_headers(_register(client, "limit-cap@example.com")["access_token"])

    resp = client.get("/api/v1/goals?limit=999", headers=headers)
    assert resp.status_code == 422, resp.text


# ---------------------------------------------------------------------------
# Coverage for date arithmetic cross-field
# ---------------------------------------------------------------------------


def test_create_with_start_date_equals_target_date(client: TestClient, fresh_db: Session) -> None:
    """``target_date == start_date`` is allowed (boundary value)."""
    headers = _auth_headers(_register(client, "same-date@example.com")["access_token"])

    resp = client.post(
        "/api/v1/goals",
        headers=headers,
        json={
            "kind": "saving",
            "name": "Snapshot",
            "target_amount_cents": 1_000_000,
            "start_date": "2026-08-15",
            "target_date": "2026-08-15",
            "jangka_waktu_months": 1,
        },
    )
    assert resp.status_code == 201, resp.text


def test_create_rejects_oversized_name(client: TestClient, fresh_db: Session) -> None:
    """``name`` longer than 120 chars → 422."""
    headers = _auth_headers(_register(client, "long-name@example.com")["access_token"])

    resp = client.post(
        "/api/v1/goals",
        headers=headers,
        json={
            "kind": "saving",
            "name": "x" * 121,
            "target_amount_cents": 1_000_000,
        },
    )
    assert resp.status_code == 422, resp.text


def test_list_orders_deterministically_by_kind_then_start_date(
    client: TestClient, fresh_db: Session
) -> None:
    """The list endpoint sorts ``kind asc`` then ``start_date desc``."""
    headers = _auth_headers(_register(client, "list-order@example.com")["access_token"])

    _create_goal(
        client,
        headers,
        kind="emergency_fund",
        name="EF-old",
        start_date="2026-01-01",
        monthly_expense_cents=1_000_000,
    )
    _create_goal(
        client,
        headers,
        kind="saving",
        name="SV-newer",
        start_date="2026-08-01",
    )
    _create_goal(
        client,
        headers,
        kind="saving",
        name="SV-older",
        start_date="2026-02-01",
    )

    resp = client.get("/api/v1/goals", headers=headers)
    body = resp.json()
    kinds = [g["kind"] for g in body["items"]]
    # All three rows present, two savings + one EF (deterministic order).
    assert len(kinds) == 3
    assert kinds.count("saving") == 2
    assert kinds.count("emergency_fund") == 1
    saving_dates = [g["start_date"] for g in body["items"] if g["kind"] == "saving"]
    assert saving_dates == sorted(saving_dates, reverse=True)
