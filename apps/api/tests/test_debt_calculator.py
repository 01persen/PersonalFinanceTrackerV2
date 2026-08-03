from decimal import Decimal

import pytest

from app.services.debt_calculator import calculate_flat_monthly_payment_cents


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
