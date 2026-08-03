from __future__ import annotations

import uuid
from collections.abc import Iterator

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.schemas import DebtCreate, DebtPublic, DebtUpdate
from app.api.v1.auth import get_current_user
from app.db.models.debt import Debt
from app.db.models.user import User
from app.db.session import get_session
from app.services.debt_calculator import calculate_flat_monthly_payment_cents

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
