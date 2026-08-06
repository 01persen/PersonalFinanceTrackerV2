"""Pydantic schemas shared across the v1 API.

Kept in one place for now — once endpoints proliferate we'll split per-domain.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, model_validator

from app.db.models.account import Account
from app.db.models.enums import (
    AccountType,
    CategoryKind,
    DebtKind,
    DebtStatus,
    GoalKind,
    TransactionType,
)

if TYPE_CHECKING:
    from app.db.models.user_preference import UserPreference


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
    """Output shape for a single category row.

    Mirrors the columns on :class:`app.db.models.category.Category`. ``archived``
    is the derived boolean (kept in sync with ``archived_at IS NOT NULL`` by
    the API layer); ``archived_at`` is the authoritative tombstone timestamp
    surfaced so the FE can badge a row (the default list endpoint still hides
    it via ``archived_at IS NULL``).

    ``parent_id`` is exposed so the FE can build a tree from the flat wire
    format — exactly the same convention used by the read-side list endpoint
    since sub-0001-08.
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    kind: CategoryKind
    parent_id: uuid.UUID | None = None
    color: str | None = None
    icon: str | None = None
    archived: bool = False
    archived_at: datetime | None = None


class CategoryCreate(BaseModel):
    """Body for ``POST /categories``.

    Required: ``name`` + ``kind``. ``parent_id`` is optional (NULL = root).

    Validation rules (per sub-0004-01 AC):

    * ``name`` is 1-120 chars (Pydantic → 422 for empty / oversized).
    * ``kind`` must be a valid :class:`CategoryKind` value (Pydantic StrEnum
      → 422 for unknown).
    * ``parent_id`` (when set) must belong to the caller — enforced in the
      route against the persisted row (404, not 403, to avoid leaking the
      existence of other users' categories — same pattern as accounts /
      transactions).
    * ``parent_id`` must not form a cycle with the new row (cycle prevention,
      AC (2)). Enforced in the route before any DB write.
    * ``color`` / ``icon`` are optional short strings. No semantic validation
      beyond max length.
    """

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=120)
    kind: CategoryKind
    parent_id: uuid.UUID | None = None
    color: str | None = Field(default=None, max_length=16)
    icon: str | None = Field(default=None, max_length=64)


class CategoryUpdate(BaseModel):
    """Body for ``PATCH /categories/{id}`` — every field is optional.

    Editable fields mirror the user-editable portion of the create schema.
    ``kind`` is intentionally editable here (AC (3) — the FE may rebucket a
    subtree from expense → income during a personal-finance reorg), but the
    route enforces that the ``parent_id`` belongs to the caller and that
    flipping ``kind`` does not create a cycle with the existing tree.

    ``extra="forbid"`` so a client attempting to edit server-controlled
    fields (``id``, ``user_id``, ``archived``, ``archived_at``, timestamps)
    gets a 422 with a clear Pydantic error before the route runs — exactly
    the same surface as the transactions PATCH schema.
    """

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=120)
    kind: CategoryKind | None = None
    parent_id: uuid.UUID | None = None
    color: str | None = Field(default=None, max_length=16)
    icon: str | None = Field(default=None, max_length=64)


class CategoryArchiveRequest(BaseModel):
    """Body for ``POST /categories/{id}/archive`` — ``reason`` is optional.

    The route always sets ``archived_at = server-now`` (no client-supplied
    timestamp). ``reason`` is reserved for an audit trail row that lands in
    a follow-up sub-task (per the epic-level audit-trail decision); for now
    it is accepted and discarded to keep the contract stable.
    """

    model_config = ConfigDict(extra="forbid")

    reason: str | None = Field(default=None, max_length=500)


class CategoryListPublic(BaseModel):
    """Response envelope for ``GET /categories`` (paginated).

    ``total`` is the *unfiltered-by-page* count of the caller's active
    categories (``archived_at IS NULL``) so the FE can render pagination
    controls without a follow-up count call. ``limit`` + ``offset`` are
    echoed back so the FE can paginate without re-deriving them. The
    default page size is 100 (AC (6)).
    """

    items: list[CategoryPublic]
    total: int
    limit: int
    offset: int


class UserPreferencePublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    locale: str
    currency: str
    emergency_fund_multiplier: int
    dependents_count: int
    theme: str
    updated_at: datetime


class UserSettingsPublic(BaseModel):
    """Response shape for ``GET /users/me/settings`` and ``PATCH /users/me/settings``.

    Alias of :class:`UserPreferencePublic` exposed under the
    ``/users/me/settings`` route per the sub-0005-02 kickoff. The
    underlying table is the same ``user_preferences`` row written by
    the epic-0001 seed -- the new router is a thin alias path so the
    existing ``GET /preferences`` endpoint and the new
    ``/users/me/settings`` path return the same body without two
    divergent schemas.
    """

    model_config = ConfigDict(from_attributes=True)

    locale: str
    currency: str
    ef_multiplier: int
    dependents_count: int
    theme: str
    updated_at: datetime

    @classmethod
    def from_preference(cls, pref: UserPreference) -> UserSettingsPublic:
        """Build the public view from a :class:`UserPreference` row.

        Renames ``emergency_fund_multiplier`` -> ``ef_multiplier`` to
        match the request body contract -- the FE-facing field name is
        shorter and was the one pinned in the sub-0005-02 spec.

        ``UserPreference`` is imported here in a ``TYPE_CHECKING`` block
        (the model lives in :mod:`app.db.models.user_preference`) so
        pydantic + mypy can see the column types without a circular
        import. At runtime the body duck-types; mypy reads the type.
        """
        return cls.model_validate(
            {
                "locale": pref.locale,
                "currency": pref.currency,
                "ef_multiplier": pref.emergency_fund_multiplier,
                "dependents_count": pref.dependents_count,
                "theme": pref.theme,
                "updated_at": pref.updated_at,
            }
        )


# --- Settings (epic-0008, sub-0008-03) ----------------------------------------

# TL decision (epic-0008, sub-0008-03): the ``/settings`` endpoint is
# the *primary* settings surface going forward — ``/preferences`` and
# ``/users/me/settings`` remain as legacy aliases (sub-0001-08,
# sub-0005-02) but new clients should call ``/settings``. The response
# bundles profile + preferences so the FE doesn't have to issue a
# second ``GET /auth/me`` round-trip to render the page.


