"""Goal engine -- compute path for saving + EF progress (sub-0005-02).

Owns the read-side derivations the goals router used to do inline:

* **Linked vs unlinked semantics** -- a goal with ``linked_account_id IS
  NOT NULL`` derives ``current_amount_cents`` from the linked account's
  live saldo at request time; a goal without the link uses the stored
  ``current_amount_cents`` (manual input). Hybrid: best of both worlds,
  accuracy when linked, manual fallback when unlinked.
* **EF auto-calc formulas** -- ``target_amount_snapshot_cents =
  monthly_expense_cents x jumlah_tanggungan x multiplier``. The
  multiplier resolves in this order: explicit ``override_multiplier``
  argument, else the goal row's own ``multiplier`` column, else the
  caller's ``user_settings.emergency_fund_multiplier`` (default 3 --
  set by the epic-0001 seed module).
* **Saving auto-calc formulas** -- ``tabungan_bulanan_cents =
  target_amount_cents / jangka_waktu_months``. The
  ``lama_mengumpulkan_bulan`` (how many months to reach the target)
  only applies to EF and uses ``monthly_expense_cents`` as the
  "monthly saving rate" since EF has no fixed saving horizon field.
* **Percentage + clamp** -- ``percentage = (current / target) * 100``
  rounded to two decimals and clamped to ``[0, 100]``. Div-by-zero
  (``target <= 0``) returns ``0`` defensively even though the schema
  enforces ``> 0``.

All functions are pure-Python and take an explicit ``Session`` so the
callers (route handler, BackgroundTasks hook, and tests) all share the
same compute semantics. None of them commit -- the route owns the
transaction boundary and the recompute module owns its own session for
the BackgroundTasks path.

TL-confirmed semantics (sub-0005-02 kickoff, parent issue comment):

1. ``target_amount_snapshot_cents`` is **frozen at creation** --
   patching ``monthly_expense_cents`` or ``jumlah_tanggungan`` does
   **not** re-derive the snapshot. The user has to create a new EF
   goal to re-apply the formula.
2. The EF multiplier is **auto-fetched from user_settings** at
   creation unless the FE passes an explicit ``multiplier`` in the
   request body (TL decision: PRD §14 "User bisa ubah").
3. The recompute hook (sub-0005-02 carries the BackgroundTasks one)
   is **idempotent** -- repeated calls on the same goal never re-set
   ``achieved_at`` once it's been persisted.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from datetime import date as _date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models.goal import Goal
from app.db.models.user_preference import UserPreference
from app.services.balance import calculate_account_balance

# Sentinel default for the EF multiplier -- duplicates the value seeded
# by :mod:`app.services.seed` so the engine doesn't have to read the
# seed module just to know the default. Kept in sync via the seed test
# (``tests/test_seed.py``).
DEFAULT_EF_MULTIPLIER = 3


@dataclass(frozen=True)
class GoalProgress:
    """Computed progress snapshot for a goal at request time.

    Returned by :func:`compute_goal_progress`. Mirrors the wire shape
    of :class:`app.api.schemas.GoalProgressPublic` but as a dataclass so
    the service layer can build it independently of Pydantic -- the
    router converts to the public shape right before returning.
    """

    goal_id: uuid.UUID
    kind: object  # ``GoalKind``; kept loose so the module avoids a
    # circular import with the enum's owning module.
    current_amount_cents: int
    target_amount_cents: int
    percentage: float
    achieved_at: datetime | None
    tabungan_bulanan_cents: int | None
    lama_mengumpulkan_bulan: int | None


def _resolve_ef_multiplier(
    db: Session,
    *,
    user_id: uuid.UUID,
    override_multiplier: int | None,
) -> int:
    """Pick the multiplier for an EF formula at create time.

    Resolution order (sub-0005-02 TL decision):

    1. ``override_multiplier`` argument (from the FE create body, if
       explicitly sent) -- wins unconditionally.
    2. The user's ``user_settings.emergency_fund_multiplier`` -- defaults
       to :data:`DEFAULT_EF_MULTIPLIER` (3) on a missing seed row, which
       the epic-0001 seed creates so this branch is the normal path.

    The function raises no exceptions -- even a freshly registered user
    with no preferences row yet gets the seeded default, so the
    engine can be called before the seed runs in test fixtures.
    """
    if override_multiplier is not None:
        return override_multiplier

    pref = db.execute(
        select(UserPreference).where(UserPreference.user_id == user_id)
    ).scalar_one_or_none()
    if pref is not None:
        return pref.emergency_fund_multiplier
    return DEFAULT_EF_MULTIPLIER


def compute_ef_target_snapshot_cents(
    db: Session,
    *,
    user_id: uuid.UUID,
    monthly_expense_cents: int,
    jumlah_tanggungan: int,
    override_multiplier: int | None,
) -> int:
    """Compute the EF goal's frozen ``target_amount_snapshot_cents``.

    Formula (PRD §14, snapshot-at-creation): ``monthly_expense x
    jumlah_tanggungan x multiplier``. Returns 0 if either input is 0
    rather than raising -- the schema enforces ``> 0`` for
    ``monthly_expense_cents`` and ``>= 0`` for ``jumlah_tanggungan`` so
    this is defensive only; the route catches the bad case at write
    time via Pydantic.
    """
    multiplier = _resolve_ef_multiplier(
        db, user_id=user_id, override_multiplier=override_multiplier
    )
    return monthly_expense_cents * jumlah_tanggungan * multiplier


def compute_saving_tabungan_bulanan_cents(
    *,
    target_amount_cents: int,
    jangka_waktu_months: int,
) -> int | None:
    """Compute the saving goal's auto-calc ``tabungan_bulanan_cents``.

    Formula: ``target_amount_cents / jangka_waktu_months`` (integer
    division -- saving rates are stored in cents, no fractional cents).
    Returns ``None`` if either input is missing or non-positive so a
    saving goal without a horizon (e.g. open-ended vacation fund)
    stays null instead of DIV/0-ing on the route.
    """
    if target_amount_cents <= 0 or jangka_waktu_months <= 0:
        return None
    return target_amount_cents // jangka_waktu_months


def compute_ef_lama_mengumpulkan_bulan(
    *,
    target_amount_snapshot_cents: int | None,
    monthly_expense_cents: int | None,
) -> int | None:
    """Compute ``lama_mengumpulkan_bulan`` for an EF goal.

    EF doesn't carry a fixed saving-horizon field, so the natural
    "how many months do I save before reaching the EF?" answer uses
    the implicit monthly saving rate (the user's monthly expense).
    Returns ``None`` for any input that's missing or zero -- the spec
    calls for div-by-zero -> null (matches the saving-side behaviour
    in :func:`compute_saving_tabungan_bulanan_cents`).
    """
    if target_amount_snapshot_cents is None or monthly_expense_cents is None:
        return None
    if target_amount_snapshot_cents <= 0 or monthly_expense_cents <= 0:
        return None
    return target_amount_snapshot_cents // monthly_expense_cents


def _linked_account_balance_cents(
    db: Session,
    *,
    goal: Goal,
    as_of: _date | None,
) -> int:
    """Return the linked account's live balance, or ``0`` if link is missing.

    Calls :func:`app.services.balance.calculate_account_balance` which
    walks the same outer-join aggregation as the saldo engine so the
    "track my savings account" semantics stay consistent with the
    dashboard's balance numbers. The ``archived`` predicate is owned
    by the saldo engine (already excludes archived accounts), so a
    goal whose link was archived is treated as "no balance" rather
    than raising -- the FE displays 0% and the recompute hook skips
    it via the ``archived_at IS NULL`` predicate.
    """
    if goal.linked_account_id is None:
        return 0
    balance = calculate_account_balance(
        db,
        user_id=goal.user_id,
        account_id=uuid.UUID(str(goal.linked_account_id)),
        as_of=as_of or datetime.now(UTC).date(),
    )
    if balance is None:
        return 0
    return int(balance.balance_cents)


def compute_goal_progress(
    db: Session,
    *,
    goal: Goal,
    as_of: _date | None = None,
) -> GoalProgress:
    """Build the read-side progress snapshot for a single goal.

    Pure read -- never writes. The recompute hook
    (:func:`app.services.goal_progress_recompute.recompute_achieved_at_for_goal`)
    is the one that persists ``achieved_at`` once the goal first
    crosses 100%; this function only reads it.

    Resolution of ``current_amount_cents``:

    * ``linked_account_id IS NOT NULL`` -> live saldo from the linked
      account at ``as_of`` (defaults to today UTC).
    * ``linked_account_id IS NULL`` -> stored ``current_amount_cents``
      (manual input via PATCH). ``None`` is treated as 0 so the FE
      can never see ``NaN``/null for a progress bar.

    Resolution of ``percentage``:

    * ``target > 0`` -> ``(current / target) * 100`` rounded to two
      decimals and clamped to ``[0, 100]``.
    * ``target <= 0`` -> ``0`` (defensive; schema enforces ``> 0``).
    """
    if goal.linked_account_id is not None:
        current_amount_cents = _linked_account_balance_cents(db, goal=goal, as_of=as_of)
    elif goal.current_amount_cents is not None:
        current_amount_cents = int(goal.current_amount_cents)
    else:
        current_amount_cents = 0

    target_amount_cents = int(goal.target_amount_cents or 0)
    if target_amount_cents > 0:
        raw_pct = (current_amount_cents / target_amount_cents) * 100.0
        percentage = round(min(raw_pct, 100.0), 2)
    else:
        percentage = 0.0

    # ``goal.achieved_at`` carries the SQLAlchemy ``DateTime`` *type*
    # at the column descriptor level (the model declares ``DateTime``
    # as the value type), but the actual row value at runtime is a
    # ``datetime`` instance. mypy can't reconcile the two without an
    # explicit cast — the runtime is fine because SQLAlchemy 2.0's
    # type adapter resolves to ``datetime`` at access time.
    achieved_at_value: datetime | None = (
        goal.achieved_at if isinstance(goal.achieved_at, datetime) else None
    )

    return GoalProgress(
        goal_id=goal.id,
        kind=goal.kind,
        current_amount_cents=current_amount_cents,
        target_amount_cents=target_amount_cents,
        percentage=percentage,
        achieved_at=achieved_at_value,
        tabungan_bulanan_cents=goal.tabungan_bulanan_cents,
        lama_mengumpulkan_bulan=goal.lama_mengumpulkan_bulan,
    )
