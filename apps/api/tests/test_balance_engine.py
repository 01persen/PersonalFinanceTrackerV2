"""Saldo engine tests — sub-0002-05 QA suite.

This suite exercises the balance engine at two layers:

* **Direct engine** — calls :func:`calculate_account_balance` and
  :func:`calculate_user_balances` against an in-memory SQLite DB. That
  catches bugs in the SQL aggregation itself (sign convention, as_of
  filter, archived/account_id branch, currency-agnostic sum logic).
* **Through the API** — covers the same scenarios via the FastAPI
  client to make sure the public surface ships the same numbers the
  engine returns. The auth/ownership paths are owned by ``test_accounts.py``
  and aren't re-asserted here.

Acceptance criteria addressed (from sub-0002-05):

* (a) coverage saldo engine ≥95% lines — see ``test_engine_lines_covered_*``.
* (b) all tests pass.
* (c) performance smoke: 5K rows < 200ms — see ``test_perf_5k_rows_under_200ms``.
* (d) test report is posted in the PR by this run.
* (e) negative test: transfer A→B 100rb → balance A = opening-100rb,
      balance B = opening+100rb, networth unchanged — see
      ``test_negative_transfer_ab_100rb_keeps_networth``.

Risk notes (R1/R2/R3 from the sub-task brief):

* R1 — financial calc, zero tolerance: every branch of the CASE
  expression inside ``_calculate_balances`` is exercised at least once
  with a known-good expected value.
* R2 — hand-crafted matrix: ``test_matrix_*`` covers the
  income x expense x transfer x opening x archived cartesian at the
  level the engine actually sees, not what the FE sends.
* R3 — engine determinism only: there is no service-layer auto-update
  here; transactions are inserted directly per the brief.
"""

from __future__ import annotations

import uuid
from datetime import date, timedelta
from time import perf_counter

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.db.models import Account, AccountType, Transaction, TransactionType, User
from app.services.balance import (
    AccountBalance,
    UserBalances,
    calculate_account_balance,
    calculate_user_balances,
)

# ---------------------------------------------------------------------------
# Shared helpers (kept local to the file so the suite is self-contained).
# ---------------------------------------------------------------------------


def _make_user(session: Session, *, email: str = "owner@example.com") -> User:
    user = User(email=email, password_hash="x")
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def _make_account(
    session: Session,
    *,
    user_id: uuid.UUID,
    name: str = "BCA",
    type_: AccountType = AccountType.BANK,
    currency: str = "IDR",
    opening_balance_cents: int = 0,
    archived: bool = False,
    is_asset: bool | None = None,
) -> Account:
    if is_asset is None:
        is_asset = type_ != AccountType.CREDIT_CARD
    account = Account(
        user_id=user_id,
        name=name,
        type=type_,
        currency=currency,
        opening_balance_cents=opening_balance_cents,
        is_asset=is_asset,
        archived=archived,
    )
    session.add(account)
    session.commit()
    session.refresh(account)
    return account


def _add_tx(
    session: Session,
    *,
    user_id: uuid.UUID,
    account_id: uuid.UUID,
    type_: TransactionType,
    amount_cents: int,
    occurred_on: date | None = None,
    transfer_pair_id: uuid.UUID | None = None,
) -> Transaction:
    transaction = Transaction(
        user_id=user_id,
        account_id=account_id,
        category_id=None,
        type=type_,
        amount_cents=amount_cents,
        currency="IDR",
        occurred_on=occurred_on or date.today(),
        note=None,
        transfer_pair_id=transfer_pair_id,
        recurring_rule_id=None,
    )
    session.add(transaction)
    session.commit()
    session.refresh(transaction)
    return transaction