# PRD §14 default seed for the settings row's ``week_start`` column.
# The Pydantic enum-literal below enforces the exact whitelist at the
# API surface; the DB column stays a free string for forward-compat
# (PRD §3 explicitly carves out future locale-specific week-start
# values).
WEEK_START_VALUES = ("senin", "selasa", "rabu", "kamis", "jumat", "sabtu", "minggu")
DEFAULT_WEEK_START = "senin"


class SettingsPublic(BaseModel):
    """Response shape for ``GET /settings`` and ``PATCH /settings``.

    Bundles profile (``email``, ``display_name``) + preferences
    (``currency``, ``locale``, ``week_start``, ``ef_multiplier``,
    plus the legacy ``dependents_count`` / ``theme`` kept for
    back-compat). ``version`` is the optimistic-concurrency token
    echoed in the response body *and* the ``ETag`` response header
    (sub-0008-03 AC (c)). Clients must round-trip the value in the
    ``If-Match`` request header on PATCH — a stale value triggers
    ``412 Precondition Failed`` (sub-0008-03 AC (e)).

    The shape is built by :meth:`from_user_and_preference` from a
    caller-loaded pair so the router doesn't have to do the
    cross-table join inline. ``email`` comes from the ``User`` row
    so the FE settings page can render it without a second
    ``GET /auth/me`` round-trip.
    """

    model_config = ConfigDict(from_attributes=True)

    email: EmailStr
    display_name: str | None = None
    currency: str
    locale: str
    week_start: str
    ef_multiplier: int
    dependents_count: int
    theme: str
    version: int
    updated_at: datetime

    @classmethod
    def from_user_and_preference(
        cls,
        user: object,
        pref: UserPreference,
    ) -> SettingsPublic:
        """Build the public view from a ``(User, UserPreference)`` pair.

        Renames ``emergency_fund_multiplier`` -> ``ef_multiplier``
        to match the FE-facing wire name pinned in the sub-0005-02
        spec; ``UserPreference`` is a ``TYPE_CHECKING`` import so mypy
        reads it but the module avoids a circular import at runtime.
        """
        return cls.model_validate(
            {
                "email": getattr(user, "email", None),
                "display_name": pref.display_name,
                "currency": pref.currency,
                "locale": pref.locale,
                "week_start": pref.week_start,
                "ef_multiplier": pref.emergency_fund_multiplier,
                "dependents_count": pref.dependents_count,
                "theme": pref.theme,
                "version": pref.version,
                "updated_at": pref.updated_at,
            }
        )


class SettingsUpdate(BaseModel):
    """Body for ``PATCH /settings``.

    Every field is optional — only the fields present in the request
    body are touched. ``extra="forbid"`` rejects unknown / server-
    controlled fields with 422 before the route runs.

    Validation matrix (PRD §3 + §14, sub-0008-03 AC (b)):

    * ``currency`` must equal ``"IDR"`` — model validator → 422. MVP
      is single-currency so any other code is hard-rejected (the FE
      has no UI for currency switching yet).
    * ``locale`` must equal ``"id-ID"`` — model validator → 422.
      Free locales are kept as a forward-compat pattern in the
      legacy ``/preferences`` schema but locked down on the
      primary ``/settings`` surface.
    * ``week_start`` must be one of :data:`WEEK_START_VALUES`
      — Pydantic ``Literal`` → 422.
    * ``ef_multiplier`` must be ``>= 1`` — Pydantic ``Field(ge=1)``
      → 422.
    * ``display_name`` may be ``None`` (clears the profile nickname)
      or a string with length ``<= 100`` — Pydantic
      ``max_length=100``.
    """

    model_config = ConfigDict(extra="forbid")

    currency: Literal["IDR"] | None = Field(
        default=None,
        description="MVP is single-currency; only 'IDR' is accepted.",
    )
    locale: Literal["id-ID"] | None = Field(
        default=None,
        description="Locked to 'id-ID' for the MVP.",
    )
    week_start: Literal["senin", "selasa", "rabu", "kamis", "jumat", "sabtu", "minggu"] | None = (
        Field(default=None)
    )
    ef_multiplier: int | None = Field(default=None, ge=1)
    display_name: str | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def _check_currency_when_set(self) -> SettingsUpdate:
        if self.currency is not None and self.currency != "IDR":
            raise ValueError(
                f"currency must be 'IDR' (MVP is single-currency); got {self.currency!r}"
            )
        return self

    @model_validator(mode="after")
    def _check_locale_when_set(self) -> SettingsUpdate:
        if self.locale is not None and self.locale != "id-ID":
            raise ValueError(
                f"locale must be 'id-ID' (MVP is Indonesian-only); got {self.locale!r}"
            )
        return self


class UserSettingsUpdate(BaseModel):
    """Body for ``PATCH /users/me/settings``.

    Every field is optional — only the fields present in the request
    are touched. ``ef_multiplier`` must be ``>= 1`` per PRD §14
    (the multiplier that's actually used to size the EF — values
    below 1 would make the EF smaller than a single month of
    expenses, which contradicts the goal's intent). Other fields
    reuse the locale / currency / theme validation already done in
    the FE for the MVP; we enforce a max length here so a client
    can't blow up the preferences row with a runaway payload.

    ``extra="forbid"`` so a client attempting to PATCH the immutable
    ``id`` / ``user_id`` columns gets a 422 before the route runs.
    """

    model_config = ConfigDict(extra="forbid")

    ef_multiplier: int | None = Field(default=None, ge=1)
    locale: str | None = Field(default=None, min_length=2, max_length=10)
    currency: str | None = Field(default=None, min_length=3, max_length=3)
    dependents_count: int | None = Field(default=None, ge=0)
    theme: str | None = Field(default=None, max_length=32)


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


# --- Transactions (epic-0003, sub-0003-01) ------------------------------------

# TL decision (epic-0003, sub-0003-01): the MVP is single-currency (IDR), so
# we hard-code the request schema and reject anything else with 422 (mirrors
# the AccountCreate pattern from epic-0002). Amount is stored as ``cents`` to
# avoid floating-point drift — exactly the same convention used by accounts
# and the saldo engine.


