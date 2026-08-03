from __future__ import annotations

import uuid
from calendar import monthrange
from collections.abc import Iterator
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.schemas import DebtCreate, DebtPublic, DebtSummaryPublic, DebtUpdate
from app.api.v1.auth import get_current_user
from app.db.models.debt import Debt
from app.db.models.user import User
from app.db.session import get_session
from app.services.debt_calculator import (
    calculate_flat_monthly_payment_cents,
    count_debt_payments,
    remaining_principal_cents,
    total_interest_paid_cents,
)

router = APIRouter(prefix="/debts", tags=["debts"])


def get_db() -> Iterator[Session]:
    yield from get_session()


def _get_owned_debt(db: Session, *, debt_id: uuid.UUID, current_user: User) -> Debt:
    debt = db.get(Debt, debt_id)
    if debt is None or debt.user_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="debt not found",
        )
    return debt


@router.post("", response_model=DebtPublic, status_code=status.HTTP_201_CREATED)
def create_debt(
    payload: DebtCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DebtPublic:
    debt = Debt(
        user_id=current_user.id,
        name=payload.name,
        kind=payload.kind,
        principal_cents=payload.principal_cents,
        bunga_pct=payload.bunga_pct,
        tenor_months=payload.tenor_months,
        start_date=payload.start_date,
        monthly_payment_cents=calculate_flat_monthly_payment_cents(
            principal_cents=payload.principal_cents,
            bunga_pct=payload.bunga_pct,
            tenor_months=payload.tenor_months,
        ),
        note=payload.note,
        status=payload.status,
    )
    db.add(debt)
    db.commit()
    db.refresh(debt)
    return DebtPublic.model_validate(debt)


@router.get("", response_model=list[DebtPublic])
def list_debts(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[DebtPublic]:
    debts = list(
        db.execute(
            select(Debt)
            .where(Debt.user_id == current_user.id)
            .order_by(Debt.start_date.desc(), Debt.created_at.desc(), Debt.id.asc())
        ).scalars()
    )
    return [DebtPublic.model_validate(debt) for debt in debts]


@router.get("/{debt_id}", response_model=DebtPublic)
def get_debt(
    debt_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DebtPublic:
    debt = _get_owned_debt(db, debt_id=debt_id, current_user=current_user)
    return DebtPublic.model_validate(debt)


@router.patch("/{debt_id}", response_model=DebtPublic)
def update_debt(
    debt_id: uuid.UUID,
    payload: DebtUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DebtPublic:
    debt = _get_owned_debt(db, debt_id=debt_id, current_user=current_user)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(debt, field, value)
    debt.monthly_payment_cents = calculate_flat_monthly_payment_cents(
        principal_cents=debt.principal_cents,
        bunga_pct=debt.bunga_pct,
        tenor_months=debt.tenor_months,
    )
    db.commit()
    db.refresh(debt)
    return DebtPublic.model_validate(debt)


@router.delete(
    "/{debt_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
def delete_debt(
    debt_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    debt = _get_owned_debt(db, debt_id=debt_id, current_user=current_user)
    db.delete(debt)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _add_months(start: date, months: int) -> date:
    """Advance ``start`` by ``months`` calendar months, clamping the day.

    Mirrors the convention used elsewhere in the API so a start date
    of ``2026-01-31`` plus one month becomes ``2026-02-28`` (or
    ``2026-02-29`` in a leap year) — never the nonsensical
    ``2026-02-31`` that :py:meth:`datetime.replace` would silently
    produce. Clamping matches Python's :func:`calendar.monthrange`
    behavior: ``min(start.day, last_day_of_target_month)``.
    """
    if months <= 0:
        return start
    target_month_index = (start.month - 1) + months
    year = start.year + target_month_index // 12
    month = target_month_index % 12 + 1
    last_day = monthrange(year, month)[1]
    return date(year, month, min(start.day, last_day))


@router.get("/{debt_id}/summary", response_model=DebtSummaryPublic)
def get_debt_summary(
    debt_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DebtSummaryPublic:
    """Return the live aggregate view of a debt for the dashboard.

    Aggregates four numbers in one round-trip so the FE "ringkasan
    utang" card (sub-0006-04) doesn't have to fan-out into multiple
    GETs. The four fields:

    * ``remaining_principal_cents`` — current outstanding principal.
    * ``total_interest_paid_cents`` — sum of all payment interest
      portions so far.
    * ``next_payment_due_date`` — ``start_date + paid_count months``;
      ``null`` when no schedule (``tenor_months is None``) or fully
      paid.
    * ``months_remaining`` — ``tenor_months - paid_count``; ``null``
      when no schedule, ``0`` when fully paid.

    Authorization matches the other item-level routes: 404 for both
    "no such debt" and "owned by another user" — the same pattern as
    the CRUD endpoints landed in sub-0006-01, kept consistent within
    this router rather than diverging to a 403 (see TL handoff note
    on the issue).
    """
    debt = _get_owned_debt(db, debt_id=debt_id, current_user=current_user)

    remaining = remaining_principal_cents(db=db, debt=debt)
    interest_paid = total_interest_paid_cents(db=db, debt=debt)
    payment_count = count_debt_payments(db=db, debt=debt)

    tenor = debt.tenor_months
    if tenor is None:
        next_due: date | None = None
        months_remaining: int | None = None
    elif remaining == 0:
        next_due = None
        months_remaining = 0
    else:
        next_due = _add_months(debt.start_date, payment_count)
        months_remaining = max(0, tenor - payment_count)

    return DebtSummaryPublic(
        debt_id=debt.id,
        remaining_principal_cents=remaining,
        total_interest_paid_cents=interest_paid,
        next_payment_due_date=next_due,
        months_remaining=months_remaining,
    )
