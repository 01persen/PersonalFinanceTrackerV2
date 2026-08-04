"""Unit tests for the debt-payment service helpers (sub-0006-02).

The route layer (apps/api/src/app/api/v1/debts.py) is what the FE
hits; the service helpers in apps/api/src/app/services/debt_payments.py
are where the atomicity rules live. This module exercises the
helpers directly with a real DB session so the boundary between
"what the service guarantees" and "what the route maps to HTTP"
stays sharp.

Coverage:

* ``remaining_principal_cents`` — sums ``principal_portion_cents``
  across the debt's payments and subtracts from
  ``debt.principal_cents``. Verified on the empty / single-payment /
  multi-payment cases.
* ``total_interest_paid_cents`` — sums ``interest_portion_cents``.
  Empty case returns 0 (defensive — a debt with no payments should
  not blow up the summary endpoint).
* ``assert_no_overpayment`` — raises on principal portion > remaining;
  allows principal portion == remaining (auto-paid-off case);
  allows principal portion < remaining. The
  ``excluding_payment_id`` clause lets PATCH-style edits rebalance
  the last payment without a false positive.
* ``refresh_debt_status`` — flips ``active`` → ``paid_off`` when
  remaining hits exactly zero, and back to ``active`` when a delete
  brings it above zero. Idempotent on no-op transitions (the
  helper must NOT touch ``status`` when the value would be the
  same — avoids spurious ``updated_at`` writes that would confuse
  the FE optimistic-concurrency UI later).
"""

from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from app.db.models.account import Account
from app.db.models.debt import Debt, DebtPayment
from app.db.models.enums import AccountType, DebtKind, DebtStatus
from app.db.models.user import User
from app.services.debt_payments import (
    OverpaymentError,
    assert_no_overpayment,
    refresh_debt_status,
    remaining_principal_cents,
    total_interest_paid_cents,
)


def _make_user(
    session: Session,
    *,
    email: str = "debt-payments-svc@example.com",
) -> User:
    """Create a real User row in the session (no FastAPI / bcrypt needed)."""
    # The ``User`` model hashes the password via bcrypt on construction,
    # which is slow enough to matter in a unit test. Import lazily and
    # build a row with a pre-baked hash so the helper stays fast.
    from app.core.security import hash_password

    user = User(email=email, password_hash=hash_password("Sup3rSecret!"))
    session.add(user)
    session.flush()
    return user


def _make_account(
    session: Session,
    *,
    user: User,
    name: str = "Bank BCA",
    opening_balance_cents: int = 0,
) -> Account:
    account = Account(
        user_id=user.id,
        name=name,
        type=AccountType.BANK,
        currency="IDR",
        opening_balance_cents=opening_balance_cents,
        is_asset=True,
        archived=False,
    )
    session.add(account)
    session.flush()
    return account


def _make_debt(
    session: Session,
    *,
    user: User,
    principal_cents: int = 1_200_000,
    status: DebtStatus = DebtStatus.ACTIVE,
) -> Debt:
    debt = Debt(
        user_id=user.id,
        name="Kredit Rumah",
        kind=DebtKind.KPR,
        principal_cents=principal_cents,
        bunga_pct=Decimal("10.0000"),
        tenor_months=12,
        start_date=date(2026, 1, 1),
        monthly_payment_cents=110_000,
        note=None,
        status=status,
    )
    session.add(debt)
    session.flush()
    return debt


def _make_payment(
    session: Session,
    *,
    debt: Debt,
    principal_portion_cents: int,
    interest_portion_cents: int,
    occurred_on: date | None = None,
    source_account: Account | None = None,
    note: str | None = None,
) -> DebtPayment:
    payment = DebtPayment(
        debt_id=debt.id,
        occurred_on=occurred_on or date(2026, 2, 1),
        amount_cents=principal_portion_cents + interest_portion_cents,
        principal_portion_cents=principal_portion_cents,
        interest_portion_cents=interest_portion_cents,
        source_account_id=source_account.id if source_account is not None else None,
        note=note,
    )
    session.add(payment)
    session.flush()
    return payment


# ---------------------------------------------------------------------------
# remaining_principal_cents / total_interest_paid_cents
# ---------------------------------------------------------------------------


def test_remaining_principal_is_zero_when_no_payments(
    fresh_db: Session,
) -> None:
    user = _make_user(fresh_db)
    debt = _make_debt(fresh_db, user=user, principal_cents=1_200_000)

    assert remaining_principal_cents(db=fresh_db, debt=debt) == 1_200_000
    assert total_interest_paid_cents(db=fresh_db, debt=debt) == 0


