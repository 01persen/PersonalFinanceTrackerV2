"""Recurring-rule service tests (sub-0009-01) — pure compute functions.

Scope: :mod:`app.services.recurring_rules` — the ``compute_next_run_on``
date-arithmetic helper the CRUD router and (eventually) the materializer
worker share. No DB or HTTP layer here; everything is in-process and
fast.

Scenarios covered:

* **(a) Daily cadence** — ``start_on + 1 day``.
* **(b) Weekly cadence** — ``start_on + 7 days``.
* **(c) Monthly cadence** — ``start_on + 1 calendar month``, with the
  day clamped to the last valid day of the target month (Jan 31 →
  Feb 28, Mar 31 → Apr 30). Crossing a year boundary (Dec → Jan).
* **(d) Yearly cadence** — ``start_on + 1 calendar year``, with the
  Feb 29 leap-day clamp on non-leap target years.
* **(e) ``should_advance_next_run_on``** — returns True when
  ``start_on`` or ``cadence`` is in the PATCH set; False otherwise.
"""

from __future__ import annotations

from datetime import date

import pytest

from app.db.models.enums import RecurringRuleCadence
from app.services.recurring_rules import (
    compute_next_run_on,
    should_advance_next_run_on,
)

# ---------------------------------------------------------------------------
# (a) Daily cadence
# ---------------------------------------------------------------------------


def test_compute_next_run_on_daily_advances_by_one_day() -> None:
    """Daily cadence → start_on + 1 day."""
    assert compute_next_run_on(
        start_on=date(2026, 8, 15),
        cadence=RecurringRuleCadence.DAILY,
    ) == date(2026, 8, 16)


def test_compute_next_run_on_daily_crosses_month_boundary() -> None:
    """Daily cadence → crosses month boundary correctly."""
    assert compute_next_run_on(
        start_on=date(2026, 8, 31),
        cadence=RecurringRuleCadence.DAILY,
    ) == date(2026, 9, 1)


# ---------------------------------------------------------------------------
# (b) Weekly cadence
# ---------------------------------------------------------------------------


def test_compute_next_run_on_weekly_advances_by_seven_days() -> None:
    """Weekly cadence → start_on + 7 days."""
    assert compute_next_run_on(
        start_on=date(2026, 8, 15),
        cadence=RecurringRuleCadence.WEEKLY,
    ) == date(2026, 8, 22)


def test_compute_next_run_on_weekly_crosses_year_boundary() -> None:
    """Weekly cadence → crosses year boundary correctly."""
    assert compute_next_run_on(
        start_on=date(2026, 12, 30),
        cadence=RecurringRuleCadence.WEEKLY,
    ) == date(2027, 1, 6)


# ---------------------------------------------------------------------------
# (c) Monthly cadence
# ---------------------------------------------------------------------------


def test_compute_next_run_on_monthly_same_day() -> None:
    """Monthly cadence with a day that exists in the target month."""
    assert compute_next_run_on(
        start_on=date(2026, 8, 15),
        cadence=RecurringRuleCadence.MONTHLY,
    ) == date(2026, 9, 15)


def test_compute_next_run_on_monthly_clamps_jan_31_to_feb_28() -> None:
    """Monthly cadence with day 31 in a 30-day target month → clamp.

    2026 is not a leap year so Feb has 28 days.
    """
    assert compute_next_run_on(
        start_on=date(2026, 1, 31),
        cadence=RecurringRuleCadence.MONTHLY,
    ) == date(2026, 2, 28)


def test_compute_next_run_on_monthly_clamps_to_feb_29_in_leap_year() -> None:
    """Monthly cadence with day 31 in a leap-year Feb → clamp to 29.

    2024 is a leap year so Feb has 29 days.
    """
    assert compute_next_run_on(
        start_on=date(2024, 1, 31),
        cadence=RecurringRuleCadence.MONTHLY,
    ) == date(2024, 2, 29)


def test_compute_next_run_on_monthly_clamps_mar_31_to_apr_30() -> None:
    """Monthly cadence Mar 31 → Apr 30 (April has 30 days)."""
    assert compute_next_run_on(
        start_on=date(2026, 3, 31),
        cadence=RecurringRuleCadence.MONTHLY,
    ) == date(2026, 4, 30)


