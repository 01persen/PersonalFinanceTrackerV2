"""Flat interest calculator + read-side debt summary aggregations.

Scope: sub-0006-03 — the calculator half of the debt tracker. The write
side (recording payments, auto-paid-off transition) lives in
:mod:`app.services.debt_payments` (sub-0006-02). This module is the
read-side counterpart: a pure calculator for the flat monthly payment +
total interest, and the helper queries the summary endpoint uses to
surface "how much is left / how much interest has been paid".

Rounding rules (single source of truth, advertised in the epic-0006
acceptance criteria):

* All money math is in integer cents (``int``). The :class:`decimal.Decimal`
  is used only as an intermediate carrier to avoid float drift on the
  percentage multiplication. The API surface and the DB column are both
  ``int`` cents.
* ``total_interest_cents`` = ``principal * bunga_pct * tenor_months / 1200``
  rounded **half-up** to the nearest cent. Half-up is the financial
  convention used by the spreadsheet ``uangplanner.com`` that the spec
  references for the flat calculator; using ``ROUND_DOWN`` here would
  silently shave a cent off the borrower's total cost on a rounding
  edge case.
* ``monthly_payment_cents`` = ``(principal + total_interest) / tenor_months``
  rounded **down** to the nearest cent. Each installment is therefore
  never over-collected; any sub-cent remainder is absorbed into the
  final payment at write time by sub-0006-02's payment ledger.
* The remaining-principal / total-interest-paid helpers live in
  :mod:`app.services.debt_payments` (the write-side module) so the
  atomic ``status`` transition can reuse them without a cross-module
  import dance. This module re-exports them so the summary endpoint
  can stay single-import — see :func:`remaining_principal_cents` and
  :func:`total_interest_paid_cents` below.
"""

from __future__ import annotations

from decimal import ROUND_DOWN, ROUND_HALF_UP, Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models.debt import Debt, DebtPayment
from app.services.debt_payments import (
    remaining_principal_cents,
    total_interest_paid_cents,
)

__all__ = [
    "calculate_flat_monthly_payment_cents",
    "calculate_flat_total_interest_cents",
    "count_debt_payments",
    "remaining_principal_cents",
    "total_interest_paid_cents",
]


def calculate_flat_total_interest_cents(
    *,
    principal_cents: int,
    bunga_pct: Decimal,
    tenor_months: int,
) -> int:
    """Return the *scheduled* total interest for a flat loan, in cents.

    Formula: ``total_interest = principal * bunga_pct * tenor_months / 1200``.
    The ``/1200`` collapses the ``/ 100`` (percent → decimal) and the
    ``/ 12`` (annual rate → monthly share) into a single constant — see
    the module docstring for the rounding convention.

    Returns an ``int`` (cents). Half-up rounding: ``1.5 cents → 2 cents``,
    ``-1.5 cents → -1 cents`` (note ``ROUND_HALF_UP`` ties away from
    zero for positive inputs — finance convention; the borrower's loan
    is always positive principal here).

    Raises ``ValueError`` for invalid inputs — same contract as
    :func:`calculate_flat_monthly_payment_cents`.
    """
    if principal_cents <= 0:
        raise ValueError("principal_cents must be greater than 0")
    if not bunga_pct.is_finite() or bunga_pct < 0:
        raise ValueError("bunga_pct must be greater than or equal to 0")
    if tenor_months <= 0:
        raise ValueError("tenor_months must be greater than 0")

    principal = Decimal(principal_cents)
    tenor = Decimal(tenor_months)
    total_interest = principal * bunga_pct * tenor / Decimal(1200)
    return int(total_interest.to_integral_value(rounding=ROUND_HALF_UP))


def calculate_flat_monthly_payment_cents(
    *,
    principal_cents: int,
    bunga_pct: Decimal,
    tenor_months: int | None,
) -> int | None:
    """Return the flat monthly payment in cents, or ``None`` for nullable tenor.

    Flat formula: ``monthly = (principal + total_interest) / tenor_months``.
    The result is rounded **down** to the nearest cent so each
    installment is never over-collected — any sub-cent remainder is
    absorbed by the final payment via sub-0006-02's payment ledger
    (the FE never has to display fractional cents).

    See the module docstring for the rounding convention and the
    half-up/down rationale.

    Raises ``ValueError`` for invalid inputs (non-positive principal,
    negative / non-finite bunga_pct, non-positive tenor when tenor is
    not ``None``). The check order matches the persisted-row contract
    from sub-0006-01: a debt with ``tenor_months is None`` is allowed
    but its ``monthly_payment_cents`` will be ``None`` regardless of
    the other inputs.
    """
    if tenor_months is None:
        return None
    if principal_cents <= 0:
        raise ValueError("principal_cents must be greater than 0")
    if not bunga_pct.is_finite() or bunga_pct < 0:
        raise ValueError("bunga_pct must be greater than or equal to 0")
    if tenor_months <= 0:
        raise ValueError("tenor_months must be greater than 0")

    principal = Decimal(principal_cents)
    tenor = Decimal(tenor_months)
    total_interest = principal * bunga_pct * tenor / Decimal(1200)
    monthly_payment = (principal + total_interest) / tenor
    return int(monthly_payment.to_integral_value(rounding=ROUND_DOWN))


def count_debt_payments(*, db: Session, debt: Debt) -> int:
    """Return the number of persisted payment rows for ``debt``.

    Used by the summary endpoint to derive ``months_remaining`` and
    ``next_payment_due_date`` from the tenor — one payment row
    corresponds to one monthly cycle under the flat-schedule model.
    Counting distinct months instead of rows would be more accurate
    for over-paying users (multiple payments in the same month
    shouldn't shrink ``months_remaining`` twice) but sub-0006-02's
    over-payment guard rejects that pattern at write time, so the
    simple row count is exact for the MVP.
    """
    return int(
        db.execute(
            select(func.count(DebtPayment.id)).where(DebtPayment.debt_id == debt.id)
        ).scalar_one()
    )