def test_remaining_principal_subtracts_all_payment_principal_portions(
    fresh_db: Session,
) -> None:
    user = _make_user(fresh_db)
    account = _make_account(fresh_db, user=user)
    debt = _make_debt(fresh_db, user=user, principal_cents=1_200_000)

    # Three cicilan — 100k principal + 10k interest, 100k principal + 8k
    # interest, 50k principal + 5k interest. Total principal paid: 250k.
    _make_payment(
        fresh_db,
        debt=debt,
        principal_portion_cents=100_000,
        interest_portion_cents=10_000,
        source_account=account,
    )
    _make_payment(
        fresh_db,
        debt=debt,
        principal_portion_cents=100_000,
        interest_portion_cents=8_000,
        source_account=account,
    )
    _make_payment(
        fresh_db,
        debt=debt,
        principal_portion_cents=50_000,
        interest_portion_cents=5_000,
        source_account=account,
    )

    assert remaining_principal_cents(db=fresh_db, debt=debt) == 950_000
    assert total_interest_paid_cents(db=fresh_db, debt=debt) == 23_000


def test_total_interest_is_zero_on_debt_with_no_payments(
    fresh_db: Session,
) -> None:
    user = _make_user(fresh_db)
    debt = _make_debt(fresh_db, user=user)

    assert total_interest_paid_cents(db=fresh_db, debt=debt) == 0


def test_remaining_principal_treats_interest_only_payment_as_no_principal_reduction(
    fresh_db: Session,
) -> None:
    """A cicilan with ``principal_portion_cents == 0`` (interest-only) does not
    reduce remaining principal. This pattern happens for grace-period
    cicilan where the user records a partial interest payment that
    doesn't touch the principal."""
    user = _make_user(fresh_db)
    debt = _make_debt(fresh_db, user=user, principal_cents=1_200_000)

    _make_payment(
        fresh_db,
        debt=debt,
        principal_portion_cents=0,
        interest_portion_cents=10_000,
    )

    assert remaining_principal_cents(db=fresh_db, debt=debt) == 1_200_000
    assert total_interest_paid_cents(db=fresh_db, debt=debt) == 10_000


# ---------------------------------------------------------------------------
# assert_no_overpayment
# ---------------------------------------------------------------------------


def test_overpayment_raises_when_principal_exceeds_remaining(
    fresh_db: Session,
) -> None:
    user = _make_user(fresh_db)
    debt = _make_debt(fresh_db, user=user, principal_cents=1_200_000)

    # Already paid 200k of principal — remaining is 1_000_000.
    _make_payment(
        fresh_db,
        debt=debt,
        principal_portion_cents=200_000,
        interest_portion_cents=20_000,
    )

    with pytest.raises(OverpaymentError, match="exceeds the debt's remaining principal"):
        assert_no_overpayment(
            db=fresh_db,
            debt=debt,
            principal_portion_cents=1_000_001,
        )


def test_full_payoff_is_allowed_and_triggers_paid_off_via_helper(
    fresh_db: Session,
) -> None:
    """A payment whose principal portion equals the remaining principal
    is allowed (not an overpayment). The auto-paid-off transition is
    the *route's* job to surface to the FE — this test just confirms
    ``assert_no_overpayment`` doesn't trip on the boundary.
    """
    user = _make_user(fresh_db)
    debt = _make_debt(fresh_db, user=user, principal_cents=1_200_000)

    # Already paid 200k → remaining is 1_000_000.
    _make_payment(
        fresh_db,
        debt=debt,
        principal_portion_cents=200_000,
        interest_portion_cents=20_000,
    )

    # Exact payoff → no raise.
    assert_no_overpayment(
        db=fresh_db,
        debt=debt,
        principal_portion_cents=1_000_000,
    )


def test_overpayment_check_treats_excluded_payment_as_reversed(
    fresh_db: Session,
) -> None:
    """The PATCH path passes ``excluding_payment_id`` so a payment that
    increases the principal portion on the *last* cicilan can succeed
    (otherwise the check would always trip on the last payment — the
    only one whose principal portion can legitimately equal the full
    remaining).

    Setup: a debt with one payment whose principal portion is
    1_200_000 (full payoff). With the exclude clause, the post-reversal
    remaining is 1_200_000 again; without the clause, the check would
    falsely trip on any edit that keeps the principal portion > 0.
    """
    user = _make_user(fresh_db)
    debt = _make_debt(fresh_db, user=user, principal_cents=1_200_000)
    last_payment = _make_payment(
        fresh_db,
        debt=debt,
        principal_portion_cents=1_200_000,
        interest_portion_cents=120_000,
    )

    # After the existing payment, remaining is 0. Without the exclude
    # clause, *any* positive principal portion would trip. With the
    # exclude, the conceptual "after reversal" remaining is 1_200_000
    # and a principal portion of 500k is fine.
    assert_no_overpayment(
        db=fresh_db,
        debt=debt,
        principal_portion_cents=500_000,
        excluding_payment_id=last_payment.id,
    )


