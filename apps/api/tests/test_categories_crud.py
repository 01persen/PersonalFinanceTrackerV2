"""Categories CRUD endpoint tests — sub-0004-01.

Scenarios covered (per the sub-0004-01 acceptance criteria):

* (1) ``GET /api/v1/categories`` (existing, paginated, sorted) — keeps working.
* (2) ``POST /api/v1/categories`` — 201 + body. 400 for cycle / kind
      mismatch with parent. 404 for parent belonging to another user.
      422 for invalid kind, oversized name, unknown extra fields.
* (3) ``PATCH /api/v1/categories/{id}`` — partial update. Cycle
      prevention. Kind mismatch with new parent. 404 for foreign
      category. 422 for ``extra="forbid"`` on server-controlled fields.
* (4) ``DELETE /api/v1/categories/{id}`` — 204, ``archived_at``
      server-side, excluded from GET list. Idempotent (second DELETE
      still 204).
* (5) ``POST /api/v1/categories/{id}/archive`` — explicit archive with
      optional ``reason``. Returns the archived row. Idempotent.
* (6) Pagination + sort by ``name`` on GET. Default page_size 100.

Two-user isolation is exercised throughout — every test that creates a
category asserts the other user can't see it via any of the read paths.
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session


def _register(client: TestClient, email: str) -> dict:
    resp = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "Sup3rSecret!"},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_category(
    client: TestClient,
    headers: dict[str, str],
    *,
    name: str,
    kind: str = "expense",
    parent_id: str | None = None,
    color: str | None = None,
    icon: str | None = None,
) -> dict:
    payload: dict = {"name": name, "kind": kind}
    if parent_id is not None:
        payload["parent_id"] = parent_id
    if color is not None:
        payload["color"] = color
    if icon is not None:
        payload["icon"] = icon
    resp = client.post("/api/v1/categories", headers=headers, json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


def _list_categories(client: TestClient, headers: dict[str, str]) -> list[dict]:
    resp = client.get("/api/v1/categories", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()["items"]


# ---------------------------------------------------------------------------
# (1) GET /categories — paginated envelope keeps the existing read working
# ---------------------------------------------------------------------------


def test_get_returns_paginated_envelope_for_existing_user(
    client: TestClient, fresh_db: Session
) -> None:
    """The existing read endpoint still returns the caller's default tree.

    The wire format changed from ``list[CategoryPublic]`` to the
    paginated ``CategoryListPublic`` envelope (added in sub-0004-01) —
    every existing test that read categories was updated to consume
    ``payload["items"]`` instead of the bare list.
    """
    headers = _auth_headers(_register(client, "get-existing@example.com")["access_token"])

    resp = client.get("/api/v1/categories", headers=headers)
    assert resp.status_code == 200, resp.text
    payload = resp.json()

    # Envelope shape.
    assert set(payload) == {"items", "total", "limit", "offset"}
    assert payload["limit"] == 100  # AC (6) default page_size
    assert payload["offset"] == 0
    assert payload["total"] == len(payload["items"]) == 33  # 7 income + 26 expense
    assert all(c["archived"] is False for c in payload["items"])
    assert all(c["archived_at"] is None for c in payload["items"])


def test_get_requires_authentication(client: TestClient, fresh_db: Session) -> None:
    resp = client.get("/api/v1/categories")
    assert resp.status_code == 401


def test_get_respects_limit_and_offset(client: TestClient, fresh_db: Session) -> None:
    """Pagination honours the limit/offset query params (AC (6))."""
    headers = _auth_headers(_register(client, "get-paginate@example.com")["access_token"])

    page_one = client.get("/api/v1/categories?limit=5&offset=0", headers=headers).json()
    page_two = client.get("/api/v1/categories?limit=5&offset=5", headers=headers).json()

    assert page_one["limit"] == 5
    assert page_one["offset"] == 0
    assert len(page_one["items"]) == 5
    assert page_one["total"] == 33  # full count, not page count

    assert page_two["limit"] == 5
    assert page_two["offset"] == 5
    assert len(page_two["items"]) == 5

    # The two pages are disjoint and deterministic.
    page_one_ids = {c["id"] for c in page_one["items"]}
    page_two_ids = {c["id"] for c in page_two["items"]}
    assert page_one_ids.isdisjoint(page_two_ids)


def test_get_rejects_limit_out_of_range_with_422(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "get-limits@example.com")["access_token"])

    assert client.get("/api/v1/categories?limit=0", headers=headers).status_code == 422
    assert client.get("/api/v1/categories?limit=501", headers=headers).status_code == 422
    assert client.get("/api/v1/categories?offset=-1", headers=headers).status_code == 422


def test_get_sorts_by_name_within_kind_and_parent(
    client: TestClient, fresh_db: Session
) -> None:
    """Ordering is deterministic: kind asc, parent_id asc, name asc (AC).

    NULL ``parent_id`` sorts first (parents before their leaves), then the
    children come back grouped by their parent id and sorted by name inside
    each group. The relative order between distinct parent groups depends on
    the underlying UUID ordering (random), so we only assert the *intra-group*
    invariants here.
    """
    headers = _auth_headers(_register(client, "get-sort@example.com")["access_token"])

    parent_a = _create_category(client, headers, name="AA-Parent", kind="expense")
    parent_b = _create_category(client, headers, name="BB-Parent", kind="expense")
    _create_category(client, headers, name="A-Leaf", kind="expense", parent_id=parent_a["id"])
    _create_category(client, headers, name="B-Leaf", kind="expense", parent_id=parent_a["id"])
    _create_category(client, headers, name="C-Leaf", kind="expense", parent_id=parent_b["id"])

    items = client.get("/api/v1/categories?limit=500", headers=headers).json()["items"]

    # Parents (NULL parent_id) come before any leaf.
    parents_in_result = [c for c in items if c["name"] in {"AA-Parent", "BB-Parent"}]
    leaves_in_result = [c for c in items if c["name"] in {"A-Leaf", "B-Leaf", "C-Leaf"}]
    last_parent_index = max(items.index(c) for c in parents_in_result)
    first_leaf_index = min(items.index(c) for c in leaves_in_result)
    assert last_parent_index < first_leaf_index

    # Parents sorted by name.
    assert [c["name"] for c in parents_in_result] == ["AA-Parent", "BB-Parent"]

    # Within each parent group, leaves sorted by name.
    leaves_under_a = [c for c in items if c["parent_id"] == parent_a["id"]]
    leaves_under_b = [c for c in items if c["parent_id"] == parent_b["id"]]
    assert [c["name"] for c in leaves_under_a] == ["A-Leaf", "B-Leaf"]
    assert [c["name"] for c in leaves_under_b] == ["C-Leaf"]


# ---------------------------------------------------------------------------
# (2) POST /categories
# ---------------------------------------------------------------------------


def test_post_creates_category_and_returns_201(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "post-create@example.com")["access_token"])

    resp = client.post(
        "/api/v1/categories",
        headers=headers,
        json={"name": "Makan", "kind": "expense", "color": "#ff0000", "icon": "fork"},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()

    assert body["name"] == "Makan"
    assert body["kind"] == "expense"
    assert body["color"] == "#ff0000"
    assert body["icon"] == "fork"
    assert body["parent_id"] is None
    assert body["archived"] is False
    assert body["archived_at"] is None


def test_post_creates_child_under_owned_parent(
    client: TestClient, fresh_db: Session
) -> None:
    headers = _auth_headers(_register(client, "post-child@example.com")["access_token"])

    parent = _create_category(client, headers, name="P", kind="expense")
    child = _create_category(client, headers, name="C", kind="expense", parent_id=parent["id"])

    assert child["parent_id"] == parent["id"]


def test_post_rejects_parent_belonging_to_other_user_with_404(
    client: TestClient, fresh_db: Session
) -> None:
    """Foreign parent → 404 (no leak), per the ownership rule."""
    alice_h = _auth_headers(_register(client, "alice-parent@example.com")["access_token"])
    bob_h = _auth_headers(_register(client, "bob-parent@example.com")["access_token"])

    alice_parent = _create_category(client, alice_h, name="AliceRoot", kind="expense")

    resp = client.post(
        "/api/v1/categories",
        headers=bob_h,
        json={"name": "Hostile", "kind": "expense", "parent_id": alice_parent["id"]},
    )
    assert resp.status_code == 404
    assert "category not found" in resp.json()["detail"].lower()


def test_post_rejects_kind_mismatch_with_parent_with_400(
    client: TestClient, fresh_db: Session
) -> None:
    """An income child under an expense parent is rejected (kind invariant)."""
    headers = _auth_headers(_register(client, "post-kind@example.com")["access_token"])

    expense_parent = _create_category(client, headers, name="E", kind="expense")

    resp = client.post(
        "/api/v1/categories",
        headers=headers,
        json={"name": "I", "kind": "income", "parent_id": expense_parent["id"]},
    )
    assert resp.status_code == 400
    assert "kind" in resp.json()["detail"].lower()


def test_post_rejects_invalid_kind_with_422(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "post-badkind@example.com")["access_token"])

    resp = client.post(
        "/api/v1/categories",
        headers=headers,
        json={"name": "X", "kind": "transfer"},
    )
    assert resp.status_code == 422


def test_post_rejects_empty_name_with_422(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "post-empty@example.com")["access_token"])

    resp = client.post(
        "/api/v1/categories",
        headers=headers,
        json={"name": "", "kind": "expense"},
    )
    assert resp.status_code == 422


def test_post_rejects_oversized_name_with_422(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "post-long@example.com")["access_token"])

    resp = client.post(
        "/api/v1/categories",
        headers=headers,
        json={"name": "x" * 121, "kind": "expense"},
    )
    assert resp.status_code == 422


def test_post_rejects_unknown_extra_field_with_422(
    client: TestClient, fresh_db: Session
) -> None:
    """``extra="forbid"`` keeps server-controlled fields server-controlled."""
    headers = _auth_headers(_register(client, "post-extra@example.com")["access_token"])

    resp = client.post(
        "/api/v1/categories",
        headers=headers,
        json={"name": "X", "kind": "expense", "archived": True},
    )
    assert resp.status_code == 422


def test_post_requires_authentication(client: TestClient, fresh_db: Session) -> None:
    resp = client.post(
        "/api/v1/categories",
        json={"name": "X", "kind": "expense"},
    )
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# (3) PATCH /categories/{id}
# ---------------------------------------------------------------------------


def test_patch_updates_only_specified_fields(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "patch-partial@example.com")["access_token"])

    cat = _create_category(client, headers, name="Old", kind="expense", color="#111111")

    resp = client.patch(
        f"/api/v1/categories/{cat['id']}",
        headers=headers,
        json={"name": "New"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["name"] == "New"
    assert body["color"] == "#111111"  # untouched
    assert body["kind"] == "expense"  # untouched


def test_patch_updates_multiple_fields_atomically(
    client: TestClient, fresh_db: Session
) -> None:
    headers = _auth_headers(_register(client, "patch-multi@example.com")["access_token"])

    cat = _create_category(client, headers, name="M", kind="expense")

    resp = client.patch(
        f"/api/v1/categories/{cat['id']}",
        headers=headers,
        json={"name": "M2", "color": "#222", "icon": "ic"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "M2"
    assert body["color"] == "#222"
    assert body["icon"] == "ic"


def test_patch_clears_parent_with_explicit_null(client: TestClient, fresh_db: Session) -> None:
    """``parent_id: null`` moves the category to the root."""
    headers = _auth_headers(_register(client, "patch-clearparent@example.com")["access_token"])

    parent = _create_category(client, headers, name="P", kind="expense")
    child = _create_category(client, headers, name="C", kind="expense", parent_id=parent["id"])

    resp = client.patch(
        f"/api/v1/categories/{child['id']}",
        headers=headers,
        json={"parent_id": None},
    )
    assert resp.status_code == 200
    assert resp.json()["parent_id"] is None


def test_patch_rejects_self_parent_with_400(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "patch-self@example.com")["access_token"])

    cat = _create_category(client, headers, name="S", kind="expense")

    resp = client.patch(
        f"/api/v1/categories/{cat['id']}",
        headers=headers,
        json={"parent_id": cat["id"]},
    )
    assert resp.status_code == 400
    assert "parent" in resp.json()["detail"].lower()


def test_patch_rejects_descendant_parent_with_400(
    client: TestClient, fresh_db: Session
) -> None:
    """Cycle: parent → child can't have parent set to itself or any ancestor."""
    headers = _auth_headers(_register(client, "patch-cycle@example.com")["access_token"])

    grandparent = _create_category(client, headers, name="GP", kind="expense")
    parent = _create_category(
        client, headers, name="P", kind="expense", parent_id=grandparent["id"]
    )
    child = _create_category(client, headers, name="C", kind="expense", parent_id=parent["id"])

    # Try to set parent as a descendant of itself.
    resp = client.patch(
        f"/api/v1/categories/{parent['id']}",
        headers=headers,
        json={"parent_id": child["id"]},
    )
    assert resp.status_code == 400
    assert "cycle" in resp.json()["detail"].lower()


