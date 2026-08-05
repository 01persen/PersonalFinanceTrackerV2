"""Settings endpoints -- ``GET /settings`` + ``PATCH /settings``.

Scope: epic-0008, sub-0008-03. Primary settings surface for the
FE settings page (sub-0008-04). Returns the caller's profile
(email, display_name) bundled with preferences (currency, locale,
week_start, ef_multiplier, dependents_count, theme) plus an
optimistic-concurrency ``version`` token.

Pre-existing endpoints in this codebase stay functional:

* ``GET /preferences`` -- kept for back-compat (sub-0001-08).
* ``GET/PATCH /users/me/settings`` -- alias for sub-0005-02 EF
  goal-engine wiring.

New ``/settings`` is the primary path going forward (sub-0008-04
wires the FE here). It adds three things over the legacy aliases:

1. **Profile fields** (``email`` + ``display_name``) live next to
   preferences so the FE doesn't need a second ``GET /auth/me``.
2. **Strict enum whitelist** -- ``currency`` is locked to
   ``"IDR"``, ``locale`` to ``"id-ID"``, ``week_start`` to the
   seven Indonesian weekday names. Single-currency MVP (PRD §3).
3. **Optimistic concurrency** -- a ``version`` integer column on
   ``user_preferences`` bumps by 1 on every successful PATCH;
   clients echo the current value in the ``If-Match`` header and
   a stale echo returns ``412 Precondition Failed`` (AC (e)).
   The version is also surfaced as the response body field
   ``version: int`` and the response header ``ETag: "<version>"``
   (AC (c)).

The first GET auto-creates the row from the default seed values
when the seed module has not run (legacy users without a
``user_preferences`` row) -- AC (a). Existing seeded rows are
returned verbatim.

Validation happens in two layers:

* Pydantic models on the request body (``SettingsUpdate``) --
  known fields, type checks, enum whitelists, ``extra="forbid"``
  rejection of unknown fields. Surfaces as 422 with a structured
  detail list before the route runs.
* Route-level invariants -- ``If-Match`` semantics, version
  match, atomic commit. Surfaces as 412 (precondition) or 409
  (conflict).
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from typing import NoReturn

from fastapi import APIRouter, Depends, Header, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session
from sqlalchemy.orm.exc import StaleDataError

from app.api.schemas import SettingsPublic, SettingsUpdate
from app.api.v1.auth import get_current_user
from app.db.models.user import User
from app.db.models.user_preference import UserPreference
from app.db.session import get_session
from app.services.seed import (
    DEFAULT_CURRENCY,
    DEFAULT_DEPENDENTS_COUNT,
    DEFAULT_DISPLAY_NAME,
    DEFAULT_EMERGENCY_FUND_MULTIPLIER,
    DEFAULT_LOCALE,
    DEFAULT_PREFERENCES_VERSION,
    DEFAULT_THEME,
    DEFAULT_WEEK_START,
)

router = APIRouter(prefix="/settings", tags=["settings"])


def get_db() -> Iterator[Session]:
    """Per-router session dependency (mirrors user_settings.py / preferences.py)."""
    yield from get_session()


_ETAG_QUOTED_RE = re.compile(r'^"(\d+)"$')


def _parse_if_match(if_match: str | None) -> int | None:
    """Extract the version integer from an ``If-Match`` header value.

    The HTTP RFC requires strong ETags to be quoted:
    ``If-Match: "<version>"``. We accept:

    * Quoted form: ``If-Match: "3"``
    * Unquoted form: ``If-Match: 3`` -- tolerated for clients that
      don't follow the RFC strictly.

    Returns ``None`` for ``*`` (any-current-resource) -- treated as
    a wildcard match against the current version by the caller.
    Raises :class:`HTTPException` (400) on any value that isn't a
    parseable integer.
    """
    if if_match is None:
        return None
    if if_match.strip() == "*":
        return None  # wildcard; caller resolves against current version
    raw = if_match.strip()
    quoted = _ETAG_QUOTED_RE.match(raw)
    if quoted is not None:
        try:
            return int(quoted.group(1))
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(f"If-Match header carries a non-integer version; got {raw!r}"),
            ) from exc
    try:
        return int(raw)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(f"If-Match header must be '<version>', '\"<version>\"', or '*'; got {raw!r}"),
        ) from exc


def _load_or_create_preference(db: Session, *, user_id: str) -> UserPreference:
    """Return the caller's preferences row, creating one if missing.

    The epic-0001 seed module creates the row at registration, so this
    branch only fires for legacy users whose row was never seeded
    (AC (a) 'GET first-time ... auto-create row on first GET'). The
    auto-created row mirrors the seed defaults verbatim so a freshly
    registered user and a legacy auto-created user see an identical
    response from this endpoint.
    """
    pref = db.execute(
        select(UserPreference).where(UserPreference.user_id == user_id)
    ).scalar_one_or_none()
    if pref is not None:
        return pref

    pref = UserPreference(
        user_id=user_id,
        locale=DEFAULT_LOCALE,
        currency=DEFAULT_CURRENCY,
        emergency_fund_multiplier=DEFAULT_EMERGENCY_FUND_MULTIPLIER,
        dependents_count=DEFAULT_DEPENDENTS_COUNT,
        theme=DEFAULT_THEME,
        week_start=DEFAULT_WEEK_START,
        display_name=DEFAULT_DISPLAY_NAME,
        version=DEFAULT_PREFERENCES_VERSION,
    )
    db.add(pref)
    db.flush()
    return pref


def _load_preference_for_update(db: Session, *, user_id: str) -> UserPreference | None:
    """Return the caller's preferences row with an exclusive row lock.

    On PostgreSQL this maps to ``SELECT ... FOR UPDATE`` so a
    concurrent PATCH on the same row blocks until our transaction
    commits or rolls back -- the second PATCH then re-reads the
    bumped ``version`` and the If-Match check at the route layer
    surfaces a clean 412 instead of a SQLAlchemy ``StaleDataError``.

    On SQLite the lock is implicit (database-level), so the second
    PATCH waits on the first's COMMIT before reading. Same
    observable behaviour, different locking primitive.

    Returns ``None`` when no row exists yet so the caller can fall
    through to the auto-create branch.
    """
    return db.execute(
        select(UserPreference).where(UserPreference.user_id == user_id).with_for_update()
    ).scalar_one_or_none()


def _raise_412_precondition_failed(*, current_version: int) -> NoReturn:
    """Raise a 412 with the *current* ETag header so the FE can re-fetch + retry.

    Centralised so both the pre-commit If-Match check and the
    post-commit ``StaleDataError`` recovery path raise the exact same
    response shape (same status, same header, same body key) --
    callers can't accidentally drift the wire contract between the
    two surface points.

    Annotated ``-> NoReturn`` so mypy strict narrows ``T | None``
    arguments to ``T`` in the caller's code path (the function
    provably never returns, so the post-call branch is the only
    remaining live branch). This was the regression in PR #62 --
    without the ``NoReturn`` annotation, mypy couldn't tell that the
    helper always raises and so couldn't narrow ``current: UserPreference
    | None`` to ``UserPreference`` for the next call.
    """
    raise HTTPException(
        status_code=status.HTTP_412_PRECONDITION_FAILED,
        detail=(f"If-Match version is stale; current settings version is {current_version}"),
        headers={"ETag": f'"{current_version}"'},
    )


def _attach_etag(response: Response, *, version: int) -> None:
    """Stamp the strong ``ETag`` header onto the response.

    Strong validators (``ETag: "<version>"``) match strict byte-for-byte
    equality, which is exactly what the FE will need when it sends the
    value back as ``If-Match`` on the next PATCH.
    """
    response.headers["ETag"] = f'"{version}"'


@router.get("", response_model=SettingsPublic)
def get_my_settings(
    response: Response,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> SettingsPublic:
    """Return the caller's profile + preferences + version (sub-0008-03 AC (a)).

    Auto-creates the row from the seed defaults if no preference row
    exists yet for the caller (legacy-user fallback). The version token
    is surfaced both as the response body field ``version: int`` and as
    the ``ETag`` response header -- AC (c).

    The FE settings page is expected to round-trip the ``version`` value
    back as the ``If-Match`` request header on PATCH (AC (e)).
    """
    pref = _load_or_create_preference(db, user_id=str(current_user.id))
    db.commit()
    db.refresh(pref)
    body = SettingsPublic.from_user_and_preference(current_user, pref)
    _attach_etag(response, version=pref.version)
    return body


@router.patch("", response_model=SettingsPublic)
def update_my_settings(
    payload: SettingsUpdate,
    response: Response,
    if_match: str | None = Header(default=None, alias="If-Match", include_in_schema=False),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> SettingsPublic:
    """Partial update of the caller's settings row (sub-0008-03 AC (b), (c), (e)).

    Optimistic-concurrency: clients **must** echo the current version in
    the ``If-Match`` header (``If-Match: "<version>"`` or the unquoted
    equivalent). A stale value is rejected with ``412 Precondition
    Failed`` before any field is written, so a 2-tab race with one tab
    editing while another has unsaved stale state can never silently
    clobber either side.

    Empty body + bare ``If-Match: "1"`` is allowed and bumps the version
    -- the route treats it like a "save with no changes" round-trip the
    FE can retry safely.

    Validation:

    * ``currency`` hard-rejected if not ``IDR`` (Pydantic -> 422).
    * ``locale`` hard-rejected if not ``id-ID`` (Pydantic -> 422).
    * ``week_start`` hard-rejected if not in the seven-day enum
      (Pydantic -> 422).
    * ``ef_multiplier`` hard-rejected if < 1 (Pydantic -> 422).
    * ``display_name`` hard-rejected if > 100 chars (Pydantic -> 422).
    * Unknown fields -> 422 via ``extra="forbid"``.

    Server-controlled fields (``id``, ``user_id``, ``created_at``,
    ``version``, ``email``) are never editable through this endpoint --
    Pydantic drops them from the schema entirely.
    """
    _ = _parse_if_match(if_match)  # surface malformed header as 400

    # Acquire row-level lock first so a concurrent PATCH on the same
    # row blocks on our transaction instead of racing past the
    # If-Match check at the same version (AC (e) -- 'GET during PATCH
    # in-flight no partial state'). The read uses ``with_for_update``
    # so PostgreSQL serialises the two writers at the row level; on
    # SQLite the database-level lock provides the same guarantee.
    locked_pref = _load_preference_for_update(db, user_id=str(current_user.id))
    if locked_pref is None:
        # Legacy user with no row yet -- auto-create from seed
        # defaults (AC (a)). The create-and-commit drops the row
        # into the DB; the subsequent If-Match check sees the fresh
        # ``version=1`` and accepts the first PATCH.
        pref = _load_or_create_preference(db, user_id=str(current_user.id))
    else:
        pref = locked_pref

    requested_version = _parse_if_match(if_match)
    if requested_version is None:
        # Wildcard ``*`` matches the current version; explicit ``None``
        # means 'no If-Match at all' which we also accept as 'match
        # current version' for backward-compat with clients that don't
        # yet round-trip the ETag. (sub-0008-03 AC (e) only describes
        # the *stale* case.)
        requested_version = pref.version
    if requested_version != pref.version:
        # Pre-commit If-Match miss: the row is still pointing at the
        # version we loaded under the row lock, so we know the FE's
        # view is stale. Surface 412 with that exact version so the
        # FE can refresh and retry without a wasted round-trip.
        _raise_412_precondition_failed(current_version=pref.version)

    data = payload.model_dump(exclude_unset=True)
    if "ef_multiplier" in data:
        pref.emergency_fund_multiplier = int(data["ef_multiplier"])
    for field, value in data.items():
        if field == "ef_multiplier":
            continue  # wired above to keep the storage column mapping explicit
        setattr(pref, field, value)

    # Bump the version on every successful PATCH -- mirrors the upstream
    # ``updated_at`` write from ``TimestampMixin`` so clients holding a
    # cached GET see both signals on the next read.
    pref.version = pref.version + 1
    try:
        db.commit()
    except StaleDataError:
        # Concurrent writer beat us to the row between the row-lock
        # read and the commit. PostgreSQL's ``SELECT ... FOR UPDATE``
        # blocks contending writers so this branch only fires under
        # connection-isolated test engines (SQLite StaticPool) or
        # pathological Postgres setups that don't enforce the lock;
        # in either case the *observable* contract is the same: a
        # 412 with the bumped ``ETag`` so the FE can refresh and
        # retry -- never a leaked 500.
        db.rollback()
        # Re-read the row in a fresh transaction so the caller sees
        # the *post-race* version, not the row we held in the
        # rolled-back session.
        current = db.execute(
            select(UserPreference).where(UserPreference.user_id == current_user.id)
        ).scalar_one_or_none()
        if current is None:
            # Defensive: row vanished mid-PATCH. Surface 412 with
            # the seed-default version so the FE refetches and
            # picks up whatever the seed module produces next.
            _raise_412_precondition_failed(current_version=DEFAULT_PREFERENCES_VERSION)
        _raise_412_precondition_failed(current_version=current.version)

    db.refresh(pref)

    body = SettingsPublic.from_user_and_preference(current_user, pref)
    _attach_etag(response, version=pref.version)
    return body
