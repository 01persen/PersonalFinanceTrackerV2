"""Security helpers — password hashing + JWT encode/decode.

Used by the auth API endpoints. The token format matches what we expect the
frontend (Next.js + Supabase JS) to consume — a short-lived access token plus
a longer-lived refresh token, both signed with ``JWT_SECRET``.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Literal

import bcrypt
from jose import JWTError, jwt

from app.core.config import get_settings

TokenType = Literal["access", "refresh"]

_BCRYPT_MAX_BYTES = 72


def hash_password(plain: str) -> str:
    """Hash a plain-text password with bcrypt.

    bcrypt has a 72-byte input limit — anything longer is silently equivalent
    to its first 72 bytes, so we truncate defensively to avoid surprises for
    users who pick very long passwords.
    """
    pw = plain.encode("utf-8")[:_BCRYPT_MAX_BYTES]
    return bcrypt.hashpw(pw, bcrypt.gensalt()).decode("ascii")


def verify_password(plain: str, hashed: str) -> bool:
    """Check a plain-text password against the stored bcrypt hash."""
    pw = plain.encode("utf-8")[:_BCRYPT_MAX_BYTES]
    try:
        return bcrypt.checkpw(pw, hashed.encode("ascii"))
    except (ValueError, TypeError):
        return False


def _encode_token(
    *,
    subject: uuid.UUID | str,
    token_type: TokenType,
    expires_delta: timedelta,
) -> str:
    settings = get_settings()
    now = datetime.now(UTC)
    payload: dict[str, object] = {
        "sub": str(subject),
        "type": token_type,
        "iat": int(now.timestamp()),
        "exp": int((now + expires_delta).timestamp()),
    }
    return str(jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm))


def create_access_token(user_id: uuid.UUID | str) -> str:
    settings = get_settings()
    return _encode_token(
        subject=user_id,
        token_type="access",
        expires_delta=timedelta(minutes=settings.jwt_access_token_expire_minutes),
    )


def create_refresh_token(user_id: uuid.UUID | str) -> str:
    settings = get_settings()
    return _encode_token(
        subject=user_id,
        token_type="refresh",
        expires_delta=timedelta(days=settings.jwt_refresh_token_expire_days),
    )


class TokenError(Exception):
    """Raised when a JWT cannot be decoded or has an unexpected type."""


def decode_token(token: str, *, expected_type: TokenType) -> uuid.UUID:
    """Decode a JWT and return the user id (UUID) when valid for ``expected_type``."""
    settings = get_settings()
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except JWTError as exc:
        raise TokenError("invalid token") from exc

    token_type = payload.get("type")
    if token_type != expected_type:
        raise TokenError(f"expected {expected_type!r} token, got {token_type!r}")

    sub = payload.get("sub")
    if not sub:
        raise TokenError("token missing subject")
    try:
        return uuid.UUID(str(sub))
    except (ValueError, TypeError) as exc:
        raise TokenError("subject is not a valid uuid") from exc
