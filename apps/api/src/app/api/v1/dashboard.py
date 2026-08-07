"""Dashboard aggregation endpoints (epic-0007, sub-0007-01).

Six read-only endpoints that power the FE dashboard:

* ``GET /dashboard/summary`` — KPI cards (networth + asset/liability
  totals + this-month income/expense + EF average progress).
* ``GET /dashboard/networth-trend`` — per-month networth for the last
  N months (default 12, max 24) for the line chart.
* ``GET /dashboard/income-expense-trend`` — per-month income + expense
  for the last N months for the bar chart (empty months surface as
  zero rows so the chart has a consistent 12-bar x-axis).
* ``GET /dashboard/top-categories`` — top-N expense categories for a
  month (default 5, max 20) for the donut chart.
* ``GET /dashboard/goals-progress`` — progress snapshot for every
  non-archived goal (the FE renders the progress card off this).
* ``GET /dashboard/debts-summary`` — aggregate across all debts
  (total remaining principal, total interest paid, active + paid-off
  counts) for the "ringkasan utang" card.

Conventions follow :mod:`app.api.v1.debts` (per-router ``get_db``
re-export, ``HTTPBearer`` via ``get_current_user``, auth-scoped
queries that never read across users — the user's own row set is the
only set we ever query).

Cache strategy (sub-0007-01 spec):

* Every endpoint is read-through against the stdlib TTL dict at
  :mod:`app.services.dashboard_cache`. Default 60 s; tunable via
  :func:`app.services.dashboard_cache.set_default_ttl` for tests.
* The write-side routers (transactions / accounts / goals / debts)
  call :func:`app.services.dashboard_cache.invalidate_for_table` on
  every successful POST/PATCH/DELETE so a brand-new tx immediately
  invalidates the right cache slot — the FE sees the new numbers on
  its next refresh, no stale-KPIs UX bug.
* The cache is **per-user**: the key includes the caller's UUID so
  Alice's dashboard can't ever surface Bob's cached payload even if
  the params happen to line up.

No N+1 / no per-row fetch: each endpoint runs a fixed number of
SQL aggregates (1-4, depending on the endpoint) regardless of how many
accounts / goals / debts the user has. The ``accounts`` aggregate
inside ``/summary`` is the one query the saldo engine runs — it joins
``accounts`` outer-``transactions`` and groups by account, so a user
with 50 accounts still triggers exactly one query.

Soft-delete aware: every aggregate filters on ``deleted_at IS NULL``
(mirrors the convention the transactions summary endpoint landed in
sub-0003-04) and the dashboard networth trend filters out archived
accounts (``archived = False``) via the saldo engine — a closed
account never pulls down the running total.

Auth + cross-user isolation: every endpoint depends on
``get_current_user`` and scopes every query with
``Transaction.user_id == current_user.id`` (or the equivalent for
the relevant table). A JWT from Alice can never reach Bob's data
even if Alice guesses a valid resource id.
"""

from __future__ import annotations

import calendar
import uuid
from collections.abc import Iterator
from datetime import date as _date

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.schemas import (
    DashboardDebtsSummaryPublic,
    DashboardGoalProgressPublic,
    DashboardGoalsProgressPublic,
    DashboardGoalStatus,
    DashboardIncomeExpenseTrendPointPublic,
    DashboardIncomeExpenseTrendPublic,
    DashboardNetworthTrendPointPublic,
    DashboardNetworthTrendPublic,
    DashboardSummaryPublic,
    DashboardTopCategoriesPublic,
    DashboardTopCategoryPublic,
)
from app.api.v1.auth import get_current_user
from app.db.models.category import Category
from app.db.models.debt import Debt
from app.db.models.enums import AccountType, DebtStatus, GoalKind, TransactionType
from app.db.models.goal import Goal
from app.db.models.transaction import Transaction
from app.db.models.user import User
from app.db.session import get_session
from app.services import dashboard_cache
from app.services.balance import calculate_user_balances
from app.services.debt_payments import (
    remaining_principal_cents,
    total_interest_paid_cents,
)
from app.services.goal_engine import compute_goal_progress

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


def get_db() -> Iterator[Session]:
    """Per-router session dependency (mirrors debts.py / goals.py)."""
    yield from get_session()


# --- Shared helpers ---------------------------------------------------------