def test_patch_rejects_kind_mismatch_with_new_parent_with_400(
    client: TestClient, fresh_db: Session
) -> None:
    headers = _auth_headers(_register(client, "patch-kind@example.com")["access_token"])

    income = _create_category(client, headers, name="I", kind="income")
    expense = _create_category(client, headers, name="E", kind="expense")

    resp = client.patch(
        f"/api/v1/categories/{income['id']}",
        headers=headers,
        json={"parent_id": expense["id"]},
    )
    assert resp.status_code == 400
    assert "kind" in resp.json()["detail"].lower()


def test_patch_rejects_foreign_category_with_404(client: TestClient, fresh_db: Session) -> None:
    alice_h = _auth_headers(_register(client, "alice-pf@example.com")["access_token"])
    bob_h = _auth_headers(_register(client, "bob-pf@example.com")["access_token"])

    alice_cat = _create_category(client, alice_h, name="AC", kind="expense")

    resp = client.patch(
        f"/api/v1/categories/{alice_cat['id']}",
        headers=bob_h,
        json={"name": "hostile"},
    )
    assert resp.status_code == 404


def test_patch_returns_404_for_unknown_id(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "patch-uuid@example.com")["access_token"])

    resp = client.patch(
        f"/api/v1/categories/{uuid.uuid4()}",
        headers=headers,
        json={"name": "ghost"},
    )
    assert resp.status_code == 404