class TransactionCreate(BaseModel):
    """Body for ``POST /transactions``.

    ``type`` is restricted to ``"income"`` / ``"expense"`` here — the paired
    ``transfer`` flow ships in sub-0003-03 (a separate endpoint), so a client
    sending ``type='transfer'`` to this endpoint is rejected with 422 *before*
    any DB write.

    Validation rules (per acceptance criteria (b)):

    * ``amount_cents`` must be ``> 0`` (Pydantic ``gt=0`` → 422).
    * ``currency`` must be ``"IDR"`` (model validator → 422).
    * ``account_id`` must belong to the caller — enforced in the route
      against the persisted ``accounts`` row (404, not 403, to avoid leaking
      the existence of other users' accounts — same pattern as the accounts
      router).
    * ``category_id`` (optional) must belong to the caller AND match the
      :class:`CategoryKind` for ``type`` (e.g. ``expense`` → expense category).
      Enforced in the route; surfaced as 404 for ownership and 422 for
      category/type mismatch.
    """

    type: Literal["income", "expense"] = Field(
        description="Transaction type. ``transfer`` is handled by a separate endpoint (sub-0003-03)."
    )
    account_id: uuid.UUID
    category_id: uuid.UUID | None = None
    amount_cents: int = Field(
        gt=0,
        description="Transaction amount in cents (positive integer). Zero or negative values are rejected.",
    )
    currency: str = Field(min_length=3, max_length=3, default="IDR")
    occurred_on: date
    note: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def _check_currency(self) -> TransactionCreate:
        if self.currency != "IDR":
            raise ValueError(
                f"currency must be 'IDR' (MVP is single-currency); got {self.currency!r}"
            )
        return self


class TransactionUpdate(BaseModel):
    """Body for ``PATCH /transactions/{id}`` — every field is optional.

    Editable fields mirror the user-editable portion of the create schema
    (AC: only own-user; field invalid ditolak). ``type`` is intentionally
    rejected here — the paired ``transfer`` flow ships in sub-0003-03 and a
    transaction's semantic type is immutable after creation (cash-flow
    books stay consistent). ``user_id`` / ``account_id`` / ``transfer_pair_id``
    are server-controlled and never editable through this endpoint.

    ``extra="forbid"`` so a client attempting to edit ``type`` (or any
    other immutable field) gets a 422 with a clear Pydantic error before
    the route runs — exactly the same surface as the create schema.

    Validation rules (per AC (a)):

    * ``amount_cents`` must be ``> 0`` when provided (Pydantic ``gt=0`` → 422).
    * ``currency`` must be ``"IDR"`` when provided (model validator → 422).
    * ``account_id`` belongs to the caller — enforced in the route (404).
    * ``category_id`` (optional) belongs to the caller AND matches the
      persisted transaction's ``type`` — enforced in the route (404 for
      ownership, 422 for kind mismatch).
    """

    model_config = ConfigDict(extra="forbid")

    account_id: uuid.UUID | None = None
    category_id: uuid.UUID | None = None
    amount_cents: int | None = Field(
        default=None,
        gt=0,
        description="Transaction amount in cents (positive integer). Zero or negative values are rejected.",
    )
    currency: str | None = Field(default=None, min_length=3, max_length=3)
    occurred_on: date | None = None
    note: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def _check_currency(self) -> TransactionUpdate:
        if self.currency is not None and self.currency != "IDR":
            raise ValueError(
                f"currency must be 'IDR' (MVP is single-currency); got {self.currency!r}"
            )
        return self


