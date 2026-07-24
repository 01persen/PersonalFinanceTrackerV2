"""Auth endpoints — register, login, logout, refresh, me.

Tokens are JWTs (HS256) signed with ``JWT_SECRET``. The frontend is expected to
keep the access token in memory and the refresh token in a secure store, sending
the access token in the ``Authorization: Bearer <token>`` header.

Logout is stateless for the MVP — the client simply discards the tokens and the
server confirms with a 204. Revocation / blacklist is intentionally deferred to
post-MVP (PRD §13, Out-of-Scope).
"""

from __future__ import annotations

from collections.abc import Iterator

from fastapi import APIRouter, Depends, HTTPException, Response, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.api.schemas import (
    AccessToken,
    LoginRequest,
    RefreshRequest,
    RegisterRequest,
    TokenPair,
    UserPublic,
)
from app.core.config import get_settings
from app.core.security import (
    TokenError,
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    verify_password,
)
from app.db.models.user import User
from app.db.session import get_session

router = APIRouter(prefix="/auth", tags=["auth"])

_bearer = HTTPBearer(auto_error=True)


def get_db() -> Iterator[Session]:
    """Re-export the session dependency for a clean per-router import path."""
    yield from get_session()


def _issue_pair(user: User) -> TokenPair:
    settings = get_settings()
    return TokenPair(
        access_token=create_access_token(user.id),
        refresh_token=create_refresh_token(user.id),
        expires_in=settings.jwt_access_token_expire_minutes * 60,
    )


def _credentials_exception(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def get_current_user(
    creds: HTTPAuthorizationCredentials = Depends(_bearer),
    db: Session = Depends(get_db),
) -> User:
    """Resolve the authenticated user from the Bearer token."""
    try:
        user_id = decode_token(creds.credentials, expected_type="access")
    except TokenError as exc:
        raise _credentials_exception(str(exc)) from exc

    user = db.get(User, user_id)
    if user is None:
        raise _credentials_exception("user no longer exists")
    return user


@router.post(
    "/register",
    response_model=TokenPair,
    status_code=status.HTTP_201_CREATED,
)
def register(payload: RegisterRequest, db: Session = Depends(get_db)) -> TokenPair:
    """Create a new account and return an access/refresh token pair."""
    email = payload.email.lower()
    existing = db.query(User).filter(User.email == email).one_or_none()
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="email already registered",
        )

    user = User(email=email, password_hash=hash_password(payload.password))
    db.add(user)
    db.commit()
    db.refresh(user)
    return _issue_pair(user)


@router.post("/login", response_model=TokenPair)
def login(payload: LoginRequest, db: Session = Depends(get_db)) -> TokenPair:
    """Exchange email + password for an access/refresh token pair."""
    email = payload.email.lower()
    user = db.query(User).filter(User.email == email).one_or_none()
    if user is None or not verify_password(payload.password, user.password_hash):
        raise _credentials_exception("invalid email or password")
    return _issue_pair(user)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
def logout(_current_user: User = Depends(get_current_user)) -> Response:
    """Stateless logout for MVP — client discards tokens, server confirms."""
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/refresh", response_model=AccessToken)
def refresh(payload: RefreshRequest, db: Session = Depends(get_db)) -> AccessToken:
    """Trade a valid refresh token for a new access token (and refresh token)."""
    try:
        user_id = decode_token(payload.refresh_token, expected_type="refresh")
    except TokenError as exc:
        raise _credentials_exception(str(exc)) from exc

    user = db.get(User, user_id)
    if user is None:
        raise _credentials_exception("user no longer exists")
    return AccessToken(
        access_token=create_access_token(user.id),
        expires_in=get_settings().jwt_access_token_expire_minutes * 60,
    )


@router.get("/me", response_model=UserPublic)
def me(current_user: User = Depends(get_current_user)) -> UserPublic:
    """Return the authenticated user's own profile."""
    return UserPublic.model_validate(current_user)
