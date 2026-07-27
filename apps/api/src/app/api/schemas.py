"""Pydantic schemas shared across the v1 API.

Kept in one place for now — once endpoints proliferate we'll split per-domain.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field, model_validator

from app.db.models.account import Account
from app.db.models.enums import AccountType, CategoryKind


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class RefreshRequest(BaseModel):
    refresh_token: str


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int


class AccessToken(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int


class UserPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: EmailStr
    created_at: datetime
    updated_at: datetime


class CategoryPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    kind: CategoryKind
    parent_id: uuid.UUID | None = None
    color: str | None = None
    archived: bool = False


class UserPreferencePublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    locale: str
    currency: str
    emergency_fund_multiplier: int
    dependents_count: int
    theme: str
    updated_at: datetime


# --- Accounts (epic-0002) -----------------------------------------------------

# TL decision G4: MVP is single-currency (IDR) — reject anything else with 422
# rather than silently overriding. The strict check lives on the request schema
# so the OpenAPI surface advertises the constraint and 422 is raised by
# Pydantic before the route runs.


class AccountCreate(BaseModel):
    """Input for ``POST /accounts``.

    TL decision (epic-0002): ``opening_balance_cents`` may be negative only when
    ``type == credit_card`` (outstanding debt). Asset types must remain >= 0.
    The cross-field check lives on the request schema so 422 is raised by
    Pydantic before the route runs and the OpenAPI surface advertises the
    constraint.
    """

    name: str = Field(min_length=1, max_length=120)
    type: AccountType
    currency: str = Field(min_length=3, max_length=3)
    opening_balance_cents: int = Field(default=0)

    @model_validator(mode="after")
    def _check_currency(self) -> AccountCreate:
        if self.currency != "IDR":
            raise ValueError(
                f"currency must be 'IDR' (MVP is single-currency); got {self.currency!r}"
            )
        return self

    @model_validator(mode="after")
    def _check_opening_balance(self) -> AccountCreate:
        if self.opening_balance_cents < 0 and self.type != AccountType.CREDIT_CARD:
            raise ValueError(
                "opening_balance_cents may be negative only when type is 'credit_card' "
                f"(got type={self.type.value!r}, opening_balance_cents="
                f"{self.opening_balance_cents})"
            )
        return self


class AccountUpdate(BaseModel):
    """Input for ``PATCH /accounts/{id}`` — every field is optional.

    TL decision (epic-0002): ``opening_balance_cents`` may be negative only when
    the effective ``type`` is ``credit_card``. The schema can only see fields
    present in the request body, so when *both* ``type`` and
    ``opening_balance_cents`` are sent in the same PATCH we validate the
    cross-field rule here (clean 422 with Pydantic detail). The case where
    only one of them is sent (and the other comes from the persisted row) is
    enforced inside the route — see ``update_account`` in
    ``app/api/v1/accounts.py``.
    """

    name: str | None = Field(default=None, min_length=1, max_length=120)
    type: AccountType | None = None
    currency: str | None = Field(default=None, min_length=3, max_length=3)
    opening_balance_cents: int | None = None
    archived: bool | None = None

    @model_validator(mode="after")
    def _check_currency(self) -> AccountUpdate:
        if self.currency is not None and self.currency != "IDR":
            raise ValueError(
                f"currency must be 'IDR' (MVP is single-currency); got {self.currency!r}"
            )
        return self

    @model_validator(mode="after")
    def _check_opening_balance_when_type_provided(self) -> AccountUpdate:
        if (
            self.type is not None
            and self.opening_balance_cents is not None
            and self.opening_balance_cents < 0
            and self.type != AccountType.CREDIT_CARD
        ):
            raise ValueError(
                "opening_balance_cents may be negative only when type is 'credit_card' "
                f"(got type={self.type.value!r}, opening_balance_cents="
                f"{self.opening_balance_cents})"
            )
        return self


class AccountPublic(BaseModel):
    """Output shape for an account.

    ``is_asset`` is a TL-decision G1 derivative: ``type`` is the single source
    of truth (``cash``/``bank``/``e_wallet``/``investment``/``other`` are
    assets; ``credit_card`` is a liability), and ``is_asset`` is computed
    here so the FE doesn't have to re-derive it on every page. The DB column
    exists for reporting but is never written by the API.
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    user_id: uuid.UUID
    name: str
    type: AccountType
    currency: str
    opening_balance_cents: int
    archived: bool
    is_asset: bool
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_account(cls, account: Account) -> AccountPublic:
        """Build the public view, deriving ``is_asset`` from ``type`` (G1)."""
        return cls.model_validate(
            {
                "id": account.id,
                "user_id": account.user_id,
                "name": account.name,
                "type": account.type,
                "currency": account.currency,
                "opening_balance_cents": account.opening_balance_cents,
                "archived": account.archived,
                "is_asset": account.type != AccountType.CREDIT_CARD,
                "created_at": account.created_at,
                "updated_at": account.updated_at,
            }
        )


class AccountBalancePublic(BaseModel):
    account_id: uuid.UUID
    balance_cents: int
    as_of: datetime


class AccountBalancesPublic(BaseModel):
    accounts: list[AccountBalancePublic]
    total_assets_cents: int
    total_liabilities_cents: int
    networth_cents: int