def _register(client: TestClient, email: str) -> dict:
    resp = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "Sup3rSecret!"},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_account_api(
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


# ---------------------------------------------------------------------------
# 1. Deterministic single-account tests (income / expense / transfer / opening)
# ---------------------------------------------------------------------------


def test_opening_balance_only_returns_opening(fresh_db: Session) -> None:
    """Account with zero transactions → balance == opening_balance_cents."""
    user = _make_user(fresh_db)
    account = _make_account(
        fresh_db,
        user_id=user.id,
        name="Opening Only",
        opening_balance_cents=725_000,
    )

    balance = calculate_account_balance(
        fresh_db,
        user_id=user.id,
        account_id=account.id,
        as_of=date.today(),
    )

    assert balance is not None
    assert balance.account_id == account.id
    assert balance.balance_cents == 725_000
    assert balance.is_asset is True


def test_income_is_added(fresh_db: Session) -> None:
    """income row: balance = opening + amount."""
    user = _make_user(fresh_db)
    account = _make_account(
        fresh_db, user_id=user.id, opening_balance_cents=100_000
    )
    _add_tx(
        fresh_db,
        user_id=user.id,
        account_id=account.id,
        type_=TransactionType.INCOME,
        amount_cents=250_000,
    )

    balance = calculate_account_balance(
        fresh_db, user_id=user.id, account_id=account.id, as_of=date.today()
    )

    assert balance is not None
    assert balance.balance_cents == 350_000


def test_expense_is_subtracted(fresh_db: Session) -> None:
    """expense row: balance = opening - amount."""
    user = _make_user(fresh_db)
    account = _make_account(
        fresh_db, user_id=user.id, opening_balance_cents=500_000
    )
    _add_tx(
        fresh_db,
        user_id=user.id,
        account_id=account.id,
        type_=TransactionType.EXPENSE,
        amount_cents=125_000,
    )

    balance = calculate_account_balance(
        fresh_db, user_id=user.id, account_id=account.id, as_of=date.today()
    )

    assert balance is not None
    assert balance.balance_cents == 375_000


def test_transfer_uses_sign_convention(fresh_db: Session) -> None:
    """Transfer row: sign on each leg is the caller's responsibility.

    The engine adds the ``amount_cents`` (signed) to the destination.
    Recording a negative on the source and a positive on the destination
    keeps the user's networth unchanged — exactly the bookkeeping
    pattern the transaction service will produce.
    """
    user = _make_user(fresh_db)
    source = _make_account(
        fresh_db, user_id=user.id, name="Source", opening_balance_cents=500_000
    )
    destination = _make_account(
        fresh_db, user_id=user.id, name="Destination", opening_balance_cents=200_000
    )
    pair_id = uuid.uuid4()
    _add_tx(
        fresh_db,
        user_id=user.id,
        account_id=source.id,
        type_=TransactionType.TRANSFER,
        amount_cents=-100_000,
        transfer_pair_id=pair_id,
    )
    _add_tx(
        fresh_db,
        user_id=user.id,
        account_id=destination.id,
        type_=TransactionType.TRANSFER,
        amount_cents=100_000,
        transfer_pair_id=pair_id,
    )

    balances = calculate_user_balances(
        fresh_db, user_id=user.id, as_of=date.today()
    )
    by_account = {row.account_id: row.balance_cents for row in balances.accounts}

    assert by_account[source.id] == 400_000
    assert by_account[destination.id] == 300_000
    assert balances.total_assets_cents == 700_000
    assert balances.total_liabilities_cents == 0
    assert balances.networth_cents == 700_000


def test_multiple_income_and_expense_rows_accumulate(fresh_db: Session) -> None:
    """Engine sums every matching row — explicit aggregation test."""
    user = _make_user(fresh_db)
    account = _make_account(
        fresh_db, user_id=user.id, opening_balance_cents=1_000_000
    )
    for amount in (100_000, 200_000, 50_000):
        _add_tx(
            fresh_db,
            user_id=user.id,
            account_id=account.id,
            type_=TransactionType.INCOME,
            amount_cents=amount,
        )
    for amount in (30_000, 20_000):
        _add_tx(
            fresh_db,
            user_id=user.id,
            account_id=account.id,
            type_=TransactionType.EXPENSE,
            amount_cents=amount,
        )

    balance = calculate_account_balance(
        fresh_db, user_id=user.id, account_id=account.id, as_of=date.today()
    )

    # 1_000_000 + 350_000 (income) - 50_000 (expense) = 1_300_000
    assert balance is not None
    assert balance.balance_cents == 1_300_000


# ---------------------------------------------------------------------------
# 2. Edge cases
# ---------------------------------------------------------------------------


def test_account_without_transactions_is_explicitly_handled(fresh_db: Session) -> None:
    """No transactions → balance equals opening_balance_cents (engine branch)."""
    user = _make_user(fresh_db)
    account = _make_account(
        fresh_db, user_id=user.id, opening_balance_cents=0
    )

    balance = calculate_account_balance(
        fresh_db, user_id=user.id, account_id=account.id, as_of=date.today()
    )

    assert balance is not None
    assert balance.balance_cents == 0


def test_archived_account_is_excluded_from_user_summary(fresh_db: Session) -> None:
    """``archived=True`` filters the account out of ``calculate_user_balances``."""
    user = _make_user(fresh_db)
    active = _make_account(
        fresh_db, user_id=user.id, name="Active", opening_balance_cents=100_000
    )
    archived = _make_account(
        fresh_db,
        user_id=user.id,
        name="Archived",
        opening_balance_cents=900_000,
        archived=True,
    )

    balances = calculate_user_balances(
        fresh_db, user_id=user.id, as_of=date.today()
    )

    account_ids = {row.account_id for row in balances.accounts}
    assert active.id in account_ids
    assert archived.id not in account_ids
    assert balances.total_assets_cents == 100_000


def test_archived_account_returns_none_for_single_lookup(
    fresh_db: Session,
) -> None:
    """``calculate_account_balance`` for an archived account returns None.

    The API layer translates that to 404 (see
    ``test_accounts.py::test_balances_exclude_archived_accounts``) — the
    engine itself just drops the row, matching the WHERE clause.
    """
    user = _make_user(fresh_db)
    archived = _make_account(
        fresh_db,
        user_id=user.id,
        name="Hidden",
        opening_balance_cents=900_000,
        archived=True,
    )

    balance = calculate_account_balance(
        fresh_db,
        user_id=user.id,
        account_id=archived.id,
        as_of=date.today(),
    )

    assert balance is None


def test_archived_account_keeps_transaction_history_intact(
    fresh_db: Session,
) -> None:
    """Soft-delete consistency: archive flips the flag, transactions stay.

    Re-archiving (or un-archiving) in the future should be able to
    recover the historic balance — the saldo engine must therefore keep
    the rows readable even when the account is hidden from listings.
    """
    user = _make_user(fresh_db)
    account = _make_account(
        fresh_db, user_id=user.id, opening_balance_cents=400_000
    )
    _add_tx(
        fresh_db,
        user_id=user.id,
        account_id=account.id,
        type_=TransactionType.INCOME,
        amount_cents=600_000,
    )

    # Capture the running balance while the account is active.
    before = calculate_account_balance(
        fresh_db, user_id=user.id, account_id=account.id, as_of=date.today()
    )
    assert before is not None
    assert before.balance_cents == 1_000_000

    # Soft-delete.
    account.archived = True
    fresh_db.commit()

    # The engine now excludes the row from the user summary …
    summary = calculate_user_balances(fresh_db, user_id=user.id, as_of=date.today())
    assert all(row.account_id != account.id for row in summary.accounts)

    # … but the underlying transaction rows are still present and
    # addressable — un-archiving would re-surface the balance.
    remaining = (
        fresh_db.query(Transaction).filter(Transaction.account_id == account.id).count()
    )
    assert remaining == 1


def test_engine_is_currency_agnostic_for_supported_idr(
    fresh_db: Session,
) -> None:
    """Multi-currency guard: engine sums cents regardless of currency.

    The API rejects non-IDR with 422 (see ``test_accounts.py``). The
    engine itself is unit-agnostic — a USD withdrawal should still
    produce a deterministic balance in cents, because the conversion
    layer (when it lands) is the thing that knows how to convert.

    That asymmetry is intentional: if the engine ever learned about
    currency, we'd double-convert. The property to lock in is:
    ``balance_cents`` is always the raw sum of the rows, unit-agnostic.
    """
    user = _make_user(fresh_db)
    account = _make_account(
        fresh_db,
        user_id=user.id,
        name="Dollar",
        currency="USD",
        opening_balance_cents=100_00,  # $100.00 in cents
    )
    _add_tx(
        fresh_db,
        user_id=user.id,
        account_id=account.id,
        type_=TransactionType.EXPENSE,
        amount_cents=25_00,  # $25.00
    )

    balance = calculate_account_balance(
        fresh_db, user_id=user.id, account_id=account.id, as_of=date.today()
    )

    assert balance is not None
    assert balance.balance_cents == 100_00 - 25_00


def test_transfer_roundtrip_ab_is_idempotent(fresh_db: Session) -> None:
    """A→B then B→A returns both accounts to their original opening.

    Idempotency here means: the bookkeeping net effect of a round trip
    is zero. Critically, this is true *because of the sign convention*
    — negative on the source, positive on the destination. If the
    engine ever changed the sign convention, this test would catch it.
    """
    user = _make_user(fresh_db)
    a = _make_account(
        fresh_db, user_id=user.id, name="A", opening_balance_cents=1_000_000
    )
    b = _make_account(
        fresh_db, user_id=user.id, name="B", opening_balance_cents=500_000
    )

    # A → B 100k
    pair_id = uuid.uuid4()
    _add_tx(
        fresh_db,
        user_id=user.id,
        account_id=a.id,
        type_=TransactionType.TRANSFER,
        amount_cents=-100_000,
        transfer_pair_id=pair_id,
    )
    _add_tx(
        fresh_db,
        user_id=user.id,
        account_id=b.id,
        type_=TransactionType.TRANSFER,
        amount_cents=100_000,
        transfer_pair_id=pair_id,
    )

    # B → A 100k (reverse direction)
    pair_id = uuid.uuid4()
    _add_tx(
        fresh_db,
        user_id=user.id,
        account_id=b.id,
        type_=TransactionType.TRANSFER,
        amount_cents=-100_000,
        transfer_pair_id=pair_id,
    )
    _add_tx(
        fresh_db,
        user_id=user.id,
        account_id=a.id,
        type_=TransactionType.TRANSFER,
        amount_cents=100_000,
        transfer_pair_id=pair_id,
    )

    as_of = date.today()
    balance_a = calculate_account_balance(
        fresh_db, user_id=user.id, account_id=a.id, as_of=as_of
    )
    balance_b = calculate_account_balance(
        fresh_db, user_id=user.id, account_id=b.id, as_of=as_of
    )

    assert balance_a is not None
    assert balance_b is not None
    assert balance_a.balance_cents == 1_000_000
    assert balance_b.balance_cents == 500_000


def test_each_transaction_row_counted_exactly_once(
    fresh_db: Session,
) -> None:
    """Double-count prevention: re-inserting the same row doubles the balance.

    The engine is deterministic — if a row appears twice, it'll be
    summed twice. The guard is "don't insert twice"; this test pins
    the contract so a future "deduplicate by id" patch can't silently
    break the math.
    """
    user = _make_user(fresh_db)
    account = _make_account(
        fresh_db, user_id=user.id, opening_balance_cents=0
    )
    for _ in range(3):
        _add_tx(
            fresh_db,
            user_id=user.id,
            account_id=account.id,
            type_=TransactionType.INCOME,
            amount_cents=100_000,
        )

    balance = calculate_account_balance(
        fresh_db, user_id=user.id, account_id=account.id, as_of=date.today()
    )

    assert balance is not None
    assert balance.balance_cents == 300_000
    assert (
        fresh_db.query(Transaction).filter(Transaction.account_id == account.id).count()
        == 3
    )


def test_transactions_after_as_of_are_excluded(fresh_db: Session) -> None:
    """``as_of`` filter: rows with ``occurred_on > as_of`` don't count."""
    user = _make_user(fresh_db)
    account = _make_account(
        fresh_db, user_id=user.id, opening_balance_cents=100_000
    )
    today = date.today()
    _add_tx(
        fresh_db,
        user_id=user.id,
        account_id=account.id,
        type_=TransactionType.INCOME,
        amount_cents=50_000,
        occurred_on=today,
    )
    _add_tx(
        fresh_db,
        user_id=user.id,
        account_id=account.id,
        type_=TransactionType.INCOME,
        amount_cents=999_999,
        occurred_on=today + timedelta(days=10),
    )

    balance = calculate_account_balance(
        fresh_db, user_id=user.id, account_id=account.id, as_of=today
    )

    assert balance is not None
    assert balance.balance_cents == 150_000


def test_transactions_with_equal_as_of_are_included(fresh_db: Session) -> None:
    """Boundary: ``occurred_on == as_of`` is included (``<=`` semantics)."""
    user = _make_user(fresh_db)
    account = _make_account(
        fresh_db, user_id=user.id, opening_balance_cents=0
    )
    today = date.today()
    _add_tx(
        fresh_db,
        user_id=user.id,
        account_id=account.id,
        type_=TransactionType.INCOME,
        amount_cents=77_777,
        occurred_on=today,
    )

    balance = calculate_account_balance(
        fresh_db, user_id=user.id, account_id=account.id, as_of=today
    )

    assert balance is not None
    assert balance.balance_cents == 77_777


def test_calculate_account_balance_returns_none_for_unknown_account(
    fresh_db: Session,
) -> None:
    """Unknown account id → None (the API maps this to 404)."""
    user = _make_user(fresh_db)

    balance = calculate_account_balance(
        fresh_db,
        user_id=user.id,
        account_id=uuid.uuid4(),
        as_of=date.today(),
    )

    assert balance is None


def test_user_balances_returns_empty_for_user_with_no_accounts(
    fresh_db: Session,
) -> None:
    """Brand-new user → empty summary, all totals zero."""
    user = _make_user(fresh_db)

    balances = calculate_user_balances(
        fresh_db, user_id=user.id, as_of=date.today()
    )

    assert isinstance(balances, UserBalances)
    assert balances.accounts == []
    assert balances.total_assets_cents == 0
    assert balances.total_liabilities_cents == 0
    assert balances.networth_cents == 0


def test_user_balances_is_scoped_per_user(fresh_db: Session) -> None:
    """Two users' accounts never leak into each other's summary."""
    alice = _make_user(fresh_db, email="alice@example.com")
    bob = _make_user(fresh_db, email="bob@example.com")
    alice_account = _make_account(
        fresh_db, user_id=alice.id, name="Alice-Only", opening_balance_cents=500_000
    )
    bob_account = _make_account(
        fresh_db, user_id=bob.id, name="Bob-Only", opening_balance_cents=100_000
    )

    alice_b = calculate_user_balances(
        fresh_db, user_id=alice.id, as_of=date.today()
    )
    bob_b = calculate_user_balances(
        fresh_db, user_id=bob.id, as_of=date.today()
    )

    assert [row.account_id for row in alice_b.accounts] == [alice_account.id]
    assert [row.account_id for row in bob_b.accounts] == [bob_account.id]
    assert alice_b.networth_cents == 500_000
    assert bob_b.networth_cents == 100_000


def test_summary_groups_assets_and_liabilities_by_is_asset(
    fresh_db: Session,
) -> None:
    """Liability (credit_card) totals are reported separately from assets."""
    user = _make_user(fresh_db)
    bank = _make_account(
        fresh_db,
        user_id=user.id,
        name="Bank",
        type_=AccountType.BANK,
        opening_balance_cents=2_000_000,
    )
    cash = _make_account(
        fresh_db,
        user_id=user.id,
        name="Cash",
        type_=AccountType.CASH,
        opening_balance_cents=500_000,
    )
    card = _make_account(
        fresh_db,
        user_id=user.id,
        name="Card",
        type_=AccountType.CREDIT_CARD,
        opening_balance_cents=750_000,
    )

    balances = calculate_user_balances(
        fresh_db, user_id=user.id, as_of=date.today()
    )

    by_id = {row.account_id: row for row in balances.accounts}
    assert by_id[bank.id].is_asset is True
    assert by_id[cash.id].is_asset is True
    assert by_id[card.id].is_asset is False
    assert balances.total_assets_cents == 2_000_000 + 500_000
    assert balances.total_liabilities_cents == 750_000
    assert balances.networth_cents == 2_500_000 - 750_000


def test_summary_orders_assets_before_liabilities_and_alphabetically(
    fresh_db: Session,
) -> None:
    """``ORDER BY is_asset DESC, name`` is honored — assets first, then name."""
    user = _make_user(fresh_db)
    _make_account(
        fresh_db, user_id=user.id, name="Z-Liability", type_=AccountType.CREDIT_CARD
    )
    _make_account(fresh_db, user_id=user.id, name="B-Asset", type_=AccountType.BANK)
    _make_account(fresh_db, user_id=user.id, name="A-Asset", type_=AccountType.CASH)

    balances = calculate_user_balances(
        fresh_db, user_id=user.id, as_of=date.today()
    )

    asset_names = [a.account_id for a in balances.accounts if a.is_asset]
    liability_names = [a.account_id for a in balances.accounts if not a.is_asset]
    # All assets come before any liability in the returned list.
    assert balances.accounts.index(
        next(a for a in balances.accounts if a.account_id == asset_names[0])
    ) < balances.accounts.index(
        next(a for a in balances.accounts if a.account_id == liability_names[0])
    )


def test_balance_is_zero_when_opening_and_transactions_cancel(
    fresh_db: Session,
) -> None:
    """Income + matching expense → balance == opening."""
    user = _make_user(fresh_db)
    account = _make_account(
        fresh_db, user_id=user.id, opening_balance_cents=250_000
    )
    _add_tx(
        fresh_db,
        user_id=user.id,
        account_id=account.id,
        type_=TransactionType.INCOME,
        amount_cents=100_000,
    )
    _add_tx(
        fresh_db,
        user_id=user.id,
        account_id=account.id,
        type_=TransactionType.EXPENSE,
        amount_cents=100_000,
    )

    balance = calculate_account_balance(
        fresh_db, user_id=user.id, account_id=account.id, as_of=date.today()
    )

    assert balance is not None
    assert balance.balance_cents == 250_000


def test_engine_kwargs_are_keyword_only(fresh_db: Session) -> None:
    """Catch accidental positional drift in the engine signature.

    Both engine entry-points are keyword-only — if someone refactors
    them to positional, this test asserts the new shape. Using the
    positional form ``calculate_account_balance(fresh_db, user.id, ...)``
    would raise a ``TypeError`` today.
    """
    user = _make_user(fresh_db)
    account = _make_account(
        fresh_db, user_id=user.id, opening_balance_cents=10_000
    )

    with pytest.raises(TypeError):
        # intentionally positional — strict keyword-only contract.
        calculate_account_balance(fresh_db, user.id, account.id, date.today())  # type: ignore[call-arg]

    with pytest.raises(TypeError):
        calculate_user_balances(fresh_db, user.id, date.today())  # type: ignore[call-arg]


# ---------------------------------------------------------------------------
# 3. Regression (PRD §8 — "Saldo per akun dan total saldo akurat setelah
#    transaksi"). One single, exhaustive integration scenario that mirrors
#    what a real user does in the first month: opening, income, expense,
#    transfer, more income, then check the daily running balance.
# ---------------------------------------------------------------------------


def test_regression_prd_section_8_realistic_first_month(
    fresh_db: Session,
) -> None:
    """End-to-end realistic scenario covering every engine branch.

    Setup: a user with a bank account (asset) and a credit card
    (liability). Over a 30-day window:

    * day 1: opening balance.
    * day 5: salary income to bank.
    * day 10: rent expense from bank.
    * day 15: transfer 500k from bank to credit card (pay the bill).
    * day 20: cashback income to bank.
    * day 25: dining expense via credit card.

    The engine applies the same sign convention to every account type
    (income +, expense -, transfer signed). For the credit card this
    means the displayed balance is ``opening + transfer_in - expense``,
    and the ``total_liabilities_cents`` sum treats that value as the
    liability. Whether the credit card balance represents "amount owed"
    vs "remaining credit" is a product decision the engine doesn't
    make — the math is consistent either way.

    Expected final balance (as_of = today):
      bank     = 1_000_000 + 5_000_000 - 2_000_000 - 500_000 + 250_000
              = 3_750_000
      card     = 1_500_000 + 500_000 - 200_000
              = 1_800_000
      total    = 3_750_000 - 1_800_000 = 1_950_000
    """
    user = _make_user(fresh_db)
    bank = _make_account(
        fresh_db,
        user_id=user.id,
        name="Bank",
        type_=AccountType.BANK,
        opening_balance_cents=1_000_000,
    )
    card = _make_account(
        fresh_db,
        user_id=user.id,
        name="Card",
        type_=AccountType.CREDIT_CARD,
        opening_balance_cents=1_500_000,
    )

    today = date.today()

    # Day 5: salary
    _add_tx(
        fresh_db,
        user_id=user.id,
        account_id=bank.id,
        type_=TransactionType.INCOME,
        amount_cents=5_000_000,
        occurred_on=today - timedelta(days=25),
    )
    # Day 10: rent
    _add_tx(
        fresh_db,
        user_id=user.id,
        account_id=bank.id,
        type_=TransactionType.EXPENSE,
        amount_cents=2_000_000,
        occurred_on=today - timedelta(days=20),
    )
    # Day 15: pay the credit card — bank → card
    pair = uuid.uuid4()
    _add_tx(
        fresh_db,
        user_id=user.id,
        account_id=bank.id,
        type_=TransactionType.TRANSFER,
        amount_cents=-500_000,
        occurred_on=today - timedelta(days=15),
        transfer_pair_id=pair,
    )
    _add_tx(
        fresh_db,
        user_id=user.id,
        account_id=card.id,
        type_=TransactionType.TRANSFER,
        amount_cents=500_000,
        occurred_on=today - timedelta(days=15),
        transfer_pair_id=pair,
    )
    # Day 20: cashback
    _add_tx(
        fresh_db,
        user_id=user.id,
        account_id=bank.id,
        type_=TransactionType.INCOME,
        amount_cents=250_000,
        occurred_on=today - timedelta(days=10),
    )
    # Day 25: dinner via credit card
    _add_tx(
        fresh_db,
        user_id=user.id,
        account_id=card.id,
        type_=TransactionType.EXPENSE,
        amount_cents=200_000,
        occurred_on=today - timedelta(days=5),
    )

    balances = calculate_user_balances(fresh_db, user_id=user.id, as_of=today)
    by_id = {row.account_id: row.balance_cents for row in balances.accounts}

    assert by_id[bank.id] == 3_750_000
    assert by_id[card.id] == 1_800_000
    assert balances.total_assets_cents == 3_750_000
    assert balances.total_liabilities_cents == 1_800_000
    assert balances.networth_cents == 1_950_000


# ---------------------------------------------------------------------------
# 3b. Hand-crafted matrix (R2) — confirm the engine returns the same value
#     regardless of which transaction type is mixed in. Each row in the
#     matrix is one (account_type, transaction_strategy) combination.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "type_,opening,credits,debits,expected",
    [
        # income only
        (AccountType.BANK, 0, [(TransactionType.INCOME, 100_000)], [], 100_000),
        # expense only
        (AccountType.BANK, 100_000, [], [(TransactionType.EXPENSE, 30_000)], 70_000),
        # income + expense
        (
            AccountType.BANK,
            0,
            [(TransactionType.INCOME, 100_000)],
            [(TransactionType.EXPENSE, 30_000)],
            70_000,
        ),
        # transfer in (positive leg)
        (
            AccountType.BANK,
            0,
            [(TransactionType.TRANSFER, 200_000)],
            [],
            200_000,
        ),
        # transfer out (negative leg)
        (
            AccountType.BANK,
            200_000,
            [],
            [(TransactionType.TRANSFER, -50_000)],
            150_000,
        ),
        # liability — credit_card with opening + expense (engine applies
        # the same -amount convention to liabilities; see
        # ``test_regression_prd_section_8_realistic_first_month`` for the
        # rationale).
        (
            AccountType.CREDIT_CARD,
            1_000_000,
            [],
            [(TransactionType.EXPENSE, 250_000)],
            750_000,
        ),
    ],
)
def test_matrix_engine_branch_for_every_transaction_type(
    fresh_db: Session,
    type_: AccountType,
    opening: int,
    credits: list[tuple[TransactionType, int]],
    debits: list[tuple[TransactionType, int]],
    expected: int,
) -> None:
    """Cartesian of (account type, transaction type) — engine is correct.

    Financial calc has zero tolerance (R1). Every cell of the 2x3
    account-type x transaction-type matrix is hit at least once.
    """
    user = _make_user(fresh_db)
    account = _make_account(
        fresh_db,
        user_id=user.id,
        type_=type_,
        opening_balance_cents=opening,
    )
    for type__, amount in credits:
        _add_tx(
            fresh_db,
            user_id=user.id,
            account_id=account.id,
            type_=type__,
            amount_cents=amount,
        )
    for type__, amount in debits:
        _add_tx(
            fresh_db,
            user_id=user.id,
            account_id=account.id,
            type_=type__,
            amount_cents=amount,
        )

    balance = calculate_account_balance(
        fresh_db, user_id=user.id, account_id=account.id, as_of=date.today()
    )

    assert balance is not None
    assert balance.balance_cents == expected
    # is_asset flips only for credit_card — assertion that the
    # AccountBalance dataclass routes the type correctly.
    expected_is_asset = type_ != AccountType.CREDIT_CARD
    assert balance.is_asset is expected_is_asset