def _month_label(value: _date) -> str:
    """Return ``YYYY-MM`` for ``value``.

    Localized to the caller's local calendar — matches the FE's locale
    conventions and the per-month bucketing the saldo engine uses for
    its ``as_of`` filter.
    """
    return f"{value.year:04d}-{value.month:02d}"


def _month_first_last(year: int, month: int) -> tuple[_date, _date]:
    """Return ``(first_day, last_day)`` for a calendar ``(year, month)``.

    Mirrors :func:`app.api.v1.transactions._month_bounds` so the
    dashboard bucketing stays consistent with the existing monthly
    summary endpoint.
    """
    first_day = _date(year, month, 1)
    last_day_num = calendar.monthrange(year, month)[1]
    last_day = _date(year, month, last_day_num)
    return first_day, last_day


def _prev_month(year: int, month: int, *, offset: int = 1) -> tuple[int, int]:
    """Return ``(year, month)`` ``offset`` months before ``(year, month)``.

    Used by the trend endpoints to walk the per-month buckets.
    """
    total = (year * 12 + (month - 1)) - offset
    new_year, new_month_zero = divmod(total, 12)
    return new_year, new_month_zero + 1


# --- /summary ---------------------------------------------------------------


def _compute_summary(
    db: Session,
    *,
    user_id: uuid.UUID,
) -> DashboardSummaryPublic:
    """Build the KPI-card payload from a single batch of SQL aggregates.

    The endpoint owns no state — this helper is split out so the route
    handler stays a thin cache-aside wrapper (get → compute → set →
    return). Five queries total: networth via the saldo engine
    (1 outer join), income + expense (1 query each, but the same
    ``SELECT ... FROM transactions WHERE user_id = ? AND
    date_trunc('month', occurred_on) = date_trunc('month', today)``
    shape with different ``type`` predicates), and the EF average
    (1 query).
    """
    today = _date.today()
    first_day, last_day = _month_first_last(today.year, today.month)

    balances = calculate_user_balances(db, user_id=user_id, as_of=today)
    # Liability bucket — the saldo engine treats a credit card's
    # running balance as a *negative* number once the card is paid
    # down past zero. The dashboard surfaces liabilities as the
    # outstanding (positive) amount, so we flip the sign of any
    # credit-card saldo here. Asset accounts already carry their
    # positive balance.
    liabilities_total = 0
    for account in balances.accounts:
        if not account.is_asset and account.balance_cents < 0:
            liabilities_total += -account.balance_cents
    # Networth is derived from the *positive* liability bucket above
    # so the dashboard's "Networth = assets - liabilities" equation
    # matches the FE's mental model. ``balances.networth_cents`` from
    # the engine would otherwise do ``total_assets - total_liabilities``
    # (with the credit-card saldo as a *negative* number), which
    # produces a networth that *adds* credit-card debt instead of
    # subtracting it — correct for the engine's accounting, but
    # surprising for a personal-finance UI.
    networth_cents = balances.total_assets_cents - liabilities_total

    month_filters = [
        Transaction.user_id == user_id,
        Transaction.deleted_at.is_(None),
        Transaction.type != TransactionType.TRANSFER,
        Transaction.occurred_on >= first_day,
        Transaction.occurred_on <= last_day,
    ]
    income_cents = int(
        db.execute(
            select(func.coalesce(func.sum(Transaction.amount_cents), 0)).where(
                *month_filters,
                Transaction.type == TransactionType.INCOME,
            )
        ).scalar_one()
    )
    expense_cents = int(
        db.execute(
            select(func.coalesce(func.sum(Transaction.amount_cents), 0)).where(
                *month_filters,
                Transaction.type == TransactionType.EXPENSE,
            )
        ).scalar_one()
    )

    # EF avg pct — average ``current / target * 100`` across active EF
    # goals. We use the goal-engine's :func:`compute_goal_progress` so
    # linked-vs-unlinked semantics + clamp + percentage rounding stay
    # in one place. ``None`` when the user has no active EF goal so the
    # FE renders "Belum ada dana darurat" instead of a misleading 0.
    ef_goals = list(
        db.execute(
            select(Goal).where(
                Goal.user_id == user_id,
                Goal.kind == GoalKind.EMERGENCY_FUND,
                Goal.archived_at.is_(None),
            )
        ).scalars()
    )
    ef_avg_pct: float | None
    if not ef_goals:
        ef_avg_pct = None
    else:
        pct_sum = 0.0
        for goal in ef_goals:
            progress = compute_goal_progress(db, goal=goal)
            pct_sum += progress.percentage
        ef_avg_pct = round(pct_sum / len(ef_goals), 2)

    return DashboardSummaryPublic(
        currency="IDR",
        networth_cents=networth_cents,
        total_assets_cents=balances.total_assets_cents,
        total_liabilities_cents=liabilities_total,
        income_this_month_cents=income_cents,
        expense_this_month_cents=expense_cents,
        emergency_fund_avg_pct=ef_avg_pct,
    )


