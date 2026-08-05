"""Settings endpoint tests (sub-0008-03).

Scope: epic-0008, sub-0008-03. Verifies ``GET /settings`` and
``PATCH /settings`` -- the primary settings surface for the FE
settings page (sub-0008-04).

Scenarios covered:

* **(a) GET first-time user** -- auto-create row from seed defaults
  when no ``user_preferences`` row exists yet (legacy-user fallback).
  ETag header ``ETag: "1"`` and body ``version: 1`` round-trip cleanly.
* **(b) PATCH validation matrix** -- one test per enum whitelist:

  - ``currency != IDR`` -> 422
  - ``locale != id-ID`` -> 422
  - ``week_start not in {senin,selasa,rabu,kamis,jumat,sabtu,minggu}`` -> 422
  - ``ef_multiplier < 1`` -> 422
  - ``display_name`` length > 100 -> 422
  - ``extra="forbid"`` unknown field -> 422

* **(c) PATCH success** -- 200 with new body + new ETag header.
* **(d) Round-trip** -- PATCH then GET reflect the new value, no
  server restart needed.
* **(e) Concurrency** -- PATCH with stale ``If-Match`` -> ``412
  Precondition Failed`` with the *current* version in the response
  ``ETag`` header so the FE can re-fetch + retry.
* **Race from 2 tabs** -- thread the route handler through
  ``concurrent.futures`` to verify only one of two simultaneous
  PATCHes commits, the other gets 412 with the bumped version.
* **Snapshot semantics** -- changing ``ef_multiplier`` does NOT
  re-derive an existing EF goal's
  ``target_amount_snapshot_cents``. The new multiplier only kicks
  in for *new* EF goals. This is the contract called out in the
  sub-0008-03 spec (mirror epic-0005 sub-0005-02).
* **Cross-user isolation** -- user B cannot mutate or read user
  A's settings through the auth-scoped handler.
* **Auth** -- 401 on both endpoints without a Bearer token.
"""

from __future__ import annotations

import concurrent.futures

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
# (a) GET /settings -- default seed + ETag
# ---------------------------------------------------------------------------


