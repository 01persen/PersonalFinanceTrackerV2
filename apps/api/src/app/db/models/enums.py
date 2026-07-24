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
    MORTGAGE = "mortgage"
    OTHER = "other"


class DebtStatus(StrEnum):
    ACTIVE = "active"
    PAID_OFF = "paid_off"