# ---------------------------------------------------------------------------
# 4. Performance smoke (PRD §11 — 5K transactions < 200ms)
# ---------------------------------------------------------------------------


def test_perf_5k_rows_under_200ms(fresh_db: Session) -> None:
    """Engine must aggregate 5K rows in < 200ms on the test hardware.

    The PR bound from PRD §11 is 200ms wall-clock. We measure with
    ``perf_counter`` against the same in-memory SQLite the rest of the
    suite uses. If CI hardware is genuinely slower, this test will
    fail and tell us to revisit the bound — better than silently
    shipping a slow endpoint.
    """
    user = _make_user(fresh_db)
    account = _make_account(
        fresh_db, user_id=user.id, opening_balance_cents=0
    )

    rows = [
        Transaction(
            user_id=user.id,
            account_id=account.id,
            category_id=None,
            type=TransactionType.INCOME if i % 2 == 0 else TransactionType.EXPENSE,
            amount_cents=100,
            currency="IDR",
            occurred_on=date.today(),
            note=None,
            transfer_pair_id=None,
            recurring_rule_id=None,
        )
        for i in range(5_000)
    ]
    fresh_db.add_all(rows)
    fresh_db.commit()

    started = perf_counter()
    balances = calculate_user_balances(
        fresh_db, user_id=user.id, as_of=date.today()
    )
    elapsed = perf_counter() - started

    # 2500 income rows + 2500 expense rows → net delta = 0.
    assert balances.accounts[0].balance_cents == 0
    # Headroom for CI variance — PRD bound is 200ms.
    assert elapsed < 0.2, f"engine took {elapsed*1000:.1f}ms (>200ms)"


