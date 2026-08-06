"""Debts endpoints — CRUD for the authenticated user's debts and payments.

Scope: sub-0006-01 (debt CRUD) + sub-0006-02 (debt payment CRUD + auto
paid-off). Conventions follow :mod:`app.api.v1.accounts`
(per-router ``get_db`` re-export, ``HTTPBearer`` via
``get_current_user``, auth-scoped queries that never read across
users, 404 instead of 403 for ``not yours`` payloads).

Validation rules (sub-0006-01, AC):

* ``kind`` accepts ``loan`` / ``credit_card`` / ``paylater`` / ``KTA``
  / ``KKB`` / ``KPR`` / ``other``.
* ``principal_cents > 0`` (Pydantic ``gt=0`` → 422).
* ``bunga_pct >= 0`` (Pydantic ``ge=0`` → 422).
* ``tenor_months`` is positive int or null (422 otherwise).
* ``monthly_payment_cents`` is server-computed from the flat-interest
  formula and is never editable through the API (the create schema
  rejects the field as ``extra="forbid"``).

Debt payment contracts (sub-0006-02, AC):

* Payment CRUD lives under ``/debts/{debt_id}/payments``.
* ``amount_cents > 0``, ``principal_portion_cents >= 0``,
  ``interest_portion_cents >= 0``, and the two portions sum to
  ``amount_cents`` (422 otherwise — Pydantic validator).
* The route rejects overpayment (422): the principal portion must
  not exceed the debt's remaining principal at write time. A payment
  that brings the remaining to *exactly* zero is allowed and
  triggers the auto-paid-off transition.
* Source account is optional (nullable FK to ``accounts.id``). When
  set, the account must belong to the caller (404 otherwise).
* The debt must be ``active`` — payments on a ``paid_off`` debt
  return 422 (the status only flips back via delete / update).
* Every write path is one ``db.commit()`` — the insert + the
  ``status`` refresh land atomically, so a partial failure rolls
  back the payment row too.

The auto-paid-off transition is owned by the
:mod:`app.services.debt_payments` module so the same rule applies to
create / update / delete uniformly.
"""

from __future__ import annotations

import uuid
from calendar import monthrange
from collections.abc import Iterator
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.schemas import (
    DebtCreate,
    DebtPaymentCreate,
    DebtPaymentListPublic,
    DebtPaymentPublic,
    DebtPaymentUpdate,
    DebtPublic,
    DebtSummaryPublic,
    DebtUpdate,
)
from app.api.v1.auth import get_current_user
from app.db.models.account import Account
from app.db.models.debt import Debt, DebtPayment
from app.db.models.enums import DebtStatus
from app.db.models.user import User
from app.db.session import get_session
from app.services import dashboard_cache
from app.services.debt_calculator import (
    calculate_flat_monthly_payment_cents,
    count_debt_payments,
)
from app.services.debt_payments import (
    OverpaymentError,
    assert_no_overpayment,
    refresh_debt_status,
    remaining_principal_cents,
    total_interest_paid_cents,
)

router = APIRouter(prefix="/debts", tags=["debts"])


def get_db() -> Iterator[Session]:
    yield from get_session()


def _get_owned_debt(
    db: Session,
    *,
    debt_id: uuid.UUID,
    current_user: User,
    include_paid_off: bool = True,
) -> Debt:
    """Load ``debt_id`` and assert it belongs to the caller.

    404 (not 403) when the row doesn't exist or belongs to another user
    so the endpoint doesn't leak the existence of foreign debt IDs —
    mirrors the accounts / transactions / categories routers.
    """
    debt = db.get(Debt, debt_id)
    if debt is None or debt.user_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="debt not found",
        )
    if not include_paid_off and debt.status == DebtStatus.PAID_OFF:
        # The write endpoints reject payments on a paid-off debt with
        # 422 (the spec calls this out explicitly). The GET endpoints
        # surface the debt regardless — the FE history view needs to
        # see the cicilan rows that triggered the paid-off flip.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"debt {debt.id} is already paid_off; new payments are not allowed "
                "(delete an existing payment to bring the remaining principal above zero)"
            ),
        )
    return debt