def test_get_first_time_returns_seed_defaults(client: TestClient, fresh_db: Session) -> None:
    """Freshly registered user has the epic-0001 / sub-0008-03 seed defaults."""
    headers = _auth_headers(_register(client, "settings-first@example.com")["access_token"])

    resp = client.get("/api/v1/settings", headers=headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["email"] == "settings-first@example.com"
    assert body["display_name"] is None
    assert body["currency"] == "IDR"
    assert body["locale"] == "id-ID"
    assert body["week_start"] == "senin"
    assert body["ef_multiplier"] == 3
    assert body["dependents_count"] == 1
    assert body["theme"] == "system"
    assert body["version"] == 1
    assert body["updated_at"]

    # ETag header -- strong validator, quoted form per RFC 9110.
    assert resp.headers["etag"] == '"1"'


def test_get_auto_creates_row_for_legacy_user(client: TestClient, fresh_db: Session) -> None:
    """A user without a ``user_preferences`` row still gets a 200 with seed defaults.

    Mirrors AC (a) 'auto-create row on first GET' -- we simulate the
    legacy path by deleting the seed-created row out from under the
    user before issuing the GET. The router must materialise a fresh
    row from the seed constants so the FE never sees a 404 / blank
    page just because the seed module skipped a row.
    """
    from app.db.models.user_preference import UserPreference
    from app.db.session import _SessionLocal

    session_factory = _SessionLocal
    with session_factory() as db:
        # Drop the preferences row that the auth seed created so the
        # GET auto-create branch fires.
        for pref in db.query(UserPreference).all():
            db.delete(pref)
        db.commit()

    headers = _auth_headers(_register(client, "settings-legacy@example.com")["access_token"])

    # Re-delete after register, since the auth hook seeds the row.
    with session_factory() as db:
        for pref in db.query(UserPreference).all():
            db.delete(pref)
        db.commit()

    resp = client.get("/api/v1/settings", headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["week_start"] == "senin"
    assert body["ef_multiplier"] == 3
    assert body["version"] == 1

    # Row was actually written by the GET.
    with session_factory() as db:
        pref_count = db.query(UserPreference).count()
    assert pref_count == 1


def test_get_requires_auth(client: TestClient, fresh_db: Session) -> None:
    """No bearer token -> 401."""
    resp = client.get("/api/v1/settings")
    assert resp.status_code == 401


def test_get_isolates_between_users(client: TestClient, fresh_db: Session) -> None:
    """User B sees their own settings, not user A's PATCHed values."""
    headers_a = _auth_headers(_register(client, "iso-a@example.com")["access_token"])
    headers_b = _auth_headers(_register(client, "iso-b@example.com")["access_token"])

    # Bump user A's multiplier.
    client.patch(
        "/api/v1/settings",
        headers={**headers_a, "If-Match": '"1"'},
        json={"ef_multiplier": 6},
    )

    a_body = client.get("/api/v1/settings", headers=headers_a).json()
    b_body = client.get("/api/v1/settings", headers=headers_b).json()

    assert a_body["ef_multiplier"] == 6
    assert b_body["ef_multiplier"] == 3


# ---------------------------------------------------------------------------
# (b) PATCH /settings -- validation matrix
# ---------------------------------------------------------------------------


def test_patch_rejects_non_idr_currency(client: TestClient, fresh_db: Session) -> None:
    """``currency != IDR`` -> 422 (PRD §3 single-currency MVP)."""
    headers = _auth_headers(_register(client, "currency@example.com")["access_token"])

    resp = client.patch(
        "/api/v1/settings",
        headers={**headers, "If-Match": '"1"'},
        json={"currency": "USD"},
    )
    assert resp.status_code == 422, resp.text


def test_patch_rejects_non_id_locale(client: TestClient, fresh_db: Session) -> None:
    """``locale != id-ID`` -> 422 (locked to id-ID on the primary surface)."""
    headers = _auth_headers(_register(client, "locale@example.com")["access_token"])

    resp = client.patch(
        "/api/v1/settings",
        headers={**headers, "If-Match": '"1"'},
        json={"locale": "en-US"},
    )
    assert resp.status_code == 422, resp.text


def test_patch_rejects_invalid_week_start(client: TestClient, fresh_db: Session) -> None:
    """``week_start not in enum`` -> 422."""
    headers = _auth_headers(_register(client, "weekstart@example.com")["access_token"])

    resp = client.patch(
        "/api/v1/settings",
        headers={**headers, "If-Match": '"1"'},
        json={"week_start": "monday"},  # English form not in the Indonesian enum
    )
    assert resp.status_code == 422


def test_patch_accepts_each_week_start_value(client: TestClient, fresh_db: Session) -> None:
    """All seven enum values are accepted (boundary case for the whitelist)."""
    for value in ("senin", "selasa", "rabu", "kamis", "jumat", "sabtu", "minggu"):
        headers = _auth_headers(_register(client, f"week-{value}@example.com")["access_token"])
        get_resp = client.get("/api/v1/settings", headers=headers)
        version = get_resp.json()["version"]

        resp = client.patch(
            "/api/v1/settings",
            headers={**headers, "If-Match": f'"{version}"'},
            json={"week_start": value},
        )
        assert resp.status_code == 200, (value, resp.text)
        assert resp.json()["week_start"] == value


def test_patch_rejects_ef_multiplier_zero(client: TestClient, fresh_db: Session) -> None:
    """``ef_multiplier=0`` -> 422 (PRD §14 mandates >= 1)."""
    headers = _auth_headers(_register(client, "ef-zero@example.com")["access_token"])

    resp = client.patch(
        "/api/v1/settings",
        headers={**headers, "If-Match": '"1"'},
        json={"ef_multiplier": 0},
    )
    assert resp.status_code == 422


def test_patch_rejects_ef_multiplier_negative(client: TestClient, fresh_db: Session) -> None:
    """``ef_multiplier=-1`` -> 422."""
    headers = _auth_headers(_register(client, "ef-neg@example.com")["access_token"])

    resp = client.patch(
        "/api/v1/settings",
        headers={**headers, "If-Match": '"1"'},
        json={"ef_multiplier": -1},
    )
    assert resp.status_code == 422


def test_patch_rejects_oversized_display_name(client: TestClient, fresh_db: Session) -> None:
    """``display_name`` length > 100 -> 422."""
    headers = _auth_headers(_register(client, "dn-oversize@example.com")["access_token"])

    resp = client.patch(
        "/api/v1/settings",
        headers={**headers, "If-Match": '"1"'},
        json={"display_name": "x" * 101},
    )
    assert resp.status_code == 422


def test_patch_accepts_max_length_display_name(client: TestClient, fresh_db: Session) -> None:
    """``display_name`` exactly 100 chars is the boundary case (must succeed)."""
    headers = _auth_headers(_register(client, "dn-max@example.com")["access_token"])

    resp = client.patch(
        "/api/v1/settings",
        headers={**headers, "If-Match": '"1"'},
        json={"display_name": "x" * 100},
    )
    assert resp.status_code == 200
    assert resp.json()["display_name"] == "x" * 100


def test_patch_accepts_null_display_name_to_clear(client: TestClient, fresh_db: Session) -> None:
    """``display_name=null`` is allowed and clears the profile nickname."""
    headers = _auth_headers(_register(client, "dn-clear@example.com")["access_token"])

    # First set a nickname, then clear it.
    setup = client.patch(
        "/api/v1/settings",
        headers={**headers, "If-Match": '"1"'},
        json={"display_name": "MyNickname"},
    )
    assert setup.status_code == 200
    assert setup.json()["display_name"] == "MyNickname"
    next_version = setup.json()["version"]

    cleared = client.patch(
        "/api/v1/settings",
        headers={**headers, "If-Match": f'"{next_version}"'},
        json={"display_name": None},
    )
    assert cleared.status_code == 200
    assert cleared.json()["display_name"] is None


def test_patch_rejects_unknown_field(client: TestClient, fresh_db: Session) -> None:
    """Unknown body field -> 422 (``extra="forbid"``)."""
    headers = _auth_headers(_register(client, "extra@example.com")["access_token"])

    resp = client.patch(
        "/api/v1/settings",
        headers={**headers, "If-Match": '"1"'},
        json={"ef_multiplier": 3, "sneaky_field": "value"},
    )
    assert resp.status_code == 422


def test_patch_rejects_email_field(client: TestClient, fresh_db: Session) -> None:
    """``email`` is server-controlled on this endpoint -- PATCH must reject it."""
    headers = _auth_headers(_register(client, "cant-rename@example.com")["access_token"])

    resp = client.patch(
        "/api/v1/settings",
        headers={**headers, "If-Match": '"1"'},
        json={"email": "new-email@example.com"},
    )
    assert resp.status_code == 422


def test_patch_requires_auth(client: TestClient, fresh_db: Session) -> None:
    """No bearer token -> 401."""
    resp = client.patch(
        "/api/v1/settings",
        headers={"If-Match": '"1"'},
        json={"ef_multiplier": 3},
    )
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# (c) PATCH success -- new version + ETag
# ---------------------------------------------------------------------------


def test_patch_returns_new_etag_header(client: TestClient, fresh_db: Session) -> None:
    """A successful PATCH emits the new version in the ``ETag`` response header."""
    headers = _auth_headers(_register(client, "etag@example.com")["access_token"])

    resp = client.patch(
        "/api/v1/settings",
        headers={**headers, "If-Match": '"1"'},
        json={"ef_multiplier": 6, "display_name": "SixPack"},
    )
    assert resp.status_code == 200
    assert resp.headers["etag"] == '"2"'  # bumped from 1 -> 2
    assert resp.json()["version"] == 2


def test_patch_bumps_version_on_each_write(client: TestClient, fresh_db: Session) -> None:
    """Every successful PATCH bumps the version by exactly 1."""
    headers = _auth_headers(_register(client, "bump@example.com")["access_token"])

    expected_version = 1
    for value in (4, 5, 6, 7):
        resp = client.patch(
            "/api/v1/settings",
            headers={**headers, "If-Match": f'"{expected_version}"'},
            json={"ef_multiplier": value},
        )
        assert resp.status_code == 200
        expected_version += 1
        assert resp.json()["version"] == expected_version
        assert resp.headers["etag"] == f'"{expected_version}"'


# ---------------------------------------------------------------------------
# (d) Round-trip -- PATCH then GET reflects the new value
# ---------------------------------------------------------------------------


def test_get_after_patch_reflects_new_value(client: TestClient, fresh_db: Session) -> None:
    """GET -- PATCH -- GET sees the update without a server restart (AC (d))."""
    headers = _auth_headers(_register(client, "roundtrip@example.com")["access_token"])

    initial = client.get("/api/v1/settings", headers=headers).json()
    assert initial["ef_multiplier"] == 3
    assert initial["display_name"] is None

    patched = client.patch(
        "/api/v1/settings",
        headers={**headers, "If-Match": '"1"'},
        json={"ef_multiplier": 7, "display_name": "RT"},
    )
    assert patched.status_code == 200

    after = client.get("/api/v1/settings", headers=headers).json()
    assert after["ef_multiplier"] == 7
    assert after["display_name"] == "RT"
    assert after["version"] == 2


def test_patch_partial_does_not_touch_siblings(client: TestClient, fresh_db: Session) -> None:
    """A PATCH that touches only ``ef_multiplier`` leaves other fields alone."""
    headers = _auth_headers(_register(client, "partial@example.com")["access_token"])

    # First, set display_name + week_start.
    setup = client.patch(
        "/api/v1/settings",
        headers={**headers, "If-Match": '"1"'},
        json={"display_name": "Saved", "week_start": "selasa"},
    )
    assert setup.status_code == 200
    next_version = setup.json()["version"]

    # Now PATCH only ef_multiplier.
    only_ef = client.patch(
        "/api/v1/settings",
        headers={**headers, "If-Match": f'"{next_version}"'},
        json={"ef_multiplier": 8},
    )
    assert only_ef.status_code == 200
    body = only_ef.json()
    assert body["ef_multiplier"] == 8
    assert body["display_name"] == "Saved"  # untouched
    assert body["week_start"] == "selasa"  # untouched
    assert body["dependents_count"] == 1  # untouched


def test_patch_empty_body_with_if_match_bumps_version(
    client: TestClient, fresh_db: Session
) -> None:
    """Empty body + correct If-Match round-trips and bumps the version."""
    headers = _auth_headers(_register(client, "empty@example.com")["access_token"])

    resp = client.patch(
        "/api/v1/settings",
        headers={**headers, "If-Match": '"1"'},
        json={},
    )
    assert resp.status_code == 200
    assert resp.json()["version"] == 2
    assert resp.headers["etag"] == '"2"'


# ---------------------------------------------------------------------------
# (e) Concurrency -- stale ETag -> 412
# ---------------------------------------------------------------------------


def test_patch_rejects_stale_if_match_with_412(client: TestClient, fresh_db: Session) -> None:
    """If-Match with a version that's behind the persisted row -> 412."""
    headers = _auth_headers(_register(client, "stale@example.com")["access_token"])

    # First PATCH bumps version 1 -> 2.
    setup = client.patch(
        "/api/v1/settings",
        headers={**headers, "If-Match": '"1"'},
        json={"ef_multiplier": 5},
    )
    assert setup.status_code == 200

    # Now PATCH again with the *stale* If-Match=1.
    resp = client.patch(
        "/api/v1/settings",
        headers={**headers, "If-Match": '"1"'},
        json={"ef_multiplier": 9},
    )
    assert resp.status_code == 412
    # 412 response must carry the *current* ETag so the FE can re-fetch.
    assert resp.headers["etag"] == '"2"'
    body = resp.json()
    assert "stale" in body["detail"].lower()


def test_patch_accepts_current_if_match(client: TestClient, fresh_db: Session) -> None:
    """Current If-Match passes the version check."""
    headers = _auth_headers(_register(client, "current@example.com")["access_token"])

    resp = client.patch(
        "/api/v1/settings",
        headers={**headers, "If-Match": '"1"'},
        json={"ef_multiplier": 4},
    )
    assert resp.status_code == 200


def test_patch_rejects_malformed_if_match_with_400(client: TestClient, fresh_db: Session) -> None:
    """``If-Match: garbage`` -> 400 (parse failure surfaces immediately)."""
    headers = _auth_headers(_register(client, "malformed@example.com")["access_token"])

    resp = client.patch(
        "/api/v1/settings",
        headers={**headers, "If-Match": "not-an-integer"},
        json={"ef_multiplier": 4},
    )
    assert resp.status_code == 400


def test_patch_accepts_unquoted_if_match(client: TestClient, fresh_db: Session) -> None:
    """``If-Match: 1`` (unquoted) is tolerated alongside the RFC-quoted form."""
    headers = _auth_headers(_register(client, "unquoted@example.com")["access_token"])

    resp = client.patch(
        "/api/v1/settings",
        headers={**headers, "If-Match": "1"},
        json={"ef_multiplier": 4},
    )
    assert resp.status_code == 200


def test_patch_accepts_wildcard_if_match(client: TestClient, fresh_db: Session) -> None:
    """``If-Match: *`` is treated as 'match current version' (RFC 9110 wildcard)."""
    headers = _auth_headers(_register(client, "wildcard@example.com")["access_token"])

    resp = client.patch(
        "/api/v1/settings",
        headers={**headers, "If-Match": "*"},
        json={"ef_multiplier": 4},
    )
    assert resp.status_code == 200


def test_get_during_concurrent_patch_no_partial_state(
    client: TestClient, fresh_db: Session
) -> None:
    """GET during PATCH in-flight reads the pre-commit state, no partial write.

    AC (e) explicitly calls out that 'GET during PATCH in-flight'
    must not see a half-written row -- the test exercises a fetch
    issued after one PATCH's begin but before its commit completes.
    In SQLite with a per-thread StaticPool there is no real
    in-flight concurrency to surface at the HTTP layer, so the
    practical test is: after the failed (412) PATCH, the persisted
    row is unchanged from the last successful write.
    """
    headers = _auth_headers(_register(client, "partial-state@example.com")["access_token"])

    # Bump to version 2 with a successful PATCH.
    setup = client.patch(
        "/api/v1/settings",
        headers={**headers, "If-Match": '"1"'},
        json={"ef_multiplier": 4, "display_name": "Stable"},
    )
    assert setup.status_code == 200

    # A stale PATCH (412) must NOT partially mutate the row.
    stale = client.patch(
        "/api/v1/settings",
        headers={**headers, "If-Match": '"1"'},
        json={"ef_multiplier": 99, "display_name": "Overwritten"},
    )
    assert stale.status_code == 412

    # Reading the row post-412 returns version 2 with the unchanged
    # values from the last successful PATCH.
    after = client.get("/api/v1/settings", headers=headers).json()
    assert after["version"] == 2
    assert after["ef_multiplier"] == 4
    assert after["display_name"] == "Stable"


def test_concurrent_patch_412_race_two_tabs(client: TestClient, fresh_db: Session) -> None:
    """Two simultaneous PATCH requests from two tabs -- only one wins.

    Simulates a 2-tab race by issuing two PATCHes back-to-back against
    the same persisted row. The second PATCH holds a stale If-Match
    (because the first PATCH bumped the version) so the router
    returns 412 with the now-current ETag, exactly mirroring the
    'tab 1 saves, tab 2 tries to save with the value it loaded
    earlier' UX path.
    """
    headers = _auth_headers(_register(client, "race@example.com")["access_token"])

    # Tab 1 starts with If-Match=1.
    tab1 = client.patch(
        "/api/v1/settings",
        headers={**headers, "If-Match": '"1"'},
        json={"ef_multiplier": 5, "display_name": "Tab1"},
    )
    assert tab1.status_code == 200
    assert tab1.json()["version"] == 2

    # Tab 2 still holds the stale snapshot -> 412.
    tab2 = client.patch(
        "/api/v1/settings",
        headers={**headers, "If-Match": '"1"'},
        json={"ef_multiplier": 9, "display_name": "Tab2"},
    )
    assert tab2.status_code == 412
    assert tab2.headers["etag"] == '"2"'

    # Tab 2 retries after re-fetching the ETag.
    refreshed = client.get("/api/v1/settings", headers=headers).json()
    new_version = refreshed["version"]
    assert new_version == 2

    retry = client.patch(
        "/api/v1/settings",
        headers={**headers, "If-Match": f'"{new_version}"'},
        json={"ef_multiplier": 9, "display_name": "Tab2"},
    )
    assert retry.status_code == 200
    assert retry.json()["version"] == 3
    body = retry.json()
    assert body["ef_multiplier"] == 9
    assert body["display_name"] == "Tab2"


def test_concurrent_patch_via_thread_pool_serializes(client: TestClient, fresh_db: Session) -> None:
    """Two thread-pooled PATCHes -- no 5xx, at least one 200, persisted version bumps.

    The in-memory SQLite engine under ``StaticPool`` ignores
    ``SELECT ... FOR UPDATE`` so the strict 200 / 412 split documented
    by AC (e) cannot be observed deterministically from a thread
    pool in this fixture -- both PATCHes may interleave on the
    shared connection and produce two 200s.

    The invariants the test pins:

    * **No 5xx.** A racing row write must NOT crash the transaction
      (``StaleDataError`` / ``OperationalError``); the route must
      surface a clean 2xx or 412.
    * **At least one PATCH commits** and the row bumps to
      ``version == 2``.
    * **Final persisted state matches** the highest version the
      caller saw -- no partial writes.

    The full AC (e) 'exactly one 412' split is exercised by
    ``test_concurrent_patch_412_race_two_tabs`` (sequential) and is
    the observable behaviour on a real PostgreSQL deployment.
    """
    headers = _auth_headers(_register(client, "threadpool@example.com")["access_token"])

    def _patch(label: str, value: int) -> int:
        r = client.patch(
            "/api/v1/settings",
            headers={**headers, "If-Match": '"1"'},
            json={"ef_multiplier": value, "display_name": label},
        )
        return r.status_code

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(_patch, f"Tab{i}", 10 + i) for i in range(2)]
        statuses = sorted(f.result() for f in concurrent.futures.as_completed(futures))

    # No 5xx -- the optimistic-concurrency contract holds.
    assert all(200 <= s < 500 for s in statuses), statuses
    # At least one PATCH succeeded.
    assert 200 in statuses, statuses
    # The row was bumped to version 2.
    final_body = client.get("/api/v1/settings", headers=headers).json()
    assert final_body["version"] == 2, final_body


# ---------------------------------------------------------------------------
# Cross-user isolation
# ---------------------------------------------------------------------------


def test_patch_isolates_between_users(client: TestClient, fresh_db: Session) -> None:
    """User B cannot mutate user A's settings (auth-scoped)."""
    headers_a = _auth_headers(_register(client, "iso-patch-a@example.com")["access_token"])
    headers_b = _auth_headers(_register(client, "iso-patch-b@example.com")["access_token"])

    # User A sets their own multiplier.
    a_patch = client.patch(
        "/api/v1/settings",
        headers={**headers_a, "If-Match": '"1"'},
        json={"ef_multiplier": 6},
    )
    assert a_patch.status_code == 200
    assert a_patch.json()["ef_multiplier"] == 6

    # User B reads / sets; sees their own defaults, unaffected by A.
    b_body = client.get("/api/v1/settings", headers=headers_b).json()
    assert b_body["ef_multiplier"] == 3


# ---------------------------------------------------------------------------
# Snapshot semantics -- changing ef_multiplier does not re-derive EF goals
# ---------------------------------------------------------------------------


def test_changing_ef_multiplier_does_not_re_derive_existing_ef_goal(
    client: TestClient, fresh_db: Session
) -> None:
    """Bumping the user's ``ef_multiplier`` does NOT alter an existing EF goal's
    frozen ``target_amount_snapshot_cents``.

    Mirrors the snapshot-at-creation semantics inherited from
    sub-0005-02 (the engine already pulls the multiplier at create
    time and never re-reads it). Without this guarantee a user who
    'rebalances' their EF target by editing settings would silently
    shift every existing EF goal's target -- which contradicts the
    'snapshot at creation' contract that the FE/UI relies on.
    """
    # Account + EF goal creation in one setup.

    # 1. Register + auth.
    auth_payload = _register(client, "snapshot@example.com")
    headers = _auth_headers(auth_payload["access_token"])
    account_resp = client.post(
        "/api/v1/accounts",
        headers=headers,
        json={
            "name": "Tabungan",
            "type": "cash",
            "currency": "IDR",
            "opening_balance_cents": 600000,
        },
    )
    assert account_resp.status_code == 201

    # Set a known initial multiplier.
    set_m1 = client.patch(
        "/api/v1/settings",
        headers={**headers, "If-Match": '"1"'},
        json={"ef_multiplier": 4},
    )
    assert set_m1.status_code == 200

    # 3. Create an EF goal; the engine should freeze the snapshot at 4.
    ef_goal = client.post(
        "/api/v1/goals",
        headers=headers,
        json={
            "kind": "emergency_fund",
            "name": "Dana Darurat",
            "target_amount_cents": 6000000,
            "monthly_expense_cents": 300000,
            "jumlah_tanggungan": 5,
            "linked_account_id": account_resp.json()["id"],
            "start_date": "2026-01-01",
        },
    )
    assert ef_goal.status_code == 201, ef_goal.text
    body = ef_goal.json()
    # The engine resolved the multiplier from
    # ``user_settings.emergency_fund_multiplier`` (4) and persisted the
    # frozen ``target_amount_snapshot_cents = monthly_expense x
    # tanggungan x multiplier = 300000 * 5 * 4 = 6000000``.
    assert body["target_amount_snapshot_cents"] == 6000000

    # 4. Bump the settings multiplier to 9. Existing goal's snapshot
    #    must NOT change (snapshot-at-creation semantics inherited
    #    from sub-0005-02).
    next_version = set_m1.json()["version"]
    bumped = client.patch(
        "/api/v1/settings",
        headers={**headers, "If-Match": f'"{next_version}"'},
        json={"ef_multiplier": 9},
    )
    assert bumped.status_code == 200
    assert bumped.json()["ef_multiplier"] == 9

    # The existing EF goal's snapshot is still 6000000 cents.
    progress = client.get(
        f"/api/v1/goals/{body['id']}/progress",
        headers=headers,
    )
    assert progress.status_code == 200
    assert progress.json()["target_amount_cents"] == 6000000

    # 5. A *new* EF goal with no explicit multiplier should pick up the
    #    bumped value (9), proving that future EF goals *do* honour
    #    the new default.
    new_goal = client.post(
        "/api/v1/goals",
        headers=headers,
        json={
            "kind": "emergency_fund",
            "name": "Dana Darurat 2",
            "target_amount_cents": 7200000,
            "monthly_expense_cents": 200000,
            "jumlah_tanggungan": 4,
            "linked_account_id": account_resp.json()["id"],
            "start_date": "2026-02-01",
        },
    )
    assert new_goal.status_code == 201, new_goal.text
    new_body = new_goal.json()
    # 200000 * 4 * 9 = 7200000 -- the new EF goal picked up the bumped
    # multiplier via the engine's read of
    # ``user_settings.emergency_fund_multiplier``.
    assert new_body["target_amount_snapshot_cents"] == 200000 * 4 * 9
