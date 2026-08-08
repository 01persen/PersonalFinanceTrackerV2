"""ORM models (imported here for metadata registration)."""

from app.db.models.account import Account
from app.db.models.category import Category
from app.db.models.category_rule import CategoryRule
from app.db.models.debt import Debt, DebtPayment
from app.db.models.enums import (
    AccountType,
    CategoryKind,
    DebtKind,
    DebtStatus,
    GoalKind,
    RecurringRuleCadence,
    RecurringRuleKind,
    TransactionType,
)
from app.db.models.goal import Goal
from app.db.models.mixins import GUID, TimestampMixin, UserFKMixin, UUIDPKMixin
from app.db.models.recurring_rule import RecurringRule
from app.db.models.rule_audit_log import RuleAuditLog
from app.db.models.transaction import Transaction
from app.db.models.user import User
from app.db.models.user_preference import UserPreference

__all__ = [
    "GUID",
    "Account",
    "AccountType",
    "Category",
    "CategoryKind",
    "CategoryRule",
    "Debt",
    "DebtKind",
    "DebtPayment",
    "DebtStatus",
    "Goal",
    "GoalKind",
    "RecurringRule",
    "RecurringRuleCadence",
    "RecurringRuleKind",
    "RuleAuditLog",
    "TimestampMixin",
    "Transaction",
    "TransactionType",
    "UUIDPKMixin",
    "User",
    "UserFKMixin",
    "UserPreference",
]