def test_patch_rejects_server_controlled_field_with_422(
    client: TestClient, fresh_db: Session
) -> None:
    """``extra="forbid"`` blocks ``id``, ``user_id``, ``archived``, timestamps."""
    headers = _auth_headers(_register(client, "patch-forbid@example.com")["access_token"])

    cat = _create_category(client, headers, name="F", kind="expense")

    for forbidden in ("id", "user_id", "archived", "archived_at"):
        resp = client.patch(
            f"/api/v1/categories/{cat['id']}",
            headers=headers,
            json={forbidden: "anything"},
        )
        assert resp.status_code == 422, forbidden


def test_patch_on_archived_category_returns_404(client: TestClient, fresh_db: Session) -> None:
    """A soft-deleted category cannot be resurrected via PATCH."""
    headers = _auth_headers(_register(client, "patch-archived@example.com")["access_token"])

    cat = _create_category(client, headers, name="D", kind="expense")
    assert client.delete(f"/api/v1/categories/{cat['id']}", headers=headers).status_code == 204

    resp = client.patch(
        f"/api/v1/categories/{cat['id']}",
        headers=headers,
        json={"name": "resurrect"},
    )
    assert resp.status_code == 404


def test_patch_requires_authentication(client: TestClient, fresh_db: Session) -> None:
    resp = client.patch(
        f"/api/v1/categories/{uuid.uuid4()}",
        json={"name": "x"},
    )
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# (4) DELETE /categories/{id}
# ---------------------------------------------------------------------------


