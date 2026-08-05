"""Canonical JSON snapshot and deterministic ZIP backup helpers."""

from __future__ import annotations

import binascii
import hashlib
import hmac
import io
import json
import uuid
from datetime import UTC, date, datetime
from decimal import Decimal
from enum import Enum
from typing import TypeAlias
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models.account import Account
from app.db.models.category import Category
from app.db.models.debt import Debt, DebtPayment
from app.db.models.goal import Goal
from app.db.models.transaction import Transaction
from app.db.models.user import User

JSONScalar: TypeAlias = str | int | float | bool | None
JSONValue: TypeAlias = JSONScalar | list["JSONValue"] | dict[str, "JSONValue"]

SCHEMA_VERSION = 1
SNAPSHOT_FILENAME = "transactions.json"
MANIFEST_FILENAME = "manifest.json"
_ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)


def _json_value(value: object) -> JSONValue:
    if value is None or isinstance(value, str | int | float | bool):
        return value
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, datetime):
        if value.tzinfo is not None:
            value = value.astimezone(UTC)
        return value.isoformat().replace("+00:00", "Z")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Enum):
        return _json_value(value.value)
    raise TypeError(f"unsupported export value: {type(value).__name__}")


def _user_payload(user: User) -> dict[str, JSONValue]:
    return {
        "id": _json_value(user.id),
        "email": user.email,
        "created_at": _json_value(user.created_at),
        "updated_at": _json_value(user.updated_at),
    }


def _account_payload(account: Account) -> dict[str, JSONValue]:
    return {
        "id": _json_value(account.id),
        "user_id": _json_value(account.user_id),
        "name": account.name,
        "type": _json_value(account.type),
        "currency": account.currency,
        "opening_balance_cents": account.opening_balance_cents,
        "is_asset": account.is_asset,
        "archived": account.archived,
        "created_at": _json_value(account.created_at),
        "updated_at": _json_value(account.updated_at),
    }


def _category_payload(category: Category) -> dict[str, JSONValue]:
    return {
        "id": _json_value(category.id),
        "user_id": _json_value(category.user_id),
        "name": category.name,
        "kind": _json_value(category.kind),
        "parent_id": _json_value(category.parent_id),
        "color": category.color,
        "icon": category.icon,
        "archived": category.archived,
        "archived_at": _json_value(category.archived_at),
        "created_at": _json_value(category.created_at),
        "updated_at": _json_value(category.updated_at),
    }


def _transaction_payload(transaction: Transaction) -> dict[str, JSONValue]:
    return {
        "id": _json_value(transaction.id),
        "user_id": _json_value(transaction.user_id),
        "account_id": _json_value(transaction.account_id),
        "category_id": _json_value(transaction.category_id),
        "type": _json_value(transaction.type),
        "amount_cents": transaction.amount_cents,
        "currency": transaction.currency,
        "occurred_on": _json_value(transaction.occurred_on),
        "note": transaction.note,
        "transfer_pair_id": _json_value(transaction.transfer_pair_id),
        "transfer_group_id": _json_value(transaction.transfer_group_id),
        "recurring_rule_id": _json_value(transaction.recurring_rule_id),
        "deleted_at": _json_value(transaction.deleted_at),
        "created_at": _json_value(transaction.created_at),
        "updated_at": _json_value(transaction.updated_at),
    }


def _goal_payload(goal: Goal) -> dict[str, JSONValue]:
    return {
        "id": _json_value(goal.id),
        "user_id": _json_value(goal.user_id),
        "kind": _json_value(goal.kind),
        "name": goal.name,
        "target_amount_cents": goal.target_amount_cents,
        "target_date": _json_value(goal.target_date),
        "linked_account_id": _json_value(goal.linked_account_id),
        "current_amount_cents": goal.current_amount_cents,
        "start_date": _json_value(goal.start_date),
        "jangka_waktu_months": goal.jangka_waktu_months,
        "tabungan_bulanan_cents": goal.tabungan_bulanan_cents,
        "monthly_expense_cents": goal.monthly_expense_cents,
        "jumlah_tanggungan": goal.jumlah_tanggungan,
        "multiplier": goal.multiplier,
        "lama_mengumpulkan_bulan": goal.lama_mengumpulkan_bulan,
        "target_amount_snapshot_cents": goal.target_amount_snapshot_cents,
        "notes": goal.notes,
        "archived_at": _json_value(goal.archived_at),
        "achieved_at": _json_value(goal.achieved_at),
        "created_at": _json_value(goal.created_at),
        "updated_at": _json_value(goal.updated_at),
    }


