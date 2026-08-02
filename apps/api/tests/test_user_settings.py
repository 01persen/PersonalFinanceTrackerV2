"""User settings endpoint tests (sub-0005-02).

Scope: epic-0005, sub-0005-02. Verifies the ``/users/me/settings``
router that aliases the single-row ``user_preferences`` table
created by the epic-0001 seed module.

Scenarios covered:

* **(a) GET /users/me/settings** -- 200 + body for a freshly
  registered user with the seeded EF multiplier (3). Auth
  required (401 without a token).
* **(b) PATCH /users/me/settings** -- partial update; only the
  fields present in the request body are touched. ``ef_multiplier``
  is the load-bearing field for the goal-engine, the rest are
  pass-through settings.
* **(c) Validation** -- ``ef_multiplier >= 1`` (PRD §14; values
  below 1 contradict the goal's intent), ``extra="forbid"``
  rejects unknown fields with 422, locale / currency / theme
  lengths are bounded.
* **(d) Cross-user isolation** -- user B cannot see / modify user
  A's preferences through the auth-scoped handler.
* **(e) Multiplier actually drives the goal engine** -- setting
  a non-default multiplier here changes what an EF goal creation
  falls back to (covered end-to-end in
  :mod:`tests.test_goal_engine`).
"""

from __future__ import annotations

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


# ---------------------------------------------------------------------------
# (a) GET /users/me/settings
# ---------------------------------------------------------------------------


