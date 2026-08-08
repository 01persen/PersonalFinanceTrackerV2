"""Enum types for the data model.

The literal values are intentionally snake_case in Python, mapped to their
canonical lowercase string value in the DB. Use ``AccountType.CASH.value``
or just ``"cash"`` at the API surface.
"""

from __future__ import annotations

from enum import StrEnum


class AccountType(StrEnum):
    CASH = "cash"
    BANK = "bank"
    E_WALLET = "e_wallet"
    INVESTMENT = "investment"
    CREDIT_CARD = "credit_card"
    OTHER = "other"


class CategoryKind(StrEnum):
    INCOME = "income"
    EXPENSE = "expense"


class TransactionType(StrEnum):
    INCOME = "income"
    EXPENSE = "expense"
    TRANSFER = "transfer"


class GoalKind(StrEnum):
    SAVING = "saving"
    EMERGENCY_FUND = "emergency_fund"


class DebtKind(StrEnum):
    LOAN = "loan"
    CREDIT_CARD = "credit_card"
    PAYLATER = "paylater"
    KTA = "KTA"
    KKB = "KKB"
    KPR = "KPR"
    OTHER = "other"


class DebtStatus(StrEnum):
    ACTIVE = "active"
    PAID_OFF = "paid_off"


class RecurringRuleKind(StrEnum):
    """Discriminator for the recurring rule rows created in sub-0009-01.

    PRD §epic-0009 locks the three MVP flavours:

    * ``bill`` — kartu kredit / tagihan dengan nominal fixed per cycle.
    * ``subscription`` — Netflix, Spotify, internet, dan langganan tetap.
    * ``cicilan_fixed`` — cicilan flat (KPR, KKB, KTA) yang nominalnya
      tidak berubah per cycle.

    All three are auto-materialized as expense transactions by the
    worker in sub-0009-02. Salary / income nominal yang variabel tetap
    manual (out-of-scope untuk epic ini).
    """

    BILL = "bill"
    SUBSCRIPTION = "subscription"
    CICILAN_FIXED = "cicilan_fixed"


class RecurringRuleCadence(StrEnum):
    """Cadence for the next-run computation on a recurring rule.

    ``daily`` / ``weekly`` advances by 1 / 7 days. ``monthly`` advances
    by one calendar month — e.g. start_on = 2026-01-31 → next_run_on =
    2026-02-28 (clamp to last-day-of-month when the target month is
    shorter). ``yearly`` advances by one calendar year (Feb 29 → Feb 28
    on non-leap target years).
    """

    DAILY = "daily"
    WEEKLY = "weekly"
    MONTHLY = "monthly"
    YEARLY = "yearly"