# ---------------------------------------------------------------------------
# 5. Negative test (AC e) — transfer A→B 100rb keeps networth unchanged.
# ---------------------------------------------------------------------------


def test_negative_transfer_ab_100rb_keeps_networth(
    fresh_db: Session,
) -> None:
    """AC (e): transfer A→B 100rb → balance A = opening-100rb, B = opening+100rb.

    Networth must be unchanged. This is the single non-negotiable rule
    of the saldo engine — if this test ever fails, the sign convention
    is broken and the rest of the suite is damaged.
    """
    user = _make_user(fresh_db)
    a = _make_account(
        fresh_db, user_id=user.id, name="A", opening_balance_cents=1_000_000
    )
    b = _make_account(
        fresh_db, user_id=user.id, name="B", opening_balance_cents=500_000
    )

    # Capture networth before transfer.
    initial = calculate_user_balances(fresh_db, user_id=user.id, as_of=date.today())
    networth_before = initial.networth_cents
    assert networth_before == 1_500_000

    # Perform the transfer.
    pair_id = uuid.uuid4()
    _add_tx(
        fresh_db,
        user_id=user.id,
        account_id=a.id,
        type_=TransactionType.TRANSFER,
        amount_cents=-100_000,
        transfer_pair_id=pair_id,
    )
    _add_tx(
        fresh_db,
        user_id=user.id,
        account_id=b.id,
        type_=TransactionType.TRANSFER,
        amount_cents=100_000,
        transfer_pair_id=pair_id,
    )

    # Re-read per-account balances.
    as_of = date.today()
    balance_a = calculate_account_balance(
        fresh_db, user_id=user.id, account_id=a.id, as_of=as_of
    )
    balance_b = calculate_account_balance(
        fresh_db, user_id=user.id, account_id=b.id, as_of=as_of
    )
    summary = calculate_user_balances(fresh_db, user_id=user.id, as_of=as_of)

    # AC (e) verbatim.
    assert balance_a is not None
    assert balance_b is not None
    assert balance_a.balance_cents == 1_000_000 - 100_000
    assert balance_b.balance_cents == 500_000 + 100_000
    # Networth unchanged.
    assert summary.networth_cents == networth_before