def _get_owned_source_account(
    db: Session,
    *,
    source_account_id: uuid.UUID,
    current_user: User,
) -> Account:
    """Load ``source_account_id`` and assert it belongs to the caller.

    Archived accounts surface as 404 (the same rule the transactions
    router applies — see :mod:`app.api.v1.transactions`). A
    soft-deleted account is invisible to the debt-payment writer, so
    the FE can't accidentally route a new cicilan through a stale id.
    """
    account = db.get(Account, source_account_id)
    if account is None or account.user_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="account not found",
        )
    if account.archived:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="account not found",
        )
    return account


def _get_owned_payment(
    db: Session,
    *,
    debt_id: uuid.UUID,
    payment_id: uuid.UUID,
) -> DebtPayment:
    """Load a payment and assert it belongs to ``debt_id``.

    Debt ownership is checked by the caller via :func:`_get_owned_debt`
    *before* this helper runs (the 404 for a foreign debt is part of
    the spec — not leaking the existence of another user's debt).
    This helper just enforces that the payment id is a child of the
    requested debt id; a payment id that belongs to a different debt
    of the same user surfaces as 404 (the path-based debt id is part
    of the URL, so the FE knows the resource it was trying to
    reach is not visible from here).
    """
    payment = db.get(DebtPayment, payment_id)
    if payment is None or payment.debt_id != debt_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="payment not found",
        )
    return payment


# --- Debt CRUD (sub-0006-01) ------------------------------------------------


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
    # sub-0007-01 — invalidate dashboard cache for the ``debts``
    # table. The two affected endpoints are ``/summary`` (a brand-new
    # debt affects the liabilities bucket only if the user already
    # has credit-card accounts; safe to refresh either way) and
    # ``/debts-summary`` (every new debt rolls up into the totals).
    dashboard_cache.invalidate_for_table(user_id=current_user.id, table="debts")
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
    # sub-0007-01 — same invalidation as the create path: principal /
    # bunga_pct / tenor / status all roll up into the debts-summary
    # totals and the summary's liabilities bucket.
    dashboard_cache.invalidate_for_table(user_id=current_user.id, table="debts")
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
    # sub-0007-01 — debt delete is hard (the row vanishes; cascade
    # drops the payments), so the debts-summary + summary endpoints
    # must both refresh.
    dashboard_cache.invalidate_for_table(user_id=current_user.id, table="debts")
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


# --- Debt payments (sub-0006-02) --------------------------------------------


