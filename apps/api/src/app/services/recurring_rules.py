"""Recurring-rule service helpers (sub-0009-01).

Pure compute functions the CRUD router and (eventually) the materializer
worker call. No DB session here — these are deterministic
date-arithmetic primitives the routers can run inside the request handler
and the worker can re-run after each spawn.

The two contracts the FE depends on:

* :func:`compute_next_run_on` — ``start_on + cadence`` → ``next_run_on``
  for a brand-new rule. Monthly / yearly cadence clamps to the
  last-day-of-target-month when the source day doesn't exist there
  (Jan 31 → Feb 28).
* :func:`should_advance_next_run_on` — re-derive hook used by the
  PATCH endpoint when the caller changes ``start_on`` or ``cadence``;
  mirrors the create-time rule so the FE never has to send
  ``next_run_on`` directly.
"""

from __future__ import annotations

import calendar
from datetime import date

from app.db.models.enums import RecurringRuleCadence

_DAYS_IN_MONTH_CACHE: dict[int, tuple[int, ...]] = {}


def _days_in_month(year: int, month: int) -> int:
    """Return the number of days in the given ``(year, month)`` pair.

    Cached per (year, month) because the worker (sub-0009-02) calls this
    in a tight loop on every spawn.
    """
    cache_key = year
    months = _DAYS_IN_MONTH_CACHE.get(cache_key)
    if months is None:
        months = tuple(calendar.monthrange(year, m)[1] for m in range(1, 13))
        _DAYS_IN_MONTH_CACHE[cache_key] = months
    return months[month - 1]


def compute_next_run_on(
    *,
    start_on: date,
    cadence: RecurringRuleCadence,
) -> date:
    """Return ``start_on + one cadence step``.

    Rules:

    * ``daily`` → ``start_on + 1 day``.
    * ``weekly`` → ``start_on + 7 days``.
    * ``monthly`` → ``start_on`` advanced by one calendar month, with
      the day clamped to the last valid day of the target month
      (Jan 31 → Feb 28, or Feb 29 → Feb 28 on non-leap years).
    * ``yearly`` → ``start_on`` advanced by one calendar year. Same
      clamp applies for Feb 29 → Feb 28 on non-leap target years.

    The clamp matches what users expect from a typical bill-pay app:
    paying on the 31st means "the last day of every month", not "skip
    February".
    """
    if cadence == RecurringRuleCadence.DAILY:
        from datetime import timedelta

        return start_on + timedelta(days=1)
    if cadence == RecurringRuleCadence.WEEKLY:
        from datetime import timedelta

        return start_on + timedelta(days=7)
    if cadence == RecurringRuleCadence.MONTHLY:
        target_year = start_on.year
        target_month = start_on.month + 1
        if target_month > 12:
            target_month = 1
            target_year += 1
        last_day = _days_in_month(target_year, target_month)
        return date(target_year, target_month, min(start_on.day, last_day))
    if cadence == RecurringRuleCadence.YEARLY:
        target_year = start_on.year + 1
        if start_on.month == 2 and start_on.day == 29 and not calendar.isleap(target_year):
            return date(target_year, 2, 28)
        return date(target_year, start_on.month, start_on.day)
    raise ValueError(f"unsupported cadence: {cadence!r}")


def should_advance_next_run_on(
    *,
    updated_fields: set[str],
) -> bool:
    """Return ``True`` when a PATCH that changes ``start_on`` or
    ``cadence`` should also re-derive ``next_run_on``.

    ``updated_fields`` is the set of field names that appear in the
    PATCH body (after ``model_dump(exclude_unset=True)``); a PATCH that
    touches neither anchor leaves the persisted ``next_run_on`` alone
    so the worker's spawn cadence isn't disrupted.
    """
    return bool({"start_on", "cadence"} & updated_fields)
