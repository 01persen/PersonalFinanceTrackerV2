from decimal import Decimal

import pytest

from app.services.debt_calculator import (
    calculate_flat_monthly_payment_cents,
    calculate_flat_total_interest_cents,
)


def test_calculates_twelve_month_flat_payment() -> None:
    assert (
        calculate_flat_monthly_payment_cents(
            principal_cents=12_000_000,
            bunga_pct=Decimal("10"),
            tenor_months=12,
        )
        == 1_100_000
    )


def test_applies_annual_rate_across_multi_year_tenor() -> None:
    assert (
        calculate_flat_monthly_payment_cents(
            principal_cents=12_000_000,
            bunga_pct=Decimal("10"),
            tenor_months=24,
        )
        == 600_000
    )


def test_truncates_fractional_cents() -> None:
    assert (
        calculate_flat_monthly_payment_cents(
            principal_cents=1_000,
            bunga_pct=Decimal("10"),
            tenor_months=12,
        )
        == 91
    )


def test_returns_none_for_nullable_tenor() -> None:
    assert (
        calculate_flat_monthly_payment_cents(
            principal_cents=1_000,
            bunga_pct=Decimal("10"),
            tenor_months=None,
        )
        is None
    )


@pytest.mark.parametrize(
    ("principal_cents", "bunga_pct", "tenor_months"),
    [
        (0, Decimal("10"), 12),
        (-1, Decimal("10"), 12),
        (1_000, Decimal("-0.0001"), 12),
        (1_000, Decimal("NaN"), 12),
        (1_000, Decimal("10"), 0),
        (1_000, Decimal("10"), -1),
    ],
)
def test_rejects_invalid_inputs(
    principal_cents: int,
    bunga_pct: Decimal,
    tenor_months: int,
) -> None:
    with pytest.raises(ValueError):
        calculate_flat_monthly_payment_cents(
            principal_cents=principal_cents,
            bunga_pct=bunga_pct,
            tenor_months=tenor_months,
        )


# --- calculate_flat_total_interest_cents (sub-0006-03) -----------------------


def test_total_interest_for_sample_case() -> None:
    """12jt @ 10% flat / 12 bulan → ~1.2jt total bunga.

    Locks the spec's headline acceptance criterion as a regression
    test so a future refactor of the calculator that breaks the
    spec's example fails loudly.
    """
    assert (
        calculate_flat_total_interest_cents(
            principal_cents=12_000_000,
            bunga_pct=Decimal("10"),
            tenor_months=12,
        )
        == 1_200_000
    )


def test_total_interest_scales_with_tenor() -> None:
    """Two-year tenor doubles the interest vs the one-year sample."""
    assert (
        calculate_flat_total_interest_cents(
            principal_cents=12_000_000,
            bunga_pct=Decimal("10"),
            tenor_months=24,
        )
        == 2_400_000
    )


def test_total_interest_scales_with_rate() -> None:
    """Half the annual rate halves the interest (linear in bunga_pct)."""
    assert (
        calculate_flat_total_interest_cents(
            principal_cents=12_000_000,
            bunga_pct=Decimal("5"),
            tenor_months=12,
        )
        == 600_000
    )


def test_total_interest_scales_with_principal() -> None:
    """Larger principal at the same rate/tenor gives proportionally more interest."""
    assert (
        calculate_flat_total_interest_cents(
            principal_cents=24_000_000,
            bunga_pct=Decimal("10"),
            tenor_months=12,
        )
        == 2_400_000
    )


def test_total_interest_rounds_half_up() -> None:
    """An exact half-cent result rounds up (financial convention).

    The example: principal=120 cents, rate=1%, tenor=5 months →
    exact result is 0.5 cents which ``ROUND_HALF_UP`` lifts to 1.
    The monthly-payment helper uses ROUND_DOWN for the same input —
    they're meant to diverge here so the headline total is in the
    borrower's favour when it lands on an exact half.
    """
    assert (
        calculate_flat_total_interest_cents(
            principal_cents=120,
            bunga_pct=Decimal("1"),
            tenor_months=5,
        )
        == 1
    )


def test_total_interest_truncates_sub_half_fraction() -> None:
    """A sub-half fraction truncates without rounding up.

    Sanity check: ROUND_HALF_UP only affects ties at the exact half;
    100.1 still rounds to 100. Confirms we picked the right rounding
    mode (not ROUND_CEILING which would also lift 0.5 but would
    additionally inflate every partial cent — bad for the borrower).
    """
    # principal=1_001, rate=10%, tenor=12 → 120_120 / 1200 = 100.1
    assert (
        calculate_flat_total_interest_cents(
            principal_cents=1_001,
            bunga_pct=Decimal("10"),
            tenor_months=12,
        )
        == 100
    )


def test_total_interest_zero_for_zero_rate() -> None:
    """A zero interest rate produces zero total interest regardless of principal/tenor."""
    assert (
        calculate_flat_total_interest_cents(
            principal_cents=12_000_000,
            bunga_pct=Decimal("0"),
            tenor_months=12,
        )
        == 0
    )


@pytest.mark.parametrize(
    ("principal_cents", "bunga_pct", "tenor_months"),
    [
        (0, Decimal("10"), 12),
        (-1, Decimal("10"), 12),
        (1_000, Decimal("-0.0001"), 12),
        (1_000, Decimal("NaN"), 12),
        (1_000, Decimal("10"), 0),
        (1_000, Decimal("10"), -1),
    ],
)
def test_total_interest_rejects_invalid_inputs(
    principal_cents: int,
    bunga_pct: Decimal,
    tenor_months: int,
) -> None:
    """Same input-validation contract as the monthly-payment helper.

    Tenor=``None`` is intentionally rejected here (unlike the
    monthly helper, which returns ``None``) because total interest
    has no meaningful answer for an un-scheduled loan — it's a
    scheduling primitive, not a per-installment calculation.
    """
    with pytest.raises(ValueError):
        calculate_flat_total_interest_cents(
            principal_cents=principal_cents,
            bunga_pct=bunga_pct,
            tenor_months=tenor_months,
        )
