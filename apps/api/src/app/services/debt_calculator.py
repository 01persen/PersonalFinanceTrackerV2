from __future__ import annotations

from decimal import ROUND_DOWN, Decimal


def calculate_flat_monthly_payment_cents(
    *,
    principal_cents: int,
    bunga_pct: Decimal,
    tenor_months: int | None,
) -> int | None:
    if tenor_months is None:
        return None
    if principal_cents <= 0:
        raise ValueError("principal_cents must be greater than 0")
    if not bunga_pct.is_finite() or bunga_pct < 0:
        raise ValueError("bunga_pct must be greater than or equal to 0")
    if tenor_months <= 0:
        raise ValueError("tenor_months must be greater than 0")

    principal = Decimal(principal_cents)
    tenor = Decimal(tenor_months)
    total_interest = principal * bunga_pct * tenor / Decimal(1200)
    monthly_payment = (principal + total_interest) / tenor
    return int(monthly_payment.to_integral_value(rounding=ROUND_DOWN))
