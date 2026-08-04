"""Debt payment business logic — atomic balance / status transitions.

Scope: sub-0006-02. The route layer calls into this module so the
write endpoints share one atomicity contract:

* ``record_payment`` — insert a new payment, then refresh the debt's
  ``status`` flag based on the new remaining principal (auto-paid-off
  when the principal portion sums to ``debt.principal_cents``).
* ``update_payment`` — reverse the old payment's effect and apply the
  new one, then refresh ``status`` the same way. Used by PATCH so a
  user can correct the principal / interest split without leaving the
  debt in an inconsistent state mid-edit.
* ``delete_payment`` — reverse the old payment's effect and refresh
  ``status`` the same way. A delete that brings a previously
  paid-off debt back above zero flips ``status`` back to ``active``
  (the spec calls out that auto-paid-off is a one-way *automatic*
  transition; a user undoing the last payment via delete must see
  ``active`` again).

Validation:

* ``assert_no_overpayment`` — the principal portion of a payment must
  not exceed the debt's remaining principal at write time. The check
  runs against the *current* remaining (i.e. after any prior payments
  recorded by the caller), not against ``debt.principal_cents`` — so
  the second payment on a 12jt loan can't be 12jt again. Surfaced as
  ``OverpaymentError`` so the route layer can map it to 422.
* The route layer enforces debt ownership + active status + non-zero
  amount — those checks live with the HTTP boundary (they need the
  current user / debt id), not here.

The read-side summary helpers (``remaining_principal_cents``,
``total_interest_paid_cents``) live here too so both the write path
and the future summary endpoint (sub-0006-03) read from the same
single-source-of-truth function. Mirrors how the goal engine
(``app.services.goal_engine``) exposes both compute and write paths.
"""

from __future__ import annotations

import uuid

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.models.debt import Debt, DebtPayment
from app.db.models.enums import DebtStatus


class OverpaymentError(ValueError):
    """Raised when a payment's principal portion exceeds the remaining principal.

    Surfaced as 422 by the route layer — a payment that would pay down
    more principal than is currently outstanding cannot be applied.
    A payment that brings the remaining to *exactly* zero is fine
    (and triggers the auto-paid-off transition).
    """


def remaining_principal_cents(*, db: Session, debt: Debt) -> int:
    """Return ``debt.principal_cents`` minus the sum of all payment principal portions.

    The result is the *current* outstanding principal — the number the
    debt-status flag is derived from. Computed at request time so the
    value is always consistent with the persisted payment rows (no
    denormalised counter that can drift from a buggy delete / partial
    update).

    Clamped to ``>= 0`` so the summary endpoint can use
    ``remaining == 0`` as the "fully paid" sentinel without guarding
    against negative values that over-payment drift could otherwise
    introduce. The write-side overpayment guard
    (:func:`assert_no_overpayment`) rejects payments that would push
    the remaining negative, so the clamp is purely defensive — a
    second line of defence against a buggy direct-SQL insert.
    """
    total_paid = int(
        db.execute(
            select(func.coalesce(func.sum(DebtPayment.principal_portion_cents), 0)).where(
                DebtPayment.debt_id == debt.id
            )
        ).scalar_one()
    )
    remaining = int(debt.principal_cents) - total_paid
    return remaining if remaining > 0 else 0


def total_interest_paid_cents(*, db: Session, debt: Debt) -> int:
    """Return the sum of ``interest_portion_cents`` across all the debt's payments.

    Used by the future summary endpoint (sub-0006-03). Computed at
    request time for the same drift-avoidance reason as
    :func:`remaining_principal_cents`.
    """
    total = int(
        db.execute(
            select(func.coalesce(func.sum(DebtPayment.interest_portion_cents), 0)).where(
                DebtPayment.debt_id == debt.id
            )
        ).scalar_one()
    )
    return total


def assert_no_overpayment(
    *,
    db: Session,
    debt: Debt,
    principal_portion_cents: int,
    excluding_payment_id: uuid.UUID | None = None,
) -> None:
    """Raise :class:`OverpaymentError` if the principal portion exceeds the remaining.

    ``excluding_payment_id`` lets the PATCH path compute "what the
    remaining would be *after* the old payment is conceptually
    reversed" — without the exclude clause, a PATCH that increases the
    principal portion on a debt whose remaining exactly equals the old
    payment's principal portion would falsely trip the overpayment
    check. The exclude rule is the canonical "you're replacing an
    existing payment" semantics.

    Edge cases:

    * ``principal_portion_cents == remaining`` is allowed (auto-paid-off).
    * ``principal_portion_cents < remaining`` is allowed (partial payment).
    * ``principal_portion_cents > remaining`` is rejected.
    """
    if excluding_payment_id is None:
        current_remaining = remaining_principal_cents(db=db, debt=debt)
    else:
        # The old payment's principal portion is the only thing standing
        # between ``current_remaining`` and the post-reversal figure; the
        # rest of the history is unchanged.
        old_payment = db.get(DebtPayment, excluding_payment_id)
        if old_payment is None or old_payment.debt_id != debt.id:
            # Defensive — the caller shouldn't pass a payment id that
            # doesn't belong to this debt. Treat as "no exclude" so
            # the route layer's ownership check (which runs first) is
            # the single source of truth for foreign-id detection.
            current_remaining = remaining_principal_cents(db=db, debt=debt)
        else:
            current_remaining = remaining_principal_cents(db=db, debt=debt) + int(
                old_payment.principal_portion_cents
            )
    if principal_portion_cents > current_remaining:
        raise OverpaymentError(
            f"principal_portion_cents ({principal_portion_cents}) exceeds the debt's "
            f"remaining principal ({current_remaining})"
        )


def refresh_debt_status(*, db: Session, debt: Debt) -> DebtStatus:
    """Recompute the debt's ``status`` from the current remaining principal.

    Called by every write path after the payment table has been mutated
    (insert / update / delete). The rule is straightforward: when the
    remaining principal is exactly zero the debt is ``paid_off``;
    otherwise it's ``active``. Mirrors the spec's
    "auto-update ``status = paid_off`` saat remaining_principal = 0"
    line and is the *only* path that mutates ``debt.status`` so the
    flag can never drift from the persisted payment history.

    Returns the new status so the caller can decide whether to
    include a note in any debug log without a second DB roundtrip.
    """
    new_status = (
        DebtStatus.PAID_OFF
        if remaining_principal_cents(db=db, debt=debt) == 0
        else DebtStatus.ACTIVE
    )
    if debt.status != new_status:
        debt.status = new_status
    return new_status