def _payment_payload(payment: DebtPayment) -> dict[str, JSONValue]:
    return {
        "id": _json_value(payment.id),
        "debt_id": _json_value(payment.debt_id),
        "occurred_on": _json_value(payment.occurred_on),
        "amount_cents": payment.amount_cents,
        "principal_portion_cents": payment.principal_portion_cents,
        "interest_portion_cents": payment.interest_portion_cents,
        "source_account_id": _json_value(payment.source_account_id),
        "note": payment.note,
        "created_at": _json_value(payment.created_at),
        "updated_at": _json_value(payment.updated_at),
    }


def _debt_payload(
    debt: Debt,
    payments: list[DebtPayment],
) -> dict[str, JSONValue]:
    return {
        "id": _json_value(debt.id),
        "user_id": _json_value(debt.user_id),
        "name": debt.name,
        "kind": _json_value(debt.kind),
        "principal_cents": debt.principal_cents,
        "bunga_pct": _json_value(debt.bunga_pct),
        "tenor_months": debt.tenor_months,
        "start_date": _json_value(debt.start_date),
        "monthly_payment_cents": debt.monthly_payment_cents,
        "note": debt.note,
        "status": _json_value(debt.status),
        "created_at": _json_value(debt.created_at),
        "updated_at": _json_value(debt.updated_at),
        "payments": [_payment_payload(payment) for payment in payments],
    }


def build_snapshot(
    *,
    db: Session,
    user: User,
    exported_at: datetime,
) -> dict[str, JSONValue]:
    accounts = list(
        db.scalars(
            select(Account).where(Account.user_id == user.id).order_by(Account.id.asc())
        ).all()
    )
    categories = list(
        db.scalars(
            select(Category).where(Category.user_id == user.id).order_by(Category.id.asc())
        ).all()
    )
    transactions = list(
        db.scalars(
            select(Transaction)
            .where(
                Transaction.user_id == user.id,
                Transaction.deleted_at.is_(None),
            )
            .order_by(Transaction.id.asc())
        ).all()
    )
    goals = list(
        db.scalars(select(Goal).where(Goal.user_id == user.id).order_by(Goal.id.asc())).all()
    )
    debts = list(
        db.scalars(select(Debt).where(Debt.user_id == user.id).order_by(Debt.id.asc())).all()
    )
    payments = list(
        db.scalars(
            select(DebtPayment)
            .join(Debt, DebtPayment.debt_id == Debt.id)
            .where(Debt.user_id == user.id)
            .order_by(DebtPayment.debt_id.asc(), DebtPayment.id.asc())
        ).all()
    )
    payments_by_debt: dict[str, list[DebtPayment]] = {}
    for payment in payments:
        payments_by_debt.setdefault(str(payment.debt_id), []).append(payment)

    return {
        "schema_version": SCHEMA_VERSION,
        "exported_at": _json_value(exported_at),
        "user": _user_payload(user),
        "accounts": [_account_payload(account) for account in accounts],
        "categories": [_category_payload(category) for category in categories],
        "transactions": [_transaction_payload(transaction) for transaction in transactions],
        "goals": [_goal_payload(goal) for goal in goals],
        "debts": [_debt_payload(debt, payments_by_debt.get(str(debt.id), [])) for debt in debts],
    }


def canonical_json_bytes(payload: JSONValue) -> bytes:
    return json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _user_id_hash(*, user_id: uuid.UUID, hash_salt: str) -> str:
    if not hash_salt:
        raise ValueError("export hash salt must not be empty")
    return hmac.new(
        hash_salt.encode("utf-8"),
        f"pft-export-user:{user_id}".encode(),
        hashlib.sha256,
    ).hexdigest()


def _zip_info(filename: str) -> ZipInfo:
    info = ZipInfo(filename=filename, date_time=_ZIP_TIMESTAMP)
    info.compress_type = ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = 0o600 << 16
    return info


def build_backup_archive(
    *,
    snapshot: dict[str, JSONValue],
    user_id: uuid.UUID,
    hash_salt: str,
) -> bytes:
    snapshot_bytes = canonical_json_bytes(snapshot)
    crc32 = binascii.crc32(snapshot_bytes) & 0xFFFFFFFF
    created_at = snapshot.get("exported_at")
    if not isinstance(created_at, str):
        raise ValueError("snapshot exported_at must be an ISO-8601 string")
    manifest: dict[str, JSONValue] = {
        "schema_version": SCHEMA_VERSION,
        "created_at": created_at,
        "user_id_hash": _user_id_hash(user_id=user_id, hash_salt=hash_salt),
        "files": [
            {
                "path": SNAPSHOT_FILENAME,
                "crc32": crc32,
                "size": len(snapshot_bytes),
                "sha256": hashlib.sha256(snapshot_bytes).hexdigest(),
            }
        ],
    }
    manifest_bytes = canonical_json_bytes(manifest)

    output = io.BytesIO()
    with ZipFile(output, mode="w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        archive.writestr(_zip_info(SNAPSHOT_FILENAME), snapshot_bytes)
        archive.writestr(_zip_info(MANIFEST_FILENAME), manifest_bytes)
    return output.getvalue()