def test_compute_next_run_on_monthly_crosses_year_boundary() -> None:
    """Monthly cadence Dec → Jan."""
    assert compute_next_run_on(
        start_on=date(2026, 12, 15),
        cadence=RecurringRuleCadence.MONTHLY,
    ) == date(2027, 1, 15)


# ---------------------------------------------------------------------------
# (d) Yearly cadence
# ---------------------------------------------------------------------------


def test_compute_next_run_on_yearly_same_calendar_day() -> None:
    """Yearly cadence → same calendar day in the next year."""
    assert compute_next_run_on(
        start_on=date(2026, 8, 15),
        cadence=RecurringRuleCadence.YEARLY,
    ) == date(2027, 8, 15)


def test_compute_next_run_on_yearly_clamps_feb_29_to_feb_28_non_leap() -> None:
    """Yearly cadence Feb 29 in a leap source year → Feb 28 on non-leap."""
    assert compute_next_run_on(
        start_on=date(2024, 2, 29),  # leap year
        cadence=RecurringRuleCadence.YEARLY,
    ) == date(2025, 2, 28)


def test_compute_next_run_on_yearly_feb_29_leap_to_leap() -> None:
    """Yearly +1 step from Feb 29 2024 → Feb 28 2025 (next year not leap)."""
    # The yearly cadence advances by ONE calendar year per call (the
    # materializer re-invokes it after each spawn), so 2024-02-29 →
    # 2025-02-28. The leap-to-leap case (2024 → 2028) lands on the
    # 4th invocation; we don't assert that here because the helper is
    # single-step.
    assert compute_next_run_on(
        start_on=date(2024, 2, 29),
        cadence=RecurringRuleCadence.YEARLY,
    ) == date(2025, 2, 28)


# ---------------------------------------------------------------------------
# (e) should_advance_next_run_on
# ---------------------------------------------------------------------------


def test_should_advance_next_run_on_true_when_start_on_changes() -> None:
    """``start_on`` in the patch set → re-derive."""
    assert should_advance_next_run_on(updated_fields={"start_on"}) is True


def test_should_advance_next_run_on_true_when_cadence_changes() -> None:
    """``cadence`` in the patch set → re-derive."""
    assert should_advance_next_run_on(updated_fields={"cadence"}) is True


def test_should_advance_next_run_on_true_when_both_change() -> None:
    """Both anchors in the patch set → re-derive."""
    assert should_advance_next_run_on(updated_fields={"start_on", "cadence"}) is True


def test_should_advance_next_run_on_false_when_only_unrelated_fields_change() -> None:
    """Other fields (note, amount_cents, end_on) → don't re-derive."""
    assert (
        should_advance_next_run_on(updated_fields={"note", "amount_cents", "end_on", "is_active"})
        is False
    )


def test_should_advance_next_run_on_false_for_empty_set() -> None:
    """Empty patch set → don't re-derive (defensive)."""
    assert should_advance_next_run_on(updated_fields=set()) is False


@pytest.mark.parametrize(
    ("start_on", "expected"),
    [
        (date(2026, 1, 1), date(2027, 1, 1)),
        (date(2026, 7, 15), date(2027, 7, 15)),
        (date(2025, 2, 28), date(2026, 2, 28)),
    ],
)
def test_compute_next_run_on_yearly_parametrized(start_on: date, expected: date) -> None:
    """Yearly cadence happy paths across the calendar."""
    assert (
        compute_next_run_on(
            start_on=start_on,
            cadence=RecurringRuleCadence.YEARLY,
        )
        == expected
    )


# Sanity check — daily cadence uses Python's ``timedelta``, so a long
# span should not overflow into a different month/year accidentally.
def test_compute_next_run_on_daily_one_year_span() -> None:
    """Daily cadence across a full year boundary is +1 day."""
    assert compute_next_run_on(
        start_on=date(2026, 12, 31),
        cadence=RecurringRuleCadence.DAILY,
    ) == date(2027, 1, 1)


def test_compute_next_run_on_weekly_crosses_leap_day() -> None:
    """Weekly cadence handles the leap day gap (2024 is leap)."""
    assert compute_next_run_on(
        start_on=date(2024, 2, 26),
        cadence=RecurringRuleCadence.WEEKLY,
    ) == date(2024, 3, 4)