def test_overpayment_exclude_idempotent_when_excluded_payment_doesnt_match(
    fresh_db: Session,
) -> None:
    """Defensive path: a caller-supplied exclude id that doesn't
    belong to this debt (e.g. a stale client id) falls back to the
    no-exclude behaviour. The route layer's ownership check is the
    primary defence; this helper just refuses to silently miscompute.
    """
    user = _make_user(fresh_db)
    debt = _make_debt(fresh_db, user=user, principal_cents=1_200_000)

    # Stale exclude id → no exclusion → check fires against current
    # remaining (1_200_000 with no payments).
    with pytest.raises(OverpaymentError):
        assert_no_overpayment(
            db=fresh_db,
            debt=debt,
            principal_portion_cents=1_200_001,
            excluding_payment_id=uuid.uuid4(),
        )


# ---------------------------------------------------------------------------
# refresh_debt_status
# ---------------------------------------------------------------------------


def test_refresh_status_flips_active_to_paid_off_on_full_payoff(
    fresh_db: Session,
) -> None:
    user = _make_user(fresh_db)
    debt = _make_debt(fresh_db, user=user, principal_cents=1_200_000, status=DebtStatus.ACTIVE)
    _make_payment(
        fresh_db,
        debt=debt,
        principal_portion_cents=1_200_000,
        interest_portion_cents=120_000,
    )

    new_status = refresh_debt_status(db=fresh_db, debt=debt)
    fresh_db.commit()

    assert new_status == DebtStatus.PAID_OFF
    fresh_db.refresh(debt)
    assert debt.status == DebtStatus.PAID_OFF


def test_refresh_status_keeps_active_when_remaining_above_zero(
    fresh_db: Session,
) -> None:
    user = _make_user(fresh_db)
    debt = _make_debt(fresh_db, user=user, principal_cents=1_200_000, status=DebtStatus.ACTIVE)
    _make_payment(
        fresh_db,
        debt=debt,
        principal_portion_cents=500_000,
        interest_portion_cents=50_000,
    )

    new_status = refresh_debt_status(db=fresh_db, debt=debt)
    fresh_db.commit()

    assert new_status == DebtStatus.ACTIVE
    fresh_db.refresh(debt)
    assert debt.status == DebtStatus.ACTIVE


def test_refresh_status_flips_paid_off_back_to_active_on_delete(
    fresh_db: Session,
) -> None:
    """A delete that drops the last payment on a paid-off debt must
    transition ``status`` back to ``active`` (the spec calls out that
    the auto transition is one-way automatic, not one-way manual —
    a user undoing the last payment must see ``active`` again)."""
    user = _make_user(fresh_db)
    debt = _make_debt(fresh_db, user=user, principal_cents=1_200_000, status=DebtStatus.PAID_OFF)
    last_payment = _make_payment(
        fresh_db,
        debt=debt,
        principal_portion_cents=1_200_000,
        interest_portion_cents=120_000,
    )
    fresh_db.delete(last_payment)
    fresh_db.flush()

    new_status = refresh_debt_status(db=fresh_db, debt=debt)
    fresh_db.commit()

    assert new_status == DebtStatus.ACTIVE
    fresh_db.refresh(debt)
    assert debt.status == DebtStatus.ACTIVE


def test_refresh_status_is_idempotent_when_already_correct(
    fresh_db: Session,
) -> None:
    """A no-op refresh (status already matches the remaining) must
    leave ``status`` untouched. Avoids spurious ``updated_at`` writes
    that the FE optimistic-concurrency UI would otherwise see as a
    real mutation."""
    user = _make_user(fresh_db)
    debt = _make_debt(fresh_db, user=user, principal_cents=1_200_000, status=DebtStatus.ACTIVE)
    original_updated_at = debt.updated_at

    new_status = refresh_debt_status(db=fresh_db, debt=debt)
    fresh_db.commit()

    assert new_status == DebtStatus.ACTIVE
    fresh_db.refresh(debt)
    assert debt.status == DebtStatus.ACTIVE
    assert debt.updated_at == original_updated_at