def test_get_returns_seeded_defaults(client: TestClient, fresh_db: Session) -> None:
    """Freshly registered user has the epic-0001 seed defaults."""
    headers = _auth_headers(_register(client, "settings-get@example.com")["access_token"])

    resp = client.get("/api/v1/users/me/settings", headers=headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()

    # Pydantic field names -- the wire uses ``ef_multiplier`` (FE-friendly),
    # not the storage column name ``emergency_fund_multiplier``.
    assert body["ef_multiplier"] == 3
    assert body["locale"] == "id-ID"
    assert body["currency"] == "IDR"
    assert body["dependents_count"] == 1
    assert body["theme"] == "system"
    assert body["updated_at"]


def test_get_requires_auth(client: TestClient, fresh_db: Session) -> None:
    """No bearer token -> 401."""
    resp = client.get("/api/v1/users/me/settings")
    assert resp.status_code == 401


def test_get_isolates_between_users(client: TestClient, fresh_db: Session) -> None:
    """User B sees their own settings, not user A's."""
    headers_a = _auth_headers(_register(client, "settings-iso-a@example.com")["access_token"])
    headers_b = _auth_headers(_register(client, "settings-iso-b@example.com")["access_token"])

    # Bump user A's multiplier to 6 first.
    client.patch(
        "/api/v1/users/me/settings",
        headers=headers_a,
        json={"ef_multiplier": 6},
    )

    a_body = client.get("/api/v1/users/me/settings", headers=headers_a).json()
    b_body = client.get("/api/v1/users/me/settings", headers=headers_b).json()

    assert a_body["ef_multiplier"] == 6
    assert b_body["ef_multiplier"] == 3  # user B is unaffected


# ---------------------------------------------------------------------------
# (b) PATCH /users/me/settings
# ---------------------------------------------------------------------------


def test_patch_updates_ef_multiplier(client: TestClient, fresh_db: Session) -> None:
    """``PATCH { ef_multiplier: 6 }`` updates the user's default."""
    headers = _auth_headers(_register(client, "patch-multi@example.com")["access_token"])

    resp = client.patch(
        "/api/v1/users/me/settings",
        headers=headers,
        json={"ef_multiplier": 6},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ef_multiplier"] == 6
    # Other fields stay at their seed values.
    assert body["locale"] == "id-ID"
    assert body["currency"] == "IDR"
    assert body["dependents_count"] == 1


def test_patch_persists_across_get(client: TestClient, fresh_db: Session) -> None:
    """The PATCH path commits, not just responds -- a second GET sees the change."""
    headers = _auth_headers(_register(client, "patch-persist@example.com")["access_token"])

    client.patch(
        "/api/v1/users/me/settings",
        headers=headers,
        json={"ef_multiplier": 4, "dependents_count": 3},
    )

    body = client.get("/api/v1/users/me/settings", headers=headers).json()
    assert body["ef_multiplier"] == 4
    assert body["dependents_count"] == 3


def test_patch_partial_does_not_touch_others(client: TestClient, fresh_db: Session) -> None:
    """Empty body / partial PATCH must not clobber sibling fields."""
    headers = _auth_headers(_register(client, "patch-partial@example.com")["access_token"])

    # Bump dependents_count first.
    client.patch(
        "/api/v1/users/me/settings",
        headers=headers,
        json={"dependents_count": 5},
    )

    # Patch only ef_multiplier; dependents_count must stay at 5.
    resp = client.patch(
        "/api/v1/users/me/settings",
        headers=headers,
        json={"ef_multiplier": 5},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ef_multiplier"] == 5
    assert body["dependents_count"] == 5  # untouched


def test_patch_rejects_ef_multiplier_zero(client: TestClient, fresh_db: Session) -> None:
    """``ef_multiplier=0`` -> 422 (PRD §14 mandates >= 1)."""
    headers = _auth_headers(_register(client, "patch-zero@example.com")["access_token"])

    resp = client.patch(
        "/api/v1/users/me/settings",
        headers=headers,
        json={"ef_multiplier": 0},
    )
    assert resp.status_code == 422, resp.text


def test_patch_rejects_ef_multiplier_negative(client: TestClient, fresh_db: Session) -> None:
    """``ef_multiplier=-1`` -> 422."""
    headers = _auth_headers(_register(client, "patch-neg@example.com")["access_token"])

    resp = client.patch(
        "/api/v1/users/me/settings",
        headers=headers,
        json={"ef_multiplier": -1},
    )
    assert resp.status_code == 422


def test_patch_rejects_unknown_field(client: TestClient, fresh_db: Session) -> None:
    """Unknown body field -> 422 (``extra="forbid"``)."""
    headers = _auth_headers(_register(client, "patch-extra@example.com")["access_token"])

    resp = client.patch(
        "/api/v1/users/me/settings",
        headers=headers,
        json={"ef_multiplier": 3, "sneaky_field": "value"},
    )
    assert resp.status_code == 422


def test_patch_rejects_oversized_locale(client: TestClient, fresh_db: Session) -> None:
    """``locale`` longer than 10 chars -> 422."""
    headers = _auth_headers(_register(client, "patch-locale@example.com")["access_token"])

    resp = client.patch(
        "/api/v1/users/me/settings",
        headers=headers,
        json={"locale": "this-is-way-too-long-for-a-locale"},
    )
    assert resp.status_code == 422


def test_patch_rejects_currency_wrong_length(client: TestClient, fresh_db: Session) -> None:
    """``currency`` length must be exactly 3 chars."""
    headers = _auth_headers(_register(client, "patch-currency@example.com")["access_token"])

    resp = client.patch(
        "/api/v1/users/me/settings",
        headers=headers,
        json={"currency": "IDRX"},
    )
    assert resp.status_code == 422


def test_patch_requires_auth(client: TestClient, fresh_db: Session) -> None:
    """No bearer token -> 401."""
    resp = client.patch(
        "/api/v1/users/me/settings",
        json={"ef_multiplier": 3},
    )
    assert resp.status_code == 401


def test_patch_isolates_between_users(client: TestClient, fresh_db: Session) -> None:
    """User B cannot mutate user A's settings -- auth-scoped to caller."""
    headers_a = _auth_headers(_register(client, "patch-iso-a@example.com")["access_token"])

    # Get a sense of the current endpoint shape for user A by issuing
    # a GET from user B's identity.
    headers_b = _auth_headers(_register(client, "patch-iso-b@example.com")["access_token"])

    # User A sets their own multiplier to 6.
    client.patch(
        "/api/v1/users/me/settings",
        headers=headers_a,
        json={"ef_multiplier": 6},
    )
    a_body = client.get("/api/v1/users/me/settings", headers=headers_a).json()
    b_body = client.get("/api/v1/users/me/settings", headers=headers_b).json()

    assert a_body["ef_multiplier"] == 6
    assert b_body["ef_multiplier"] == 3  # user B is unaffected


def test_patch_empty_body_returns_current(client: TestClient, fresh_db: Session) -> None:
    """An empty PATCH body round-trips the current settings -- useful for
    the FE's "save without changes" retry pattern."""
    headers = _auth_headers(_register(client, "patch-empty@example.com")["access_token"])

    resp = client.patch(
        "/api/v1/users/me/settings",
        headers=headers,
        json={},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ef_multiplier"] == 3
    assert body["dependents_count"] == 1


def test_get_then_patch_then_get_round_trip(client: TestClient, fresh_db: Session) -> None:
    """End-to-end sanity: GET -> PATCH -> GET sees the new value."""
    headers = _auth_headers(_register(client, "round-trip@example.com")["access_token"])

    initial = client.get("/api/v1/users/me/settings", headers=headers).json()
    assert initial["ef_multiplier"] == 3

    patch = client.patch(
        "/api/v1/users/me/settings",
        headers=headers,
        json={"ef_multiplier": 7},
    )
    assert patch.status_code == 200
    assert patch.json()["ef_multiplier"] == 7

    after = client.get("/api/v1/users/me/settings", headers=headers).json()
    assert after["ef_multiplier"] == 7