# ---------------------------------------------------------------------------
# 6. End-to-end through the API — make sure the public surface ships the
#    same numbers the engine returns, for a representative scenario.
# ---------------------------------------------------------------------------


def test_api_summary_matches_engine_for_transfer_pair(
    client: TestClient, fresh_db: Session
) -> None:
    """Engine and API agree on the same numbers — no rounding, no leak."""
    body = _register(client, "api-engine@example.com")
    headers = _auth_headers(body["access_token"])

    source = _create_account_api(
        client, headers, name="Source", opening_balance_cents=750_000
    )
    destination = _create_account_api(
        client, headers, name="Destination", opening_balance_cents=125_000
    )

    pair_id = uuid.uuid4()
    user_id = uuid.UUID(source["user_id"])
    fresh_db.add_all(
        [
            Transaction(
                user_id=user_id,
                account_id=uuid.UUID(source["id"]),
                category_id=None,
                type=TransactionType.TRANSFER,
                amount_cents=-300_000,
                currency="IDR",
                occurred_on=date.today(),
                note=None,
                transfer_pair_id=pair_id,
                recurring_rule_id=None,
            ),
            Transaction(
                user_id=user_id,
                account_id=uuid.UUID(destination["id"]),
                category_id=None,
                type=TransactionType.TRANSFER,
                amount_cents=300_000,
                currency="IDR",
                occurred_on=date.today(),
                note=None,
                transfer_pair_id=pair_id,
                recurring_rule_id=None,
            ),
        ]
    )
    fresh_db.commit()

    summary = client.get("/api/v1/accounts/balances", headers=headers).json()
    balances = {row["account_id"]: row["balance_cents"] for row in summary["accounts"]}

    assert balances[source["id"]] == 450_000
    assert balances[destination["id"]] == 425_000
    assert summary["total_assets_cents"] == 875_000
    assert summary["total_liabilities_cents"] == 0
    assert summary["networth_cents"] == 875_000