class TransactionPublic(BaseModel):
    """Output shape for a single transaction row (read by ``GET /transactions``
    and returned by ``POST /transactions`` / ``PATCH /transactions/{id}``).

    Mirrors the columns on :class:`app.db.models.transaction.Transaction`
    directly via ``from_attributes=True``. ``type`` is rendered as the
    :class:`TransactionType` StrEnum so FE consumers get the same string the
    DB stores (``"income"``/``"expense"``/``"transfer"``), not a Python enum
    repr.

    ``deleted_at`` is exposed so the FE can badge a deleted row (the
    default list endpoint still hides it via ``deleted_at IS NULL``).

    ``transfer_pair_id`` and ``transfer_group_id`` are both populated for
    the two legs of a paired transfer (sub-0003-03) and ``None`` for any
    non-transfer row. The pair id is the exact link between the source
    and destination leg; the group id mirrors the pair id for the
    2-row MVP and is reserved for future grouped transfers.
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    user_id: uuid.UUID
    account_id: uuid.UUID
    category_id: uuid.UUID | None = None
    type: TransactionType
    amount_cents: int
    currency: str
    occurred_on: date
    note: str | None = None
    transfer_pair_id: uuid.UUID | None = None
    transfer_group_id: uuid.UUID | None = None
    deleted_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class TransferCreate(BaseModel):
    """Body for ``POST /transactions/transfer``.

    Creates two transactions (``expense`` on the source account,
    ``income`` on the destination account) linked by the same
    ``transfer_pair_id`` and ``transfer_group_id`` in a single DB
    transaction. The saldo engine handles the sign convention natively
    (``expense`` → ``-amount_cents``, ``income`` → ``+amount_cents``),
    so the persisted rows do not need to encode signed amounts.

    Validation rules (per acceptance criteria):

    * ``amount_cents > 0`` — Pydantic ``gt=0`` → 422.
    * ``currency == "IDR"`` — model validator → 422.
    * ``source_account_id != destination_account_id`` — cross-field
      validator → 422 (no self-transfer).
    * ``occurred_on`` is a valid date — implicit via the ``date`` type.
    * Both accounts must belong to the caller — 404 (not 403) when a
      row is missing or owned by another user.
    * Both accounts must be non-archived — 404.
    """

    source_account_id: uuid.UUID
    destination_account_id: uuid.UUID
    amount_cents: int = Field(
        gt=0,
        description="Transfer amount in cents (positive integer). Zero or negative values are rejected.",
    )
    currency: str = Field(min_length=3, max_length=3, default="IDR")
    occurred_on: date
    note: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def _check_currency(self) -> TransferCreate:
        if self.currency != "IDR":
            raise ValueError(
                f"currency must be 'IDR' (MVP is single-currency); got {self.currency!r}"
            )
        return self

    @model_validator(mode="after")
    def _check_distinct_accounts(self) -> TransferCreate:
        if self.source_account_id == self.destination_account_id:
            raise ValueError(
                "source_account_id and destination_account_id must be different "
                "(self-transfer is not allowed)"
            )
        return self


class TransferPublic(BaseModel):
    """Response shape for ``POST /transactions/transfer``.

    Returns *both* legs of the pair so the FE can render the new
    destination balance and the row grouping without a follow-up
    ``GET /transactions`` call. The two rows are linked by the same
    ``transfer_pair_id`` / ``transfer_group_id`` and the destination
    amount is the same ``amount_cents`` as the source — the FE uses
    the pair id to deduplicate the two rows when grouping.
    """

    source: TransactionPublic
    destination: TransactionPublic
    transfer_pair_id: uuid.UUID
    transfer_group_id: uuid.UUID


class TransactionListPublic(BaseModel):
    """Response envelope for ``GET /transactions`` (paginated).

    The list is sorted with the most recent ``occurred_on`` first
    (descending) — the FE "Pendapatan & Pengeluaran Bulanan" view expects
    that order — followed by a deterministic tie-breaker chain on
    ``amount_cents`` desc and ``id`` asc. We deliberately avoid
    ``created_at`` because its second-level precision on SQLite ties
    frequently, leaving the row order up to a random UUID tie-break
    (carried over as flaky from PR #22, fixed in sub-0004-00). ``total`` is
    the *unfiltered* row count for the caller's filter set; ``limit`` +
    ``offset`` are echoed back so the FE can paginate without re-deriving
    them.
    """

    items: list[TransactionPublic]
    total: int
    limit: int
    offset: int


class TransactionSearchListPublic(BaseModel):
    """Response envelope for ``GET /transactions/search`` (sub-0004-03).

    Mirrors :class:`TransactionListPublic` semantically (same item shape,
    same deterministic sort chain ``occurred_on DESC, amount_cents DESC,
    id ASC``) but exposes ``page`` + ``page_size`` instead of
    ``limit`` + ``offset`` because the FE search panel paginates by
    "page N of M" rather than by offset (acceptance criterion (1)).

    ``page`` is 1-indexed (page 1 is the first page) and ``page_size`` is
    clamped to ``[1, 200]`` by the route — see the ``Query`` defaults on
    the search endpoint. ``total`` is the *unfiltered-by-page* row count
    for the caller's filter set so the FE can render the page navigator
    without a follow-up count call.
    """

    items: list[TransactionPublic]
    total: int
    page: int
    page_size: int


# --- Transactions summary (epic-0003, sub-0003-04) ----------------------------


class SummaryCategoryBreakdownPublic(BaseModel):
    """One row of the per-category breakdown.

    ``category_id`` is ``None`` for transactions saved without a category
    (the FE renders these as "Uncategorized" in the breakdown UI). The
    pair ``(type, category_id)`` is what uniquely identifies a row in the
    response: income vs expense are reported separately so the FE can
    render them on different sides of the monthly view.
    """

    category_id: uuid.UUID | None = None
    category_name: str | None = None
    type: TransactionType
    total_cents: int
    transaction_count: int


class SummaryAccountBreakdownPublic(BaseModel):
    """One row of the per-account breakdown.

    The pair ``(type, account_id)`` is the unique key: an account that
    received income *and* paid expenses in the same month surfaces as two
    rows so the FE can show net movement per account without re-aggregating
    client-side. ``account_name`` is the snapshot value at response time
    so a renamed account doesn't break historical reporting.
    """

    account_id: uuid.UUID
    account_name: str
    type: TransactionType
    total_cents: int
    transaction_count: int


class TransactionSummaryPublic(BaseModel):
    """Response shape for ``GET /transactions/summary``.

    All amounts are ``int`` cents (same convention as the rest of the API).
    ``total_income`` + ``total_expense`` + ``net`` reflect the *active*
    transactions only (``deleted_at IS NULL``); soft-deleted rows never
    inflate monthly totals. Empty months are surfaced as zeros + empty
    arrays — never 404 (acceptance criterion (c)).
    """

    year: int
    month: int
    currency: str
    total_income_cents: int
    total_expense_cents: int
    net_cents: int
    transaction_count: int
    breakdown_by_category: list[SummaryCategoryBreakdownPublic]
    breakdown_by_account: list[SummaryAccountBreakdownPublic]


# --- Goals (epic-0005, sub-0005-01) -------------------------------------------

# TL decision (epic-0005, sub-0005-01): one ``goals`` table discriminated by
# the ``kind`` column (``saving`` | ``emergency_fund``) — kind-specific
# columns are nullable so a single backing table can hold both flavours
# without a JOIN-style subclass split. The route enforces which fields
# are writeable on each kind via Pydantic ``model_validator`` rules (the
# DB layer can't express "either A or B, but not both in the same row"
# without a CHECK constraint that breaks for back-compat rows, and we
# want the validation to surface as 422 with a clear Pydantic error).


class GoalCreate(BaseModel):
    """Body for ``POST /goals``.

    Required: ``kind``, ``name``, ``target_amount_cents``.

    Validation rules (per sub-0005-01 AC):

    * ``kind`` must be ``saving`` or ``emergency_fund`` (Pydantic ``Enum``
      → 422).
    * ``name`` is 1-120 chars (Pydantic → 422).
    * ``target_amount_cents > 0`` (Pydantic ``gt=0`` → 422).
    * ``linked_account_id`` (when set) must belong to the caller —
      enforced in the route (404). Archived accounts return 404 so a
      stale id from the client never resurrects a goal on a closed
      account.
    * **Saving-only fields**: ``jangka_waktu_months > 0`` when set, and
      ``target_date >= start_date`` when both are provided. ``tabungan_bulanan_cents``
      is currently a manual input — the auto-calc rule ships in
      sub-0005-02, which will overwrite whatever the caller sent here.
    * **EF-only fields**: ``monthly_expense_cents > 0`` when set,
      ``jumlah_tanggungan >= 0`` when set, ``multiplier >= 1``
      (default 3 when null). The auto-calc fields
      (``lama_mengumpulkan_bulan``, ``target_amount_snapshot_cents``)
      are intentionally NOT settable on create — they're the service
      layer's output, not user input.

    ``extra="forbid"`` rejects unknown fields with 422 before the route
    runs (mirrors categories / transactions PATCH schemas).
    """

    model_config = ConfigDict(extra="forbid")

    kind: GoalKind
    name: str = Field(min_length=1, max_length=120)
    target_amount_cents: int = Field(gt=0)
    current_amount_cents: int | None = Field(default=None, ge=0)
    linked_account_id: uuid.UUID | None = None
    start_date: date | None = None
    target_date: date | None = None
    jangka_waktu_months: int | None = Field(default=None, gt=0)
    tabungan_bulanan_cents: int | None = Field(default=None, ge=0)
    monthly_expense_cents: int | None = Field(default=None, gt=0)
    jumlah_tanggungan: int | None = Field(default=None, ge=0)
    multiplier: int | None = Field(default=None, ge=1)
    lama_mengumpulkan_bulan: int | None = None
    target_amount_snapshot_cents: int | None = Field(default=None, ge=0)
    notes: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def _validate_kind_specific(self) -> GoalCreate:
        # Saving-only — reject EF-only fields if they leak in on a saving
        # goal; the auto-calc EF fields are write-once at the service
        # layer (sub-0005-02) so we also reject them here as "not user
        # input on create".
        if self.kind == GoalKind.SAVING:
            if (
                self.monthly_expense_cents is not None
                or self.jumlah_tanggungan is not None
                or self.multiplier is not None
            ):
                raise ValueError(
                    "monthly_expense_cents, jumlah_tanggungan, and multiplier are "
                    "emergency_fund-only fields and must be omitted when kind='saving'"
                )
            if (
                self.lama_mengumpulkan_bulan is not None
                or self.target_amount_snapshot_cents is not None
            ):
                raise ValueError(
                    "lama_mengumpulkan_bulan and target_amount_snapshot_cents are "
                    "auto-calc fields owned by the goal-engine and must be omitted on create"
                )
            if (
                self.target_date is not None
                and self.start_date is not None
                and self.target_date < self.start_date
            ):
                raise ValueError(
                    f"target_date ({self.target_date.isoformat()}) must be >= "
                    f"start_date ({self.start_date.isoformat()})"
                )
        # Emergency Fund-only — reject saving-only fields.
        if self.kind == GoalKind.EMERGENCY_FUND:
            saving_only_provided = [
                name
                for name, value in (
                    ("target_date", self.target_date),
                    ("jangka_waktu_months", self.jangka_waktu_months),
                    ("tabungan_bulanan_cents", self.tabungan_bulanan_cents),
                )
                if value is not None
            ]
            if saving_only_provided:
                raise ValueError(
                    f"{', '.join(saving_only_provided)} are saving-only fields and must be "
                    "omitted when kind='emergency_fund'"
                )
            if (
                self.lama_mengumpulkan_bulan is not None
                or self.target_amount_snapshot_cents is not None
            ):
                raise ValueError(
                    "lama_mengumpulkan_bulan and target_amount_snapshot_cents are "
                    "auto-calc fields owned by the goal-engine and must be omitted on create"
                )
        return self


class GoalUpdate(BaseModel):
    """Body for ``PATCH /goals/{id}`` — every field is optional.

    ``kind`` is intentionally immutable through this endpoint: changing
    the kind after creation would require different auto-calc rules and
    a different validation surface, and the FE never needs to. Pydantic
    rejects it with 422 (the field is not on the schema at all).

    ``linked_account_id`` can be cleared by sending ``null``.
    ``start_date`` cannot be cleared — once a goal exists the horizon
    is anchored. ``extra="forbid"`` rejects unknown / server-controlled
    fields.

    The kind-specific rules from :class:`GoalCreate` re-run here against
    the **merged** effective values (request payload union persisted row)
    inside the route, so a PATCH that turns a saving goal's horizon
    inconsistent with its ``target_date`` is rejected the same way as
    on create.
    """

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=120)
    target_amount_cents: int | None = Field(default=None, gt=0)
    current_amount_cents: int | None = Field(default=None, ge=0)
    linked_account_id: uuid.UUID | None = None
    start_date: date | None = None
    target_date: date | None = None
    jangka_waktu_months: int | None = Field(default=None, gt=0)
    tabungan_bulanan_cents: int | None = Field(default=None, ge=0)
    monthly_expense_cents: int | None = Field(default=None, gt=0)
    jumlah_tanggungan: int | None = Field(default=None, ge=0)
    multiplier: int | None = Field(default=None, ge=1)
    notes: str | None = Field(default=None, max_length=2000)


class GoalPublic(BaseModel):
    """Output shape for a single goal row.

    Mirrors the columns on :class:`app.db.models.goal.Goal` directly via
    ``from_attributes=True``. ``archived`` is the derived boolean (kept
    in sync with ``archived_at IS NOT NULL`` by the API layer);
    ``archived_at`` is the authoritative tombstone timestamp surfaced
    so the FE can badge an archived goal (the default list endpoint
    still hides it via ``archived_at IS NULL``).

    ``achieved_at`` is the *first* time the goal crossed 100% (added
    in sub-0005-02, migration ``c5a7b9c1d3e4``). Persisted by the
    recompute hook so the FE can badge achieved goals on a cache
    miss without the progress endpoint having to write to the DB.
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    user_id: uuid.UUID
    kind: GoalKind
    name: str
    target_amount_cents: int
    current_amount_cents: int | None
    linked_account_id: uuid.UUID | None
    start_date: date
    target_date: date | None
    jangka_waktu_months: int | None
    tabungan_bulanan_cents: int | None
    monthly_expense_cents: int | None
    jumlah_tanggungan: int | None
    multiplier: int | None
    lama_mengumpulkan_bulan: int | None
    target_amount_snapshot_cents: int | None
    notes: str | None
    archived: bool
    archived_at: datetime | None
    achieved_at: datetime | None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_goal(cls, goal: object) -> GoalPublic:
        """Build the public view, deriving ``archived`` from ``archived_at``."""
        archived_at = getattr(goal, "archived_at", None)
        return cls.model_validate(
            {
                **{k: v for k, v in goal.__dict__.items() if not k.startswith("_")},
                "archived": archived_at is not None,
            }
        )


class GoalListPublic(BaseModel):
    """Response envelope for ``GET /goals`` (paginated).

    ``total`` is the *unfiltered-by-page* count of the caller's
    non-archived goals matching the kind filter so the FE can render
    pagination without a second call. ``limit`` + ``offset`` are
    echoed back. Default page size is 50 (matches the transactions
    list endpoint — same client-side pagination primitive).
    """

    items: list[GoalPublic]
    total: int
    limit: int
    offset: int


class GoalProgressPublic(BaseModel):
    """Response shape for ``GET /goals/{id}/progress``.

    Mirrors the contract called out in sub-0005-01:

    * ``current_amount_cents`` — read at request time. For sub-0005-01
      this is the persisted ``current_amount_cents`` column (or the
      ``linked_account_id`` account's live balance, when set). The
      sub-0005-02 service layer replaces this with a race-safe compute
      path; the wire shape stays the same.
    * ``target_amount_cents`` — the persisted target.
    * ``percentage`` — ``min(100, current / target * 100)`` rounded to
      two decimals. ``0`` when ``target_amount_cents`` is ``0`` (the
      schema enforces ``> 0`` so this is defensive only).
    * ``achieved_at`` — the persisted row's ``updated_at`` timestamp
      when ``current_amount_cents >= target_amount_cents``, else
      ``null``. The wiring is simple today (a goal that crosses the
      threshold picks up ``updated_at`` next time something writes to
      the row); a more accurate "achievement moment" lands when
      sub-0005-02 wires the live recompute path.
    * ``kind``, ``tabungan_bulanan_cents``, ``lama_mengumpulkan_bulan``
      are surfaced so the FE can render the progress card without a
      second ``GET /goals/{id}`` round-trip.
    """

    goal_id: uuid.UUID
    kind: GoalKind
    current_amount_cents: int
    target_amount_cents: int
    percentage: float
    achieved_at: datetime | None
    tabungan_bulanan_cents: int | None
    lama_mengumpulkan_bulan: int | None


class DebtCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=120)
    kind: DebtKind
    principal_cents: int = Field(gt=0)
    bunga_pct: Decimal = Field(ge=0, max_digits=7, decimal_places=4)
    tenor_months: int | None = Field(default=None, gt=0)
    start_date: date
    note: str | None = Field(default=None, max_length=2000)
    status: DebtStatus = DebtStatus.ACTIVE


class DebtUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=120)
    kind: DebtKind | None = None
    principal_cents: int | None = Field(default=None, gt=0)
    bunga_pct: Decimal | None = Field(
        default=None,
        ge=0,
        max_digits=7,
        decimal_places=4,
    )
    tenor_months: int | None = Field(default=None, gt=0)
    start_date: date | None = None
    note: str | None = Field(default=None, max_length=2000)
    status: DebtStatus | None = None

    @model_validator(mode="after")
    def _reject_null_required_fields(self) -> DebtUpdate:
        for field in (
            "name",
            "kind",
            "principal_cents",
            "bunga_pct",
            "start_date",
            "status",
        ):
            if field in self.model_fields_set and getattr(self, field) is None:
                raise ValueError(f"{field} may not be null")
        return self


class DebtPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    user_id: uuid.UUID
    name: str
    kind: DebtKind
    principal_cents: int
    bunga_pct: float
    tenor_months: int | None
    start_date: date
    monthly_payment_cents: int | None
    note: str | None
    status: DebtStatus
    created_at: datetime
    updated_at: datetime


class DebtSummaryPublic(BaseModel):
    """Response shape for ``GET /debts/{id}/summary`` (sub-0006-03).

    Aggregates the flat-loan schedule with the persisted payment
    ledger so the FE can render the dashboard card without a second
    round-trip. All amounts are integer cents.

    Fields:

    * ``debt_id`` — echoes the path parameter for clients that batch
      multiple summary calls and want to dedupe by id without parsing
      the URL.
    * ``remaining_principal_cents`` — ``principal_cents`` minus the
      sum of every payment's ``principal_portion_cents`` (computed
      at request time; see ``app.services.debt_calculator``).
    * ``total_interest_paid_cents`` — sum of every payment's
      ``interest_portion_cents``. ``0`` when no payments recorded yet.
    * ``next_payment_due_date`` — ``start_date`` advanced by the
      number of persisted payment rows, one month per row. ``null``
      when there is no schedule (``tenor_months is None``) **or** the
      debt is fully paid (no more installments owed). A paid-off debt
      therefore surfaces both ``remaining_principal_cents == 0`` and
      ``next_payment_due_date is None`` so the FE can badge the state
      without a separate status check.
    * ``months_remaining`` — ``tenor_months - payment_count``,
      clamped to ``[0, tenor_months]``. ``null`` when ``tenor_months``
      is ``None`` (no schedule). ``0`` when fully paid.

    The flat-calculator contract is documented in the module
    docstring of :mod:`app.services.debt_calculator` (rounding
    convention + drift-avoidance note).
    """

    debt_id: uuid.UUID
    remaining_principal_cents: int = Field(ge=0)
    total_interest_paid_cents: int = Field(ge=0)
    next_payment_due_date: date | None = None
    months_remaining: int | None = Field(default=None, ge=0)