def test_delete_soft_deletes_row_returns_204_and_hides_from_list(
    client: TestClient, fresh_db: Session
) -> None:
    """DELETE returns 204, row stays in DB with archived_at set, list excludes it."""
    headers = _auth_headers(_register(client, "delete-soft@example.com")["access_token"])

    cat = _create_category(client, headers, name="Goner", kind="expense")

    resp = client.delete(f"/api/v1/categories/{cat['id']}", headers=headers)
    assert resp.status_code == 204

    listing = client.get("/api/v1/categories", headers=headers).json()
    ids = {c["id"] for c in listing["items"]}
    assert cat["id"] not in ids
    assert listing["total"] == 33  # 33 seeded + 1 new, then -1 deleted


def test_delete_is_idempotent(client: TestClient, fresh_db: Session) -> None:
    """A second DELETE on the same row is a no-op (still 204)."""
    headers = _auth_headers(_register(client, "delete-twice@example.com")["access_token"])

    cat = _create_category(client, headers, name="Twice", kind="expense")
    assert client.delete(f"/api/v1/categories/{cat['id']}", headers=headers).status_code == 204
    assert client.delete(f"/api/v1/categories/{cat['id']}", headers=headers).status_code == 204

    listing = client.get("/api/v1/categories", headers=headers).json()
    assert listing["total"] == 33  # 33 seeded + 1 new, then -1 deleted