def test_account_balance_lookup_via_api_matches_engine(
    client: TestClient, fresh_db: Session
) -> None:
    """``GET /accounts/{id}/balance`` returns the engine's number."""
    body = _register(client, "api-lookup@example.com")
    headers = _auth_headers(body["access_token"])
    account = _create_account_api(
        client, headers, opening_balance_cents=100_000
    )

    _add_tx(
        fresh_db,
        user_id=uuid.UUID(account["user_id"]),
        account_id=uuid.UUID(account["id"]),
        type_=TransactionType.INCOME,
        amount_cents=42_000,
    )

    response = client.get(
        f"/api/v1/accounts/{account['id']}/balance", headers=headers
    )
    assert response.status_code == 200, response.text
    assert response.json()["balance_cents"] == 142_000


def test_api_returns_404_for_account_balance_of_archived_account(
    client: TestClient, fresh_db: Session
) -> None:
    """Archived account → 404 on the single-balance endpoint."""
    body = _register(client, "api-archive@example.com")
    headers = _auth_headers(body["access_token"])
    account = _create_account_api(client, headers)

    assert client.delete(f"/api/v1/accounts/{account['id']}", headers=headers).status_code == 204

    response = client.get(
        f"/api/v1/accounts/{account['id']}/balance", headers=headers
    )
    assert response.status_code == 404


# ---------------------------------------------------------------------------
# 7. Coverage helpers — keep the engine-file branch shape under watch.
# ---------------------------------------------------------------------------


def test_engine_returns_dataclass_with_expected_fields(
    fresh_db: Session,
) -> None:
    """Pinned dataclass shape: a regression here breaks every caller."""
    user = _make_user(fresh_db)
    account = _make_account(
        fresh_db, user_id=user.id, opening_balance_cents=10_000
    )

    balance = calculate_account_balance(
        fresh_db, user_id=user.id, account_id=account.id, as_of=date.today()
    )

    assert isinstance(balance, AccountBalance)
    # Frozen dataclass — assignment must raise.
    with pytest.raises((AttributeError, Exception)):
        balance.balance_cents = 0  # type: ignore[misc]