# --- Debt payments (epic-0006, sub-0006-02) ----------------------------------


class DebtPaymentCreate(BaseModel):
    """Body for ``POST /debts/{debt_id}/payments``.

    Each row is one cicilan — the user records when the payment happened,
    the total amount, and how it splits between principal repayment and
    interest. ``source_account_id`` is optional so a cash-in-hand payment
    (no linked account) is a first-class case (spec AC).

    Validation rules (per sub-0006-02 AC):

    * ``occurred_on`` is a valid date — implicit via the ``date`` type.
    * ``amount_cents`` must be ``> 0`` (Pydantic ``gt=0`` → 422).
    * ``principal_portion_cents`` and ``interest_portion_cents`` must each
      be ``>= 0`` (Pydantic ``ge=0`` → 422). The cross-field check that
      the two portions sum to ``amount_cents`` runs in a model validator
      so a 422 with a clear Pydantic error surfaces before the route.
    * ``source_account_id`` (when set) must belong to the caller —
      enforced in the route against the persisted ``accounts`` row (404
      when missing or owned by another user, same pattern as the
      transactions / goals routers).
    * The route enforces that ``amount_cents`` does not exceed the
      debt's remaining principal after summing the new payment with
      any existing payment rows — overpayment is rejected with 422.
    * The debt must be ``active`` — payments on a ``paid_off`` debt are
      rejected with 422 (the spec calls out that the status moves to
      ``paid_off`` exactly when remaining_principal = 0).

    ``extra="forbid"`` so a client attempting to set server-controlled
    fields (``id``, ``debt_id``, ``created_at``, ``updated_at``) gets a
    422 with a clear Pydantic error before the route runs.
    """

    model_config = ConfigDict(extra="forbid")

    occurred_on: date
    amount_cents: int = Field(
        gt=0,
        description="Total cicilan amount in cents (positive integer). Zero or negative values are rejected.",
    )
    principal_portion_cents: int = Field(
        ge=0,
        description="Portion of the payment that reduces the remaining principal (cents, >= 0).",
    )
    interest_portion_cents: int = Field(
        ge=0,
        description="Portion of the payment counted as interest (cents, >= 0).",
    )
    source_account_id: uuid.UUID | None = Field(
        default=None,
        description="Optional FK to the account that funded the cicilan. Nullable so cash-in-hand payments are allowed.",
    )
    note: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def _check_portions_sum_to_amount(self) -> DebtPaymentCreate:
        if self.principal_portion_cents + self.interest_portion_cents != self.amount_cents:
            raise ValueError(
                "principal_portion_cents + interest_portion_cents must equal amount_cents "
                f"(got {self.principal_portion_cents} + {self.interest_portion_cents} = "
                f"{self.principal_portion_cents + self.interest_portion_cents}, expected "
                f"{self.amount_cents})"
            )
        return self