@router.post(
    "/{debt_id}/payments",
    response_model=DebtPaymentPublic,
    status_code=status.HTTP_201_CREATED,
)
def create_debt_payment(
    debt_id: uuid.UUID,
    payload: DebtPaymentCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DebtPaymentPublic:
    """Record a cicilan against the debt.

    Atomicity contract (sub-0006-02 AC): the insert + the
    ``status`` refresh run in a single ``db.commit()`` so a partial
    failure rolls back the payment row too. If anything in the
    pre-insert validation raises (overpayment, paid-off debt, missing
    source account) the route returns the matching HTTP error
    without touching the DB.

    The status refresh is owned by
    :func:`app.services.debt_payments.refresh_debt_status` so the
    same rule applies to create / update / delete uniformly.
    """
    debt = _get_owned_debt(db, debt_id=debt_id, current_user=current_user, include_paid_off=False)
    if payload.source_account_id is not None:
        _get_owned_source_account(
            db,
            source_account_id=payload.source_account_id,
            current_user=current_user,
        )

    try:
        assert_no_overpayment(
            db=db,
            debt=debt,
            principal_portion_cents=payload.principal_portion_cents,
        )
    except OverpaymentError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc

    payment = DebtPayment(
        debt_id=debt.id,
        occurred_on=payload.occurred_on,
        amount_cents=payload.amount_cents,
        principal_portion_cents=payload.principal_portion_cents,
        interest_portion_cents=payload.interest_portion_cents,
        source_account_id=payload.source_account_id,
        note=payload.note,
    )
    db.add(payment)
    db.flush()  # need ``payment.id`` in case the status refresh reads it back

    refresh_debt_status(db=db, debt=debt)

    db.commit()
    db.refresh(payment)
    # sub-0007-01 — a payment changes both ``remaining_principal_cents``
    # and ``total_interest_paid_cents`` for its parent debt, so the
    # debts-summary endpoint's totals shift. Invalidate the ``debts``
    # bucket (which maps to ``summary`` + ``debts-summary``).
    dashboard_cache.invalidate_for_table(user_id=current_user.id, table="debts")
    return DebtPaymentPublic.model_validate(payment)


@router.get(
    "/{debt_id}/payments",
    response_model=DebtPaymentListPublic,
)
def list_debt_payments(
    debt_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    limit: int = Query(
        default=50,
        ge=1,
        le=200,
        description="Page size. Default 50, max 200.",
    ),
    offset: int = Query(
        default=0,
        ge=0,
        description="Number of rows to skip from the start of the filtered result.",
    ),
) -> DebtPaymentListPublic:
    """List the debt's cicilan rows (paginated, newest first).

    The sort chain is ``occurred_on DESC, created_at DESC, id ASC``.
    The ``created_at`` second-key is a deliberate tiebreaker — two
    payments on the same date would otherwise order randomly by UUID
    (the sub-0004-00 flake carry-over); the deterministic
    ``created_at`` + ``id`` chain keeps the result stable across
    requests. The ``id`` tiebreaker handles the edge case where two
    rows share a ``created_at`` to the second (SQLite timestamp
    precision).

    Cross-user isolation: ``debt.user_id == current_user.id`` is the
    load-bearing predicate; a foreign debt id surfaces as 404 (via
    :func:`_get_owned_debt`) before the list query runs.
    """
    _get_owned_debt(db, debt_id=debt_id, current_user=current_user)

    base_where = [DebtPayment.debt_id == debt_id]

    total = db.execute(
        select(func.count()).select_from(DebtPayment).where(*base_where)
    ).scalar_one()

    rows = list(
        db.execute(
            select(DebtPayment)
            .where(*base_where)
            .order_by(
                DebtPayment.occurred_on.desc(),
                DebtPayment.created_at.desc(),
                DebtPayment.id.asc(),
            )
            .limit(limit)
            .offset(offset)
        ).scalars()
    )

    return DebtPaymentListPublic(
        items=[DebtPaymentPublic.model_validate(row) for row in rows],
        total=int(total),
        limit=limit,
        offset=offset,
    )


@router.get(
    "/{debt_id}/payments/{payment_id}",
    response_model=DebtPaymentPublic,
)
def get_debt_payment(
    debt_id: uuid.UUID,
    payment_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DebtPaymentPublic:
    _get_owned_debt(db, debt_id=debt_id, current_user=current_user)
    payment = _get_owned_payment(db, debt_id=debt_id, payment_id=payment_id)
    return DebtPaymentPublic.model_validate(payment)


@router.patch(
    "/{debt_id}/payments/{payment_id}",
    response_model=DebtPaymentPublic,
)
def update_debt_payment(
    debt_id: uuid.UUID,
    payment_id: uuid.UUID,
    payload: DebtPaymentUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DebtPaymentPublic:
    """Partial update of a cicilan row.

    Cross-field validation against the merged effective values
    (request payload union persisted row) lives in the route because
    the schema can only see fields present in the request. The two
    cases the schema can't catch:

    * ``amount_cents`` provided alone (no portions) → 422: the caller
      can't rebalance the split silently.
    * one portion provided, the other side unchanged → the route
      re-checks ``principal + interest == amount_cents`` against the
      merged values; 422 when the caller's new portion can't reconcile
      with the existing ``amount_cents``.

    Overpayment is enforced against the remaining principal *after*
    the old payment is conceptually reversed (the
    ``excluding_payment_id`` clause on
    :func:`app.services.debt_payments.assert_no_overpayment`) so a
    PATCH that increases the principal portion of the *last* payment
    on a debt doesn't falsely trip the check.

    The status refresh runs after the fields are mutated, so a PATCH
    that flips a paid-off debt back above zero (e.g. decreasing the
    principal portion) automatically transitions ``status`` back to
    ``active``.
    """
    debt = _get_owned_debt(db, debt_id=debt_id, current_user=current_user)
    payment = _get_owned_payment(db, debt_id=debt_id, payment_id=payment_id)

    data = payload.model_dump(exclude_unset=True)

    # Reject amount-only edits (no portions) — the caller can't
    # silently rebalance the split. The merged-value check below
    # catches the "one portion provided" case but only when the other
    # portion is already in the payload; an amount-only PATCH would
    # bypass that check entirely.
    if "amount_cents" in data and not (
        "principal_portion_cents" in data or "interest_portion_cents" in data
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                "amount_cents cannot be updated without also sending principal_portion_cents "
                "and interest_portion_cents (the split must reconcile against the new total)"
            ),
        )

    # Validate the merged effective split (request + persisted row).
    effective_amount = data.get("amount_cents", payment.amount_cents)
    effective_principal = data.get("principal_portion_cents", payment.principal_portion_cents)
    effective_interest = data.get("interest_portion_cents", payment.interest_portion_cents)
    if effective_principal + effective_interest != effective_amount:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                "effective principal_portion_cents + interest_portion_cents must equal "
                f"effective amount_cents (got {effective_principal} + "
                f"{effective_interest} = {effective_principal + effective_interest}, "
                f"expected {effective_amount})"
            ),
        )

    if "source_account_id" in data and data["source_account_id"] is not None:
        _get_owned_source_account(
            db,
            source_account_id=data["source_account_id"],
            current_user=current_user,
        )

    # Reject ``debt_id`` swaps (the FK is server-controlled and the
    # path-based id is the source of truth; a different value in the
    # body is a client bug, not a feature).
    if "debt_id" in data:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="debt_id is server-controlled and cannot be updated through this endpoint",
        )

    # Overpayment check uses the post-reversal remaining so an edit
    # that *increases* the principal portion of the last payment on
    # the debt can still succeed (otherwise the check would always
    # trip on the last payment — the only one whose principal portion
    # can legitimately equal the full remaining).
    try:
        assert_no_overpayment(
            db=db,
            debt=debt,
            principal_portion_cents=effective_principal,
            excluding_payment_id=payment.id,
        )
    except OverpaymentError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc

    for field, value in data.items():
        setattr(payment, field, value)

    refresh_debt_status(db=db, debt=debt)

    db.commit()
    db.refresh(payment)
    # sub-0007-01 — PATCH on a payment shifts both totals
    # (``remaining_principal_cents`` via the principal portion;
    # ``total_interest_paid_cents`` via the interest portion). The
    # debts-summary endpoint must refresh.
    dashboard_cache.invalidate_for_table(user_id=current_user.id, table="debts")
    return DebtPaymentPublic.model_validate(payment)


@router.delete(
    "/{debt_id}/payments/{payment_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
def delete_debt_payment(
    debt_id: uuid.UUID,
    payment_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    """Delete a cicilan row and refresh the debt's status flag.

    A delete that drops the last outstanding principal portion on a
    previously paid-off debt automatically transitions ``status`` back
    to ``active`` — handled by the same
    :func:`app.services.debt_payments.refresh_debt_status` helper the
    create / update paths use, so the rule is uniform across the
    three write endpoints.
    """
    _get_owned_debt(db, debt_id=debt_id, current_user=current_user)
    payment = _get_owned_payment(db, debt_id=debt_id, payment_id=payment_id)
    debt = payment.debt  # already loaded by the FK relationship
    db.delete(payment)
    db.flush()  # so the subsequent SUM() in refresh_debt_status sees the row removed
    refresh_debt_status(db=db, debt=debt)
    db.commit()
    # sub-0007-01 — a payment delete can flip a paid-off debt back
    # to ``active`` (and back again on the next payment), which moves
    # the debt between the active / paid-off buckets on the
    # debts-summary card. Always invalidate on payment delete.
    dashboard_cache.invalidate_for_table(user_id=current_user.id, table="debts")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