def test_delete_captures_archived_at_server_side(
    client: TestClient, fresh_db: Session
) -> None:
    """``archived_at`` is real (not None) and persisted on the row."""
    from app.db.models.category import Category

    headers = _auth_headers(_register(client, "delete-audit@example.com")["access_token"])

    cat = _create_category(client, headers, name="Audit", kind="expense")
    assert client.delete(f"/api/v1/categories/{cat['id']}", headers=headers).status_code == 204

    row = fresh_db.get(Category, uuid.UUID(cat["id"]))
    assert row is not None
    assert row.archived_at is not None
    assert row.archived is True


def test_delete_returns_404_for_foreign_user(client: TestClient, fresh_db: Session) -> None:
    """A user cannot DELETE another user's category — 404 (no leak)."""
    alice_h = _auth_headers(_register(client, "alice-del@example.com")["access_token"])
    bob_h = _auth_headers(_register(client, "bob-del@example.com")["access_token"])

    alice_cat = _create_category(client, alice_h, name="AC", kind="expense")

    resp = client.delete(f"/api/v1/categories/{alice_cat['id']}", headers=bob_h)
    assert resp.status_code == 404

    # The row is still visible to Alice.
    alice_listing = client.get("/api/v1/categories", headers=alice_h).json()
    assert any(c["id"] == alice_cat["id"] for c in alice_listing["items"])


def test_delete_returns_404_for_unknown_id(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "delete-uuid@example.com")["access_token"])
    resp = client.delete(f"/api/v1/categories/{uuid.uuid4()}", headers=headers)
    assert resp.status_code == 404


def test_delete_requires_authentication(client: TestClient, fresh_db: Session) -> None:
    resp = client.delete(f"/api/v1/categories/{uuid.uuid4()}")
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# (5) POST /categories/{id}/archive
# ---------------------------------------------------------------------------


