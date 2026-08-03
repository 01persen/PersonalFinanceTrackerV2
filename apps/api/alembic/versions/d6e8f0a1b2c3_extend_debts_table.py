from __future__ import annotations

from collections.abc import Sequence
from decimal import ROUND_DOWN, Decimal

import sqlalchemy as sa
from alembic import op

revision: str = "d6e8f0a1b2c3"
down_revision: str | Sequence[str] | None = "c5a7b9c1d3e4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _calculate_monthly_payment(
    principal_cents: int,
    bunga_pct: object,
    tenor_months: int | None,
) -> int | None:
    rate = Decimal(str(bunga_pct))
    if principal_cents <= 0 or not rate.is_finite() or rate < 0:
        return None
    if tenor_months is None or tenor_months <= 0:
        return None
    principal = Decimal(principal_cents)
    tenor = Decimal(tenor_months)
    total_interest = principal * rate * tenor / Decimal(1200)
    monthly_payment = (principal + total_interest) / tenor
    return int(monthly_payment.to_integral_value(rounding=ROUND_DOWN))


def upgrade() -> None:
    op.alter_column(
        "debts",
        "interest_rate",
        new_column_name="bunga_pct",
        existing_type=sa.Numeric(precision=7, scale=4),
        existing_nullable=False,
    )
    op.add_column(
        "debts",
        sa.Column("monthly_payment_cents", sa.BigInteger(), nullable=True),
    )

    bind = op.get_bind()
    bind.execute(
        sa.text(
            """
            UPDATE debts
            SET kind = CASE lower(kind)
                WHEN 'loan' THEN 'LOAN'
                WHEN 'credit_card' THEN 'CREDIT_CARD'
                WHEN 'mortgage' THEN 'KPR'
                WHEN 'other' THEN 'OTHER'
                ELSE kind
            END
            """
        )
    )
    rows = list(
        bind.execute(
            sa.text(
                """
                SELECT id, principal_cents, bunga_pct, tenor_months
                FROM debts
                """
            )
        ).mappings()
    )
    for row in rows:
        monthly_payment = _calculate_monthly_payment(
            int(row["principal_cents"]),
            row["bunga_pct"],
            row["tenor_months"],
        )
        bind.execute(
            sa.text(
                """
                UPDATE debts
                SET monthly_payment_cents = :monthly_payment_cents
                WHERE id = :id
                """
            ),
            {
                "id": row["id"],
                "monthly_payment_cents": monthly_payment,
            },
        )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(
            """
            UPDATE debts
            SET kind = CASE lower(kind)
                WHEN 'loan' THEN 'LOAN'
                WHEN 'credit_card' THEN 'CREDIT_CARD'
                WHEN 'kpr' THEN 'MORTGAGE'
                WHEN 'paylater' THEN 'OTHER'
                WHEN 'kta' THEN 'OTHER'
                WHEN 'kkb' THEN 'OTHER'
                WHEN 'other' THEN 'OTHER'
                ELSE kind
            END
            """
        )
    )
    if bind.dialect.name == "sqlite":
        with op.batch_alter_table("debts", recreate="always") as batch_op:
            batch_op.drop_column("monthly_payment_cents")
    else:
        op.drop_column("debts", "monthly_payment_cents")
    op.alter_column(
        "debts",
        "bunga_pct",
        new_column_name="interest_rate",
        existing_type=sa.Numeric(precision=7, scale=4),
        existing_nullable=False,
    )