class DebtPaymentUpdate(BaseModel):
    """Body for ``PATCH /debts/{debt_id}/payments/{payment_id}`` — every field is optional.

    Cross-field validation:

    * When ``amount_cents`` AND any of the portion fields are provided,
      the two portions must still sum to ``amount_cents`` (Pydantic
      ``model_validator`` → 422).
    * When only one portion is provided, the OTHER portion is left at
      its persisted value — but the route enforces the final sum equals
      ``amount_cents`` after the merge (422 when the new split doesn't
      add up). The partial-portion case where the caller sends
      ``amount_cents`` alone is also rejected (422) because we can't
      silently rebalance the split.

    ``source_account_id`` can be cleared by sending ``null``.
    ``occurred_on`` is editable so a payment booked on the wrong day can
    be corrected.

    ``extra="forbid"`` rejects unknown / server-controlled fields
    (``id``, ``debt_id``, ``created_at``, ``updated_at``).
    """

    model_config = ConfigDict(extra="forbid")

    occurred_on: date | None = None
    amount_cents: int | None = Field(
        default=None,
        gt=0,
        description="Total cicilan amount in cents (positive integer). Zero or negative values are rejected.",
    )
    principal_portion_cents: int | None = Field(
        default=None,
        ge=0,
        description="Portion that reduces the remaining principal (cents, >= 0).",
    )
    interest_portion_cents: int | None = Field(
        default=None,
        ge=0,
        description="Portion counted as interest (cents, >= 0).",
    )
    source_account_id: uuid.UUID | None = Field(
        default=None,
        description="Optional FK to the funding account. Send null to clear the link.",
    )
    note: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def _check_portions_sum_when_all_provided(self) -> DebtPaymentUpdate:
        # Only enforce the split rule when ALL THREE amount + portion
        # fields are explicitly supplied by the caller. Partial edits
        # (e.g. only ``note`` or only ``principal_portion_cents``) are
        # merged with the persisted values inside the route, where the
        # final ``amount_cents == principal + interest`` invariant is
        # re-checked against the merged effective values (422 when the
        # caller-supplied split can't reconcile with the existing
        # ``amount_cents``).
        if (
            self.amount_cents is not None
            and self.principal_portion_cents is not None
            and self.interest_portion_cents is not None
            and self.principal_portion_cents + self.interest_portion_cents != self.amount_cents
        ):
            raise ValueError(
                "principal_portion_cents + interest_portion_cents must equal amount_cents "
                f"(got {self.principal_portion_cents} + {self.interest_portion_cents} = "
                f"{self.principal_portion_cents + self.interest_portion_cents}, expected "
                f"{self.amount_cents})"
            )
        return self


