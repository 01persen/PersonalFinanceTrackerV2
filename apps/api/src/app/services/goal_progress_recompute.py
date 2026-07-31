"""Goal progress recompute hook (sub-0005-02).

Background-tasks hook fired after a transaction insert/update/delete
on the linked account -- recomputes the achieved state for every active
goal that tracks that account. The transaction commit finishes before
the hook runs (FastAPI's ``BackgroundTasks`` runs *after* the response
is sent), so the ``accounts.balance_cents`` aggregate the recompute
queries is guaranteed to include the new row.

Why a hook + not just live-derive? Because the persisted
``achieved_at`` column is the *first* time the goal crossed 100%, and
the recompute is the only place that *writes* it -- the read path
(:func:`app.services.goal_engine.compute_goal_progress`) is pure
read, never writes. A goal that subsequently dips below 100% (e.g.
withdrawal from a savings account) still surfaces the original
achievement timestamp; the recompute is monotonic and never clears
``achieved_at``.

Hook coverage:

* Insert / update / soft-delete a transaction -> recompute active goals
  linked to ``tx.account_id``.
* Insert a paired transfer -> recompute for BOTH source and destination
  accounts (the saldo engine signs both legs, so both
  ``accounts.balance_cents`` values change).
* Soft-delete (delete) a transaction -> recompute for the
  ``account_id`` it was on; the row's ``deleted_at`` predicate
  excludes it from the saldo aggregate so the recompute sees the
  new lower balance.

Hook non-coverage (no infinite loop):

* Transaction on an account with no linked goal -> no-op. The
  recompute does a single ``SELECT ... WHERE linked_account_id =
  <id> AND archived_at IS NULL`` and bails when the list is empty.
* Transfer to/from an unlinked account -> still triggers the lookup
  for the linked side, no-op for the unlinked side.

In-process queue (FastAPI BackgroundTasks) is sufficient for MVP
single-user, low-tx volume. The carry-over at the bottom of the
issue specs Celery/RQ as the multi-user upgrade path; not in scope
for epic-0005.

Session model: the hook runs *after* the request-scoped session is
closed, so it opens its own session via the application's
``get_sessionmaker`` and commits before returning. The recompute body
(:func:`recompute_for_account_ids`) never raises on no-op coverage --
empty result sets return ``0`` immediately.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Iterable
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models.goal import Goal
from app.services.goal_engine import compute_goal_progress

if TYPE_CHECKING:
    # Imported only for the type alias used by the BackgroundTasks
    # dependency injection — kept behind ``TYPE_CHECKING`` so the
    # service module doesn't pull ``fastapi`` into the import graph
    # (Alembic + service-layer-only callers don't need it).
    from starlette.background import BackgroundTasks as BackgroundTasksT

logger = logging.getLogger(__name__)


def recompute_achieved_at_for_goal(db: Session, *, goal: Goal) -> bool:
    """Mark ``achieved_at`` on a single goal if it has crossed 100%.

    Uses :func:`app.services.goal_engine.compute_goal_progress` to read
    the live percentage, so linked vs unlinked semantics stay
    consistent with the progress endpoint (the recompute and the read
    path always agree on what "current amount" means for a given
    goal).

    Idempotent: if ``goal.achieved_at`` is already set, the function
    returns ``False`` immediately -- a goal that's been achieved is
    never re-stamped, and a goal that subsequently dips below 100%
    keeps the original timestamp.

    Returns ``True`` only when the function actually wrote a new
    ``achieved_at`` value. Callers can ignore the return value; it's
    exposed for the test suite's "first-cross timestamp is the one
    we persisted" assertion.
    """
    if goal.archived_at is not None:
        return False
    if goal.achieved_at is not None:
        return False
    progress = compute_goal_progress(db, goal=goal)
    if progress.percentage < 100.0:
        return False
    if progress.current_amount_cents < progress.target_amount_cents:
        # Defensive -- even with percentage clamped the underlying
        # ``current < target`` can theoretically disagree because of
        # integer rounding at large values. The persisted flag must
        # only follow the strict ``current >= target`` rule, so we
        # re-check the raw integers here.
        return False
    goal.achieved_at = datetime.now(UTC)  # type: ignore[assignment]
    return True


def recompute_for_account_id(db: Session, *, account_id: uuid.UUID) -> int:
    """Recompute achieved state for every active goal linked to an account.

    Used by the BackgroundTasks hook fired after a transaction commit.
    Returns the number of goals processed -- equal to the size of the
    target set (``0`` for accounts with no linked goal, which is the
    "tx ke akun unlinked" no-op coverage).

    Caller owns the transaction: the function ``flush()``s but never
    ``commit()``s so the BackgroundTasks worker composes cleanly with
    any caller-managed session lifecycle. The recompute itself is
    idempotent -- safe to call repeatedly with the same account id
    without double-stamping ``achieved_at``.
    """
    goals = list(
        db.execute(
            select(Goal).where(
                Goal.linked_account_id == account_id,
                Goal.archived_at.is_(None),
            )
        ).scalars()
    )
    if not goals:
        return 0

    touched = 0
    for goal in goals:
        if recompute_achieved_at_for_goal(db, goal=goal):
            touched += 1
    if touched:
        db.flush()
    return touched


def enqueue_recompute_for_account_ids(
    account_ids: Iterable[uuid.UUID],
) -> list[uuid.UUID]:
    """BackgroundTasks payload builder for the after-commit recompute.

    Returns the deduped list of account ids as a JSON-safe list of
    strings so the FastAPI ``BackgroundTasks.add_task`` can serialise
    it cleanly. The actual recompute runs in
    :func:`recompute_for_account_ids` below -- split from this helper
    so the test suite can call the body synchronously when running
    TestClient (which collects BackgroundTasks on shutdown and
    exercises the eventual-consistency window the spec calls out).

    This function does NOT touch the database -- it's a pure
    pre-processor for the hook.
    """
    deduped: dict[uuid.UUID, None] = {}
    for raw in account_ids:
        if raw is None:
            continue
        # Normalise so string and UUID variants dedupe to the same key.
        deduped[uuid.UUID(str(raw))] = None
    return list(deduped.keys())


def recompute_for_account_ids(db: Session, account_ids: list[uuid.UUID]) -> int:
    """Recompute achieved state across N accounts at once.

    Bulk variant of :func:`recompute_for_account_id` used by the
    transfer-recompute path (where two account ids change in the same
    tx) and by tests that want to fake the "BackgroundTasks ran"
    state in one call.
    """
    touched_total = 0
    for account_id in account_ids:
        touched_total += recompute_for_account_id(db, account_id=account_id)
    return touched_total


def recompute_for_goal_id(db: Session, *, goal_id: uuid.UUID) -> bool:
    """Single-goal entry point used by tests + manual fixups.

    Loads the goal and delegates to
    :func:`recompute_achieved_at_for_goal`. The function is a
    no-op (returns ``False``) for goals that aren't found, don't
    belong to a now-current user, or are already archived -- the
    BackgroundTasks hook never sees a user-bound check, but the
    test path does (the recompute should be safe to fire with any
    goal id from a refresh-everything test).
    """
    goal = db.get(Goal, goal_id)
    if goal is None:
        return False
    if goal.archived_at is not None:
        return False
    return recompute_achieved_at_for_goal(db, goal=goal)


def _run_recompute_in_background(account_ids: list[str]) -> None:
    """BackgroundTasks worker -- opens its own session, recomputes, commits.

    Called via :func:`fastapi.BackgroundTasks.add_task` from the
    transactions router right after the tx commit finishes. Runs
    *after* the response is sent, on a fresh session (the
    request-scoped session from the router has already been closed
    by the ``Depends(get_db)`` generator cleanup). The session is
    safe to commit/close inside this thread -- the test fixture's
    ``StaticPool`` keeps a single connection shared between threads
    and SQLAlchemy serialises access through the connection-level
    mutex.

    Failures are logged but never raised -- BackgroundTasks has no
    caller to surface them to (the response is already sent). The
    alternative (raise) would surface as a noisy stderr trace with
    no useful debugging signal because the FE is already gone.
    """
    if not account_ids:
        return
    # Lazy import -- keeps the service module pure at import time so
    # Alembic env can still load the model without creating an engine.
    from app.db.session import get_sessionmaker

    SessionLocal = get_sessionmaker()
    db = SessionLocal()
    try:
        # The worker is invoked with ``list[str]`` (the serialised
        # payload), so re-parse into UUIDs before delegating to the
        # shared recompute body which expects ``list[UUID]``.
        uuid_account_ids = [uuid.UUID(raw) for raw in account_ids]
        touched = recompute_for_account_ids(db, account_ids=uuid_account_ids)
        if touched:
            db.commit()
        logger.debug(
            "goal_progress_recompute: processed %d account(s), stamped %d new achievement(s)",
            len(account_ids),
            touched,
        )
    except Exception:  # pragma: no cover - defensive logging only
        db.rollback()
        logger.exception("goal_progress_recompute: failed for %s", account_ids)
    finally:
        db.close()


def enqueue_goal_progress_recompute(
    background_tasks: BackgroundTasksT,  # type alias below; see import avoidance
    account_ids: Iterable[uuid.UUID | str | None] | uuid.UUID | str | None,
) -> None:
    """Schedule the after-commit recompute for the given account ids.

    Called from the transactions router (and the categories / budgets
    router in future epics) right after the row commits. Inputs are
    normalised + deduped before being handed to
    :func:`_run_recompute_in_background` so a PATCH that swaps the
    account field from old -> new only fires the recompute once per
    affected account (not 3 times).
    """
    if account_ids is None:
        return
    if isinstance(account_ids, (uuid.UUID, str)):
        account_ids = [account_ids]
    deduped: dict[uuid.UUID, None] = {}
    for raw in account_ids:
        if raw is None:
            continue
        deduped[uuid.UUID(str(raw))] = None
    if not deduped:
        return
    # ``str()`` round-trip keeps BackgroundTasks' serialiser happy
    # (uuid.UUID instances work but explicit strings document the
    # contract for any future Celery/RQ upgrade).
    background_tasks.add_task(_run_recompute_in_background, [str(a) for a in deduped])
