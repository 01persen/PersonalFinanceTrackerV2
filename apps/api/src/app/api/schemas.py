"""Pydantic schemas shared across the v1 API.

Kept in one place for now — once endpoints proliferate we'll split per-domain.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, model_validator

from app.db.models.account import Account
from app.db.models.enums import AccountType, CategoryKind, TransactionType


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