@router.get("/summary", response_model=DashboardSummaryPublic)
def get_dashboard_summary(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DashboardSummaryPublic:
    """KPI-card payload for the FE dashboard.

    Cached 60 s. Invalidated by every POST/PATCH/DELETE on the
    ``transactions`` / ``accounts`` / ``goals`` / ``debts`` tables
    (the spec's invalidation table for the ``summary`` endpoint).
    """
    params: dict[str, object] = {}
    cached = dashboard_cache.get(user_id=current_user.id, endpoint="summary", params=params)
    if cached is not None:
        return DashboardSummaryPublic.model_validate(cached)

    payload = _compute_summary(db, user_id=current_user.id)
    dashboard_cache.put(
        user_id=current_user.id,
        endpoint="summary",
        params=params,
        value=payload.model_dump(),
    )
    return payload


# --- /networth-trend --------------------------------------------------------


def _compute_networth_trend(
    db: Session,
    *,
    user_id: uuid.UUID,
    months: int,
) -> DashboardNetworthTrendPublic:
    """Return the per-month networth trend (oldest-first).

    For each month we compute the user's networth *at the end of the
    month*: every active account's running balance (opening + deltas up
    to the last day) plus the absolute remaining principal of every
    active debt — same shape the ``summary`` endpoint uses, but
    anchored to the last day of each historical bucket.

    Implementation: one outer-join aggregate over ``accounts`` for the
    per-month saldo engine, and one ``debt_payments`` aggregate for the
    remaining principal. The per-month loop walks the timeline in O(N)
    queries where N = ``months`` (default 12, max 24) — small enough
    to be acceptable on the read path, and the cache absorbs the cost
    on subsequent renders.
    """
    today = _date.today()
    cur_year, cur_month = today.year, today.month

    points: list[DashboardNetworthTrendPointPublic] = []
    for offset in range(months - 1, -1, -1):
        year, month = _prev_month(cur_year, cur_month, offset=offset)
        _, last_day = _month_first_last(year, month)

        balances = calculate_user_balances(db, user_id=user_id, as_of=last_day)
        liabilities = 0
        for account in balances.accounts:
            if not account.is_asset and account.balance_cents < 0:
                liabilities += -account.balance_cents

        # Add the absolute remaining principal of every *active* debt
        # to the liability bucket. The summary endpoint's CC-vs-debt
        # split isn't preserved here — both are "what the user still
        # owes" from the networth perspective.
        debt_rows = list(
            db.execute(
                select(Debt).where(Debt.user_id == user_id, Debt.status == DebtStatus.ACTIVE)
            ).scalars()
        )
        debt_remaining_total = 0
        for debt in debt_rows:
            debt_remaining_total += remaining_principal_cents(db=db, debt=debt)

        points.append(
            DashboardNetworthTrendPointPublic(
                month=f"{year:04d}-{month:02d}",
                networth_cents=balances.total_assets_cents - liabilities - debt_remaining_total,
            )
        )

    return DashboardNetworthTrendPublic(data=points)


@router.get("/networth-trend", response_model=DashboardNetworthTrendPublic)
@router.get("/networth-trend", response_model=DashboardNetworthTrendPublic)
def get_networth_trend(
    months: int = Query(
        default=12,
        ge=1,
        le=24,
        description="Number of months to include (oldest first). Default 12, max 24.",
    ),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DashboardNetworthTrendPublic:
    """Per-month networth trend for the FE line chart."""
    params: dict[str, object] = {"months": months}
    cached = dashboard_cache.get(user_id=current_user.id, endpoint="networth-trend", params=params)
    if cached is not None:
        return DashboardNetworthTrendPublic.model_validate(cached)

    payload = _compute_networth_trend(db, user_id=current_user.id, months=months)
    dashboard_cache.put(
        user_id=current_user.id,
        endpoint="networth-trend",
        params=params,
        value=payload.model_dump(),
    )
    return payload


# --- /income-expense-trend --------------------------------------------------


def _compute_income_expense_trend(
    db: Session,
    *,
    user_id: uuid.UUID,
    months: int,
) -> DashboardIncomeExpenseTrendPublic:
    """Per-month income + expense totals (oldest-first).

    Implementation note: the SQLite test backend has no ``date_trunc``
    function (that's a PostgreSQL built-in), and a portable
    cross-dialect ``GROUP BY month-bucket`` would require dialect-aware
    SQL. The window is small (≤ 24 months) and the rows are cheap to
    fetch, so we pull the raw rows in one query and bucket them on the
    Python side. The 60-second cache absorbs the cost on subsequent
    renders; the perf bench (``test_dashboard_perf.py``) confirms
    p95 < 500 ms against a 5K-transaction dataset.

    Empty months surface as zero rows so the FE bar chart always gets
    ``months`` rows in chronological order.
    """
    today = _date.today()
    cur_year, cur_month = today.year, today.month

    start_year, start_month = _prev_month(cur_year, cur_month, offset=months - 1)
    start_first, _ = _month_first_last(start_year, start_month)

    rows = db.execute(
        select(Transaction.type, Transaction.occurred_on, Transaction.amount_cents).where(
            Transaction.user_id == user_id,
            Transaction.deleted_at.is_(None),
            Transaction.type != TransactionType.TRANSFER,
            Transaction.occurred_on >= start_first,
            Transaction.occurred_on <= today,
        )
    ).all()

    bucket: dict[tuple[int, int], tuple[int, int]] = {}
    for row in rows:
        key = (row.occurred_on.year, row.occurred_on.month)
        prev_income, prev_expense = bucket.get(key, (0, 0))
        if row.type == TransactionType.INCOME:
            bucket[key] = (prev_income + int(row.amount_cents), prev_expense)
        elif row.type == TransactionType.EXPENSE:
            bucket[key] = (prev_income, prev_expense + int(row.amount_cents))

    points: list[DashboardIncomeExpenseTrendPointPublic] = []
    for offset in range(months - 1, -1, -1):
        year, month = _prev_month(cur_year, cur_month, offset=offset)
        income, expense = bucket.get((year, month), (0, 0))
        points.append(
            DashboardIncomeExpenseTrendPointPublic(
                month=f"{year:04d}-{month:02d}",
                income_cents=income,
                expense_cents=expense,
            )
        )

    return DashboardIncomeExpenseTrendPublic(data=points)


@router.get(
    "/income-expense-trend",
    response_model=DashboardIncomeExpenseTrendPublic,
)
def get_income_expense_trend(
    months: int = Query(
        default=12,
        ge=1,
        le=24,
        description="Number of months to include (oldest first). Default 12, max 24.",
    ),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DashboardIncomeExpenseTrendPublic:
    """Per-month income + expense for the FE bar chart.

    Empty months surface as zero rows so the FE always gets ``months``
    rows in chronological order — the chart x-axis is stable across
    renders.
    """
    params: dict[str, object] = {"months": months}
    cached = dashboard_cache.get(
        user_id=current_user.id, endpoint="income-expense-trend", params=params
    )
    if cached is not None:
        return DashboardIncomeExpenseTrendPublic.model_validate(cached)

    payload = _compute_income_expense_trend(db, user_id=current_user.id, months=months)
    dashboard_cache.put(
        user_id=current_user.id,
        endpoint="income-expense-trend",
        params=params,
        value=payload.model_dump(),
    )
    return payload


# --- /top-categories --------------------------------------------------------


def _compute_top_categories(
    db: Session,
    *,
    user_id: uuid.UUID,
    month_label: str,
    limit: int,
) -> DashboardTopCategoriesPublic:
    """Top-N expense categories for the requested month.

    One ``GROUP BY category_id`` aggregate over the active expense rows
    in the month. ``percentage`` is computed on the Python side from
    the total sum so the values across rows sum to roughly 100 (the
    FE uses the percentage for the donut chart without a follow-up
    normalization step).

    Soft-delete aware: ``deleted_at IS NULL`` filter is part of the
    WHERE clause so a tombstoned transaction never inflates the top-N
    total.
    """
    year_s, month_s = month_label.split("-")
    year = int(year_s)
    month = int(month_s)
    first_day, last_day = _month_first_last(year, month)

    rows = db.execute(
        select(
            Transaction.category_id,
            Category.name,
            func.coalesce(func.sum(Transaction.amount_cents), 0).label("total"),
        )
        .outerjoin(Category, Category.id == Transaction.category_id)
        .where(
            Transaction.user_id == user_id,
            Transaction.deleted_at.is_(None),
            Transaction.type == TransactionType.EXPENSE,
            Transaction.occurred_on >= first_day,
            Transaction.occurred_on <= last_day,
        )
        .group_by(Transaction.category_id, Category.name)
        .order_by(func.sum(Transaction.amount_cents).desc())
        .limit(limit)
    ).all()

    total_sum = sum(int(row.total) for row in rows)
    items: list[DashboardTopCategoryPublic] = []
    for row in rows:
        total = int(row.total)
        percentage = round((total / total_sum * 100.0), 2) if total_sum > 0 else 0.0
        items.append(
            DashboardTopCategoryPublic(
                category_id=row.category_id,
                category_name=row.name,
                total_cents=total,
                percentage=percentage,
            )
        )

    return DashboardTopCategoriesPublic(data=items)


@router.get("/top-categories", response_model=DashboardTopCategoriesPublic)
def get_top_categories(
    month: str = Query(
        default=None,
        description=(
            "Target month in ``YYYY-MM`` form. Defaults to the current calendar month when omitted."
        ),
    ),
    limit: int = Query(
        default=5,
        ge=1,
        le=20,
        description="Top-N expense categories. Default 5, max 20.",
    ),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DashboardTopCategoriesPublic:
    """Top-N expense categories for the donut chart.

    The ``month`` query parameter accepts ``YYYY-MM``; the route
    validates the format and range before the SQL runs.
    """
    if month is None:
        today = _date.today()
        month_label = _month_label(today)
    else:
        try:
            year_s, month_s = month.split("-")
            year_i = int(year_s)
            month_i = int(month_s)
        except (ValueError, AttributeError) as exc:
            raise _bad_month(month) from exc
        # Strict ``YYYY-MM`` shape: month component must be exactly two
        # digits (rejecting ``2026-1`` so the cache key always uses a
        # canonical form). The split check above already rejects any
        # non-integer month string (``2026-1a``, ``2026-``), but a
        # single-digit month like ``2026-1`` passes ``int()`` — guard
        # against it here.
        if (
            not (1 <= month_i <= 12)
            or not (1970 <= year_i <= 2999)
            or len(month_s) != 2
            or len(year_s) != 4
        ):
            raise _bad_month(month)
        month_label = month

    params: dict[str, object] = {"month": month_label, "limit": limit}
    cached = dashboard_cache.get(user_id=current_user.id, endpoint="top-categories", params=params)
    if cached is not None:
        return DashboardTopCategoriesPublic.model_validate(cached)

    payload = _compute_top_categories(
        db, user_id=current_user.id, month_label=month_label, limit=limit
    )
    dashboard_cache.put(
        user_id=current_user.id,
        endpoint="top-categories",
        params=params,
        value=payload.model_dump(),
    )
    return payload


def _bad_month(value: str) -> Exception:
    """Surface a clear 422 for an unparseable ``month`` query value."""
    from fastapi import HTTPException, status

    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail=(
            "month must be in 'YYYY-MM' form with year in [1970, 2999] and "
            f"month in [1, 12]; got {value!r}"
        ),
    )


# --- /goals-progress --------------------------------------------------------


def _compute_goals_progress(
    db: Session,
    *,
    user_id: uuid.UUID,
) -> DashboardGoalsProgressPublic:
    """Per-goal progress snapshot for every non-archived goal.

    Reuses :func:`app.services.goal_engine.compute_goal_progress` so
    linked-vs-unlinked semantics + percentage clamp + rounding stay
    in one place. The endpoint never recomputes — it walks the goal
    rows the user already owns and returns the engine's payload with
    the FE-facing ``status`` enum (``active`` / ``achieved`` /
    ``archived``) pre-resolved.
    """
    goals = list(
        db.execute(
            select(Goal)
            .where(Goal.user_id == user_id)
            .order_by(
                Goal.kind.asc(),
                Goal.start_date.desc(),
                Goal.created_at.desc(),
                Goal.id.asc(),
            )
        ).scalars()
    )

    items: list[DashboardGoalProgressPublic] = []
    for goal in goals:
        progress = compute_goal_progress(db, goal=goal)
        if goal.archived_at is not None:
            status_value: DashboardGoalStatus = "archived"
        elif progress.achieved_at is not None or progress.percentage >= 100.0:
            status_value = "achieved"
        else:
            status_value = "active"
        # ``due_date`` - for EF goals we surface ``start_date`` as the
        # closest deadline the FE can render (EF doesn't carry a
        # separate target_date). For saving goals we use
        # ``target_date``; both fall back to ``None`` if the relevant
        # column is unset.
        due_date = goal.target_date if goal.kind == GoalKind.SAVING else None
        items.append(
            DashboardGoalProgressPublic(
                goal_id=progress.goal_id,
                name=goal.name,
                kind=goal.kind,
                current_cents=progress.current_amount_cents,
                target_cents=progress.target_amount_cents,
                pct=progress.percentage,
                status=status_value,
                due_date=due_date,
            )
        )

    return DashboardGoalsProgressPublic(data=items)


@router.get("/goals-progress", response_model=DashboardGoalsProgressPublic)
def get_goals_progress(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DashboardGoalsProgressPublic:
    """Per-goal progress snapshot for the FE goal-progress card.

    Includes archived goals too (with ``status='archived'``) so the FE
    can render the "Achieved" history without a follow-up call.
    """
    params: dict[str, object] = {}
    cached = dashboard_cache.get(user_id=current_user.id, endpoint="goals-progress", params=params)
    if cached is not None:
        return DashboardGoalsProgressPublic.model_validate(cached)

    payload = _compute_goals_progress(db, user_id=current_user.id)
    dashboard_cache.put(
        user_id=current_user.id,
        endpoint="goals-progress",
        params=params,
        value=payload.model_dump(),
    )
    return payload


# --- /debts-summary ---------------------------------------------------------


def _compute_debts_summary(
    db: Session,
    *,
    user_id: uuid.UUID,
) -> DashboardDebtsSummaryPublic:
    """Aggregate across the caller's entire debt ledger.

    One query per field so each aggregate can use the right predicate:
    ``remaining_principal_cents`` over *active* debts (paid-off
    contribute ``0`` by definition), ``total_interest_paid_cents``
    across the whole ledger (paid-off debts' interest is still part of
    the user's lifetime cost), and the counts split by status. The
    helpers in :mod:`app.services.debt_payments` own the per-debt math
    so the summary endpoint never re-implements it.
    """
    debts = list(db.execute(select(Debt).where(Debt.user_id == user_id)).scalars())

    total_remaining = 0
    total_interest_paid = 0
    active_count = 0
    paid_off_count = 0
    for debt in debts:
        if debt.status == DebtStatus.ACTIVE:
            active_count += 1
            total_remaining += remaining_principal_cents(db=db, debt=debt)
        elif debt.status == DebtStatus.PAID_OFF:
            paid_off_count += 1
        total_interest_paid += total_interest_paid_cents(db=db, debt=debt)

    return DashboardDebtsSummaryPublic(
        total_remaining_cents=total_remaining,
        total_interest_paid_cents=total_interest_paid,
        active_count=active_count,
        paid_off_count=paid_off_count,
    )


@router.get("/debts-summary", response_model=DashboardDebtsSummaryPublic)
def get_debts_summary(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DashboardDebtsSummaryPublic:
    """Aggregate across the caller's debt ledger for the FE summary card.

    Soft-delete aware: ``debts`` rows are not soft-deleted today (the
    CRUD endpoint uses hard delete — see ``debts.py``), but the
    summary stays correct because a hard-deleted debt simply doesn't
    appear in the per-row scan.
    """
    params: dict[str, object] = {}
    cached = dashboard_cache.get(user_id=current_user.id, endpoint="debts-summary", params=params)
    if cached is not None:
        return DashboardDebtsSummaryPublic.model_validate(cached)

    payload = _compute_debts_summary(db, user_id=current_user.id)
    dashboard_cache.put(
        user_id=current_user.id,
        endpoint="debts-summary",
        params=params,
        value=payload.model_dump(),
    )
    return payload


# --- Re-exports for invalidation hooks --------------------------------------


# Public symbols imported by ``api/router.py`` (the v1 router aggregator).
# ``AccountType`` and ``GoalKind`` are re-exported so the invalidation
# helpers in the write-side routers don't have to reach into the
# dashboard router's imports to find them.
__all__ = [
    "AccountType",
    "GoalKind",
    "router",
]