class DebtPaymentPublic(BaseModel):
    """Output shape for a single ``debt_payments`` row.

    Mirrors the columns on :class:`app.db.models.debt.DebtPayment`
    directly via ``from_attributes=True``. ``source_account_id`` is
    nullable — a row without a linked account surfaces ``null`` so the
    FE can render a "Cash" badge instead of crashing on a missing FK.
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    debt_id: uuid.UUID
    occurred_on: date
    amount_cents: int
    principal_portion_cents: int
    interest_portion_cents: int
    source_account_id: uuid.UUID | None
    note: str | None
    created_at: datetime
    updated_at: datetime


class DebtPaymentListPublic(BaseModel):
    """Response envelope for ``GET /debts/{debt_id}/payments``.

    Sorted with the most recent ``occurred_on`` first (descending) —
    the FE "History Cicilan" view (sub-0006-06) expects that order —
    followed by a deterministic tie-breaker chain on ``created_at``
    desc and ``id`` asc. ``total`` is the unfiltered-by-page row count
    for the caller so the FE can render pagination controls without a
    second request. Default page size is 50 (matches the transactions
    list endpoint — same client-side pagination primitive).
    """

    items: list[DebtPaymentPublic]
    total: int
    limit: int
    offset: int


# --- Dashboard (epic-0007, sub-0007-01) ---------------------------------------

# TL decision (epic-0007, sub-0007-01): the dashboard endpoints are
# read-only aggregations over the existing ``transactions`` / ``accounts`` /
# ``goals`` / ``debts`` tables. No new persistence layer is introduced —
# the cache layer (TTL dict in ``app.services.dashboard_cache``) sits in
# front of the route, not in front of the DB. All amounts are integer
# cents, same convention as the rest of the API.

# Dashboard status values for the goals progress card (the FE badges
# "Achieved" vs "On track" vs "Needs attention" off this enum). Mirrors
# the goal-engine's threshold-cross logic without re-deriving it here —
# the engine still owns the source-of-truth ``achieved_at`` column.

DashboardGoalStatus = Literal["active", "achieved", "archived"]


class DashboardSummaryPublic(BaseModel):
    """Response shape for ``GET /dashboard/summary`` (sub-0007-01).

    Surfaces the four KPI numbers the FE renders above the dashboard
    charts + the two secondary numbers that drive the cards on the
    second row (income/expense this month, EF progress). All amounts
    are integer cents.

    Fields:

    * ``networth_cents`` — sum of every asset account's saldo minus the
      sum of every liability account's saldo (mirrors the
      ``UserBalances.networth_cents`` field from the saldo engine).
      **Liability saldo conventions.** The saldo engine treats a
      ``credit_card`` account's saldo as a *negative* number when its
      running balance goes below zero (the engine sums ``opening_balance
      + deltas`` and the deltas use the same sign convention the rest
      of the API uses: ``expense`` -> ``-``, ``income`` -> ``+``). The
      dashboard treats that negative number as the liability's
      *outstanding* amount and adds its absolute value to the
      liabilities total -- so a credit card with ``saldo = -500_000``
      contributes ``+500_000`` to ``total_liabilities_cents`` and the
      networth equation stays consistent with the FE's "Networth =
      assets - liabilities" mental model.
    * ``total_assets_cents`` — sum of every non-credit-card account's
      saldo (positive contributions only; a negative cash balance would
      still surface here, the engine doesn't clamp).
    * ``total_liabilities_cents`` — sum of absolute credit-card saldos.
      ``0`` when the user has no liability accounts.
    * ``income_this_month_cents`` — sum of ``amount_cents`` for every
      active (``deleted_at IS NULL``) income transaction in the
      caller's *local* calendar month (mirrors the dashboard's "this
      month" filter). Excludes transfers.
    * ``expense_this_month_cents`` — same window, ``type = 'expense'``.
    * ``emergency_fund_avg_pct`` — average of ``current / target * 100``
      across every *active* EF goal (``kind='emergency_fund'`` AND
      ``archived_at IS NULL``). ``null`` when the user has no active EF
      goals — the FE renders "Belum ada dana darurat" instead of a
      misleading ``0%``.

    Currency is locked to ``IDR`` (MVP single-currency); the FE hardcodes
    the locale so this is a courtesy field.
    """

    currency: str
    networth_cents: int
    total_assets_cents: int
    total_liabilities_cents: int
    income_this_month_cents: int
    expense_this_month_cents: int
    emergency_fund_avg_pct: float | None = None


class DashboardNetworthTrendPointPublic(BaseModel):
    """One row of the per-month networth trend.

    ``month`` is the ``YYYY-MM`` string (no day component) so the FE can
    bucket by month without re-parsing a full date. ``networth_cents``
    is the user's networth *at the end* of that calendar month — the
    historical "what would the dashboard have shown if you opened it
    on the last day of the month" number.
    """

    month: str = Field(
        description="Calendar month in ``YYYY-MM`` form (no day component).",
    )
    networth_cents: int


class DashboardNetworthTrendPublic(BaseModel):
    """Response shape for ``GET /dashboard/networth-trend``.

    ``data`` is ordered oldest-first (``month ASC``) so the FE line
    chart renders left-to-right chronologically without a client-side
    sort.
    """

    data: list[DashboardNetworthTrendPointPublic]


class DashboardIncomeExpenseTrendPointPublic(BaseModel):
    """One row of the per-month income/expense trend.

    Empty months still surface as a row with both values at ``0`` so
    the FE bar chart has a consistent 12-bar x-axis (AC: "FE butuh 12
    baris konsisten").
    """

    month: str = Field(
        description="Calendar month in ``YYYY-MM`` form (no day component).",
    )
    income_cents: int
    expense_cents: int


class DashboardIncomeExpenseTrendPublic(BaseModel):
    """Response shape for ``GET /dashboard/income-expense-trend``."""

    data: list[DashboardIncomeExpenseTrendPointPublic]


class DashboardTopCategoryPublic(BaseModel):
    """One row of the top-N expense categories for the requested month.

    ``percentage`` is the row's share of the *caller's total expense
    in the same month* (so the values across rows sum to roughly 100
    — the FE uses the percentage for the donut chart without a
    follow-up normalization step).
    """

    category_id: uuid.UUID | None
    category_name: str | None
    total_cents: int
    percentage: float


class DashboardTopCategoriesPublic(BaseModel):
    """Response shape for ``GET /dashboard/top-categories``."""

    data: list[DashboardTopCategoryPublic]


class DashboardGoalProgressPublic(BaseModel):
    """One row of the per-goal progress snapshot.

    Mirrors the goal-engine's :class:`GoalProgress` shape, plus a
    pre-computed ``status`` (``active`` / ``achieved`` / ``archived``)
    so the FE doesn't have to recompute it for the badge. ``pct`` is
    the engine's clamped percentage (``min(100, current / target * 100)``).
    """

    goal_id: uuid.UUID
    name: str
    kind: GoalKind
    current_cents: int
    target_cents: int
    pct: float
    status: DashboardGoalStatus
    due_date: date | None = None


class DashboardGoalsProgressPublic(BaseModel):
    """Response shape for ``GET /dashboard/goals-progress``.

    Includes every non-archived goal so the FE can render the progress
    card without a second list call. ``data`` order is
    ``kind asc, start_date desc`` so the EF goal (the FE's primary KPI)
    surfaces first regardless of creation order.
    """

    data: list[DashboardGoalProgressPublic]


class DashboardDebtsSummaryPublic(BaseModel):
    """Response shape for ``GET /dashboard/debts-summary``.

    Aggregates across *every* debt the caller owns (active + paid off)
    so the FE's "ringkasan utang" card can show the full ledger in one
    round-trip. All amounts are integer cents.

    Fields:

    * ``total_remaining_cents`` — sum of ``remaining_principal_cents``
      across all debts (active only; paid-off debts contribute ``0``).
    * ``total_interest_paid_cents`` — sum of ``total_interest_paid_cents``
      across all debts.
    * ``active_count`` — number of debts with ``status='active'``.
    * ``paid_off_count`` — number of debts with ``status='paid_off'``.
    """

    total_remaining_cents: int
    total_interest_paid_cents: int
    active_count: int
    paid_off_count: int