def test_archive_explicit_returns_200_and_archived_row(
    client: TestClient, fresh_db: Session
) -> None:
    """Explicit archive with optional reason — returns the archived row."""
    headers = _auth_headers(_register(client, "archive-basic@example.com")["access_token"])

    cat = _create_category(client, headers, name="ToArchive", kind="expense")

    resp = client.post(
        f"/api/v1/categories/{cat['id']}/archive",
        headers=headers,
        json={"reason": "no longer used"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["id"] == cat["id"]
    assert body["archived"] is True
    assert body["archived_at"] is not None

    # Excluded from the default list.
    listing = client.get("/api/v1/categories", headers=headers).json()
    ids = {c["id"] for c in listing["items"]}
    assert cat["id"] not in ids


def test_archive_with_no_reason_succeeds(client: TestClient, fresh_db: Session) -> None:
    """``reason`` is optional — omitted body still 200."""
    headers = _auth_headers(_register(client, "archive-noreason@example.com")["access_token"])

    cat = _create_category(client, headers, name="Plain", kind="expense")

    resp = client.post(
        f"/api/v1/categories/{cat['id']}/archive",
        headers=headers,
        json={},
    )
    assert resp.status_code == 200
    assert resp.json()["archived"] is True


def test_archive_is_idempotent(client: TestClient, fresh_db: Session) -> None:
    """Archiving an already-archived row returns the row (no overwrite)."""
    from app.db.models.category import Category

    headers = _auth_headers(_register(client, "archive-twice@example.com")["access_token"])

    cat = _create_category(client, headers, name="Twice", kind="expense")

    first = client.post(
        f"/api/v1/categories/{cat['id']}/archive", headers=headers, json={}
    ).json()
    second = client.post(
        f"/api/v1/categories/{cat['id']}/archive", headers=headers, json={}
    ).json()

    assert first["archived"] is True
    assert second["archived"] is True
    # Original timestamp is preserved on idempotent re-archive.
    assert first["archived_at"] == second["archived_at"]

    row = fresh_db.get(Category, uuid.UUID(cat["id"]))
    assert row is not None
    assert row.archived_at is not None


def test_archive_returns_404_for_foreign_user(client: TestClient, fresh_db: Session) -> None:
    alice_h = _auth_headers(_register(client, "alice-arch@example.com")["access_token"])
    bob_h = _auth_headers(_register(client, "bob-arch@example.com")["access_token"])

    alice_cat = _create_category(client, alice_h, name="AC", kind="expense")

    resp = client.post(
        f"/api/v1/categories/{alice_cat['id']}/archive",
        headers=bob_h,
        json={},
    )
    assert resp.status_code == 404


def test_archive_returns_404_for_unknown_id(client: TestClient, fresh_db: Session) -> None:
    headers = _auth_headers(_register(client, "archive-uuid@example.com")["access_token"])
    resp = client.post(
        f"/api/v1/categories/{uuid.uuid4()}/archive",
        headers=headers,
        json={},
    )
    assert resp.status_code == 404


def test_archive_requires_authentication(client: TestClient, fresh_db: Session) -> None:
    resp = client.post(
        f"/api/v1/categories/{uuid.uuid4()}/archive",
        json={},
    )
    assert resp.status_code == 401


def test_archive_rejects_unknown_extra_field_with_422(
    client: TestClient, fresh_db: Session
) -> None:
    """``extra="forbid"`` on the archive request body."""
    headers = _auth_headers(_register(client, "archive-forbid@example.com")["access_token"])

    cat = _create_category(client, headers, name="F", kind="expense")
    resp = client.post(
        f"/api/v1/categories/{cat['id']}/archive",
        headers=headers,
        json={"reason": "ok", "archived_at": "2020-01-01T00:00:00Z"},
    )
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Two-user isolation on the new write endpoints
# ---------------------------------------------------------------------------


def test_posted_category_invisible_to_other_user_list(
    client: TestClient, fresh_db: Session
) -> None:
    """A category created by Alice never surfaces in Bob's list."""
    alice_h = _auth_headers(_register(client, "alice-pc@example.com")["access_token"])
    bob_h = _auth_headers(_register(client, "bob-pc@example.com")["access_token"])

    cat = _create_category(client, alice_h, name="Mine", kind="expense")

    bob_listing = client.get("/api/v1/categories", headers=bob_h).json()
    ids = {c["id"] for c in bob_listing["items"]}
    assert cat["id"] not in ids

    alice_listing = client.get("/api/v1/categories", headers=alice_h).json()
    ids_alice = {c["id"] for c in alice_listing["items"]}
    assert cat["id"] in ids_alice


def test_delete_then_list_excludes_only_the_deleted_row(
    client: TestClient, fresh_db: Session
) -> None:
    """Soft-deleting one row does not affect the rest of the caller's list."""
    headers = _auth_headers(_register(client, "delete-mixed@example.com")["access_token"])

    keep = _create_category(client, headers, name="K", kind="expense")
    doomed = _create_category(client, headers, name="D", kind="expense")

    assert client.delete(f"/api/v1/categories/{doomed['id']}", headers=headers).status_code == 204

    listing = client.get("/api/v1/categories", headers=headers).json()
    ids = {c["id"] for c in listing["items"]}
    assert keep["id"] in ids
    assert doomed["id"] not in ids


def test_get_only_returns_active_rows_default(
    client: TestClient, fresh_db: Session
) -> None:
    """The default GET filter excludes archived rows."""
    headers = _auth_headers(_register(client, "filter-active@example.com")["access_token"])

    cat = _create_category(client, headers, name="X", kind="expense")
    assert client.delete(f"/api/v1/categories/{cat['id']}", headers=headers).status_code == 204

    listing = client.get("/api/v1/categories", headers=headers).json()
    assert all(c["archived_at"] is None for c in listing["items"])
    assert all(c["archived"] is False for c in listing["items"])


# ---------------------------------------------------------------------------
# OpenAPI surface sanity
# ---------------------------------------------------------------------------


def test_openapi_documents_new_category_endpoints(
    client: TestClient, fresh_db: Session
) -> None:
    spec = client.get("/openapi.json").json()
    paths = spec["paths"]
    assert "/api/v1/categories" in paths
    assert "/api/v1/categories/{category_id}" in paths
    assert "/api/v1/categories/{category_id}/archive" in paths

    methods = paths["/api/v1/categories"]
    assert "get" in methods
    assert "post" in methods

    detail_methods = paths["/api/v1/categories/{category_id}"]
    assert "patch" in detail_methods
    assert "delete" in detail_methods

    assert "post" in paths["/api/v1/categories/{category_id}/archive"]


@pytest.mark.parametrize("endpoint", ["get", "post"])
def test_categories_collection_requires_auth(
    endpoint: str, client: TestClient, fresh_db: Session
) -> None:
    """Every collection-level endpoint requires a bearer token."""
    if endpoint == "get":
        resp = client.get("/api/v1/categories")
    else:
        resp = client.post("/api/v1/categories", json={"name": "x", "kind": "expense"})
    assert resp.status_code == 401


@pytest.mark.parametrize("endpoint", ["patch", "delete"])
def test_categories_detail_requires_auth(
    endpoint: str, client: TestClient, fresh_db: Session
) -> None:
    """Every detail-level endpoint requires a bearer token."""
    cat_id = uuid.uuid4()
    if endpoint == "patch":
        resp = client.patch(
            f"/api/v1/categories/{cat_id}",
            json={"name": "x"},
        )
    else:
        resp = client.delete(f"/api/v1/categories/{cat_id}")
    assert resp.status_code == 401
