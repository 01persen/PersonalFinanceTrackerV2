"""JSON snapshot, ZIP integrity, and restore round-trip coverage."""

from __future__ import annotations

import binascii
import hashlib
import hmac
import io
import json
import uuid
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any
from zipfile import ZipFile

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, func, select
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings
from app.db.base import Base
from app.db.models.account import Account
from app.db.models.category import Category
from app.db.models.debt import Debt, DebtPayment
from app.db.models.enums import (
    AccountType,
    CategoryKind,
    DebtKind,
    DebtStatus,
    GoalKind,
    TransactionType,
)
from app.db.models.goal import Goal
from app.db.models.transaction import Transaction
from app.db.models.user import User
from app.services.export_snapshot import (
    MANIFEST_FILENAME,
    SNAPSHOT_FILENAME,
    build_backup_archive,
    build_snapshot,
    canonical_json_bytes,
)

_PASSWORD = "password123"
_FIXED_NOW = datetime(2026, 8, 5, 12, 30, tzinfo=UTC)
_ACCOUNT_ID = uuid.UUID("10000000-0000-0000-0000-000000000001")
_ARCHIVED_ACCOUNT_ID = uuid.UUID("10000000-0000-0000-0000-000000000002")
_CATEGORY_ID = uuid.UUID("20000000-0000-0000-0000-000000000001")
_ACTIVE_TRANSACTION_ID = uuid.UUID("30000000-0000-0000-0000-000000000001")
_DELETED_TRANSACTION_ID = uuid.UUID("30000000-0000-0000-0000-000000000002")
_GOAL_ID = uuid.UUID("40000000-0000-0000-0000-000000000001")
_DEBT_ID = uuid.UUID("50000000-0000-0000-0000-000000000001")
_PAYMENT_ID = uuid.UUID("60000000-0000-0000-0000-000000000001")


def _register(client: TestClient, email: str) -> str:
    response = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": _PASSWORD},
    )
    assert response.status_code == 201, response.text
    return str(response.json()["access_token"])


def _headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _get_user(db: Session, email: str) -> User:
    db.expire_all()
    user = db.scalar(select(User).where(User.email == email))
    assert user is not None
    return user


def _seed_owned_snapshot(db: Session, user: User) -> None:
    account = Account(
        id=_ACCOUNT_ID,
        user_id=user.id,
        name="Primary Bank",
        type=AccountType.BANK,
        currency="IDR",
        opening_balance_cents=2_500_000,
        is_asset=True,
        archived=False,
        created_at=_FIXED_NOW,
        updated_at=_FIXED_NOW,
    )
    archived_account = Account(
        id=_ARCHIVED_ACCOUNT_ID,
        user_id=user.id,
        name="Closed Wallet",
        type=AccountType.E_WALLET,
        currency="IDR",
        opening_balance_cents=75_000,
        is_asset=True,
        archived=True,
        created_at=_FIXED_NOW,
        updated_at=_FIXED_NOW,
    )
    category = Category(
        id=_CATEGORY_ID,
        user_id=user.id,
        name="Export Category",
        kind=CategoryKind.EXPENSE,
        color="#112233",
        icon="receipt",
        archived=False,
        archived_at=None,
        created_at=_FIXED_NOW,
        updated_at=_FIXED_NOW,
    )
    active_transaction = Transaction(
        id=_ACTIVE_TRANSACTION_ID,
        user_id=user.id,
        account_id=account.id,
        category_id=category.id,
        type=TransactionType.EXPENSE,
        amount_cents=125_500,
        currency="IDR",
        occurred_on=date(2026, 8, 4),
        note="Makan siang",
        created_at=_FIXED_NOW,
        updated_at=_FIXED_NOW,
    )
    deleted_transaction = Transaction(
        id=_DELETED_TRANSACTION_ID,
        user_id=user.id,
        account_id=account.id,
        category_id=category.id,
        type=TransactionType.EXPENSE,
        amount_cents=10_000,
        currency="IDR",
        occurred_on=date(2026, 8, 3),
        note="Deleted",
        deleted_at=_FIXED_NOW,
        created_at=_FIXED_NOW,
        updated_at=_FIXED_NOW,
    )
    goal = Goal(
        id=_GOAL_ID,
        user_id=user.id,
        kind=GoalKind.SAVING,
        name="Dana liburan",
        target_amount_cents=10_000_000,
        target_date=date(2027, 8, 5),
        linked_account_id=account.id,
        current_amount_cents=None,
        start_date=date(2026, 8, 5),
        jangka_waktu_months=12,
        tabungan_bulanan_cents=833_333,
        notes="Target tahunan",
        archived_at=None,
        achieved_at=None,
        created_at=_FIXED_NOW,
        updated_at=_FIXED_NOW,
    )
    debt = Debt(
        id=_DEBT_ID,
        user_id=user.id,
        name="Kredit motor",
        kind=DebtKind.LOAN,
        principal_cents=12_000_000,
        bunga_pct=Decimal("7.2500"),
        tenor_months=12,
        start_date=date(2026, 1, 1),
        monthly_payment_cents=1_072_500,
        note="Flat",
        status=DebtStatus.ACTIVE,
        created_at=_FIXED_NOW,
        updated_at=_FIXED_NOW,
    )
    payment = DebtPayment(
        id=_PAYMENT_ID,
        debt_id=debt.id,
        occurred_on=date(2026, 2, 1),
        amount_cents=1_072_500,
        principal_portion_cents=1_000_000,
        interest_portion_cents=72_500,
        source_account_id=account.id,
        note="Cicilan pertama",
        created_at=_FIXED_NOW,
        updated_at=_FIXED_NOW,
    )
    db.add_all(
        [
            account,
            archived_account,
            category,
            active_transaction,
            deleted_transaction,
            goal,
            debt,
            payment,
        ]
    )
    db.commit()


def _seed_foreign_transaction(db: Session, user: User) -> uuid.UUID:
    account_id = uuid.UUID("70000000-0000-0000-0000-000000000001")
    transaction_id = uuid.UUID("70000000-0000-0000-0000-000000000002")
    db.add(
        Account(
            id=account_id,
            user_id=user.id,
            name="Foreign Bank",
            type=AccountType.BANK,
            currency="IDR",
            opening_balance_cents=0,
            is_asset=True,
            archived=False,
            created_at=_FIXED_NOW,
            updated_at=_FIXED_NOW,
        )
    )
    db.add(
        Transaction(
            id=transaction_id,
            user_id=user.id,
            account_id=account_id,
            category_id=None,
            type=TransactionType.INCOME,
            amount_cents=9_999_999,
            currency="IDR",
            occurred_on=date(2026, 8, 5),
            note="Foreign",
            created_at=_FIXED_NOW,
            updated_at=_FIXED_NOW,
        )
    )
    db.commit()
    return transaction_id


def _parse_datetime(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _restore_snapshot(snapshot: dict[str, Any], target: Session) -> User:
    user_data = snapshot["user"]
    user = User(
        id=uuid.UUID(user_data["id"]),
        email=user_data["email"],
        password_hash="restored-password-hash",
        created_at=_parse_datetime(user_data["created_at"]),
        updated_at=_parse_datetime(user_data["updated_at"]),
    )
    target.add(user)
    target.flush()

    for item in snapshot["accounts"]:
        target.add(
            Account(
                id=uuid.UUID(item["id"]),
                user_id=uuid.UUID(item["user_id"]),
                name=item["name"],
                type=AccountType(item["type"]),
                currency=item["currency"],
                opening_balance_cents=item["opening_balance_cents"],
                is_asset=item["is_asset"],
                archived=item["archived"],
                created_at=_parse_datetime(item["created_at"]),
                updated_at=_parse_datetime(item["updated_at"]),
            )
        )
    target.flush()

    pending_categories = list(snapshot["categories"])
    restored_category_ids: set[str] = set()
    while pending_categories:
        restored_this_pass = False
        for item in list(pending_categories):
            parent_id = item["parent_id"]
            if parent_id is not None and parent_id not in restored_category_ids:
                continue
            target.add(
                Category(
                    id=uuid.UUID(item["id"]),
                    user_id=uuid.UUID(item["user_id"]),
                    name=item["name"],
                    kind=CategoryKind(item["kind"]),
                    parent_id=uuid.UUID(parent_id) if parent_id else None,
                    color=item["color"],
                    icon=item["icon"],
                    archived=item["archived"],
                    archived_at=(
                        _parse_datetime(item["archived_at"]) if item["archived_at"] else None
                    ),
                    created_at=_parse_datetime(item["created_at"]),
                    updated_at=_parse_datetime(item["updated_at"]),
                )
            )
            target.flush()
            restored_category_ids.add(item["id"])
            pending_categories.remove(item)
            restored_this_pass = True
        if not restored_this_pass:
            raise AssertionError("category hierarchy cannot be restored")

    for item in snapshot["transactions"]:
        target.add(
            Transaction(
                id=uuid.UUID(item["id"]),
                user_id=uuid.UUID(item["user_id"]),
                account_id=uuid.UUID(item["account_id"]),
                category_id=uuid.UUID(item["category_id"]) if item["category_id"] else None,
                type=TransactionType(item["type"]),
                amount_cents=item["amount_cents"],
                currency=item["currency"],
                occurred_on=date.fromisoformat(item["occurred_on"]),
                note=item["note"],
                transfer_pair_id=(
                    uuid.UUID(item["transfer_pair_id"]) if item["transfer_pair_id"] else None
                ),
                transfer_group_id=(
                    uuid.UUID(item["transfer_group_id"]) if item["transfer_group_id"] else None
                ),
                recurring_rule_id=(
                    uuid.UUID(item["recurring_rule_id"]) if item["recurring_rule_id"] else None
                ),
                deleted_at=(_parse_datetime(item["deleted_at"]) if item["deleted_at"] else None),
                created_at=_parse_datetime(item["created_at"]),
                updated_at=_parse_datetime(item["updated_at"]),
            )
        )
    target.flush()

    for item in snapshot["goals"]:
        target.add(
            Goal(
                id=uuid.UUID(item["id"]),
                user_id=uuid.UUID(item["user_id"]),
                kind=GoalKind(item["kind"]),
                name=item["name"],
                target_amount_cents=item["target_amount_cents"],
                target_date=(
                    date.fromisoformat(item["target_date"]) if item["target_date"] else None
                ),
                linked_account_id=(
                    uuid.UUID(item["linked_account_id"]) if item["linked_account_id"] else None
                ),
                current_amount_cents=item["current_amount_cents"],
                start_date=date.fromisoformat(item["start_date"]),
                jangka_waktu_months=item["jangka_waktu_months"],
                tabungan_bulanan_cents=item["tabungan_bulanan_cents"],
                monthly_expense_cents=item["monthly_expense_cents"],
                jumlah_tanggungan=item["jumlah_tanggungan"],
                multiplier=item["multiplier"],
                lama_mengumpulkan_bulan=item["lama_mengumpulkan_bulan"],
                target_amount_snapshot_cents=item["target_amount_snapshot_cents"],
                notes=item["notes"],
                archived_at=(_parse_datetime(item["archived_at"]) if item["archived_at"] else None),
                achieved_at=(_parse_datetime(item["achieved_at"]) if item["achieved_at"] else None),
                created_at=_parse_datetime(item["created_at"]),
                updated_at=_parse_datetime(item["updated_at"]),
            )
        )
    target.flush()

    for item in snapshot["debts"]:
        target.add(
            Debt(
                id=uuid.UUID(item["id"]),
                user_id=uuid.UUID(item["user_id"]),
                name=item["name"],
                kind=DebtKind(item["kind"]),
                principal_cents=item["principal_cents"],
                bunga_pct=Decimal(item["bunga_pct"]),
                tenor_months=item["tenor_months"],
                start_date=date.fromisoformat(item["start_date"]),
                monthly_payment_cents=item["monthly_payment_cents"],
                note=item["note"],
                status=DebtStatus(item["status"]),
                created_at=_parse_datetime(item["created_at"]),
                updated_at=_parse_datetime(item["updated_at"]),
            )
        )
    target.flush()

    for debt_data in snapshot["debts"]:
        for item in debt_data["payments"]:
            target.add(
                DebtPayment(
                    id=uuid.UUID(item["id"]),
                    debt_id=uuid.UUID(item["debt_id"]),
                    occurred_on=date.fromisoformat(item["occurred_on"]),
                    amount_cents=item["amount_cents"],
                    principal_portion_cents=item["principal_portion_cents"],
                    interest_portion_cents=item["interest_portion_cents"],
                    source_account_id=(
                        uuid.UUID(item["source_account_id"]) if item["source_account_id"] else None
                    ),
                    note=item["note"],
                    created_at=_parse_datetime(item["created_at"]),
                    updated_at=_parse_datetime(item["updated_at"]),
                )
            )
    target.commit()
    target.refresh(user)
    return user


def test_json_and_zip_exports_require_authentication(
    client: TestClient,
    fresh_db: Session,
) -> None:
    assert fresh_db is not None
    json_response = client.get("/api/v1/export/transactions.json")
    zip_response = client.get("/api/v1/export/backup.zip")
    assert json_response.status_code == 401
    assert zip_response.status_code == 401
    assert json_response.headers["www-authenticate"] == "Bearer"
    assert zip_response.headers["www-authenticate"] == "Bearer"


def test_json_export_is_complete_soft_delete_aware_and_user_scoped(
    client: TestClient,
    fresh_db: Session,
) -> None:
    token = _register(client, "snapshot@example.com")
    user = _get_user(fresh_db, "snapshot@example.com")
    _seed_owned_snapshot(fresh_db, user)
    _register(client, "foreign@example.com")
    foreign_user = _get_user(fresh_db, "foreign@example.com")
    foreign_transaction_id = _seed_foreign_transaction(fresh_db, foreign_user)

    response = client.get("/api/v1/export/transactions.json", headers=_headers(token))

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/json"
    assert response.headers["content-disposition"].startswith('attachment; filename="transactions-')
    payload = response.json()
    assert set(payload) == {
        "schema_version",
        "exported_at",
        "user",
        "accounts",
        "categories",
        "transactions",
        "goals",
        "debts",
    }
    assert payload["schema_version"] == 1
    assert payload["user"]["id"] == str(user.id)
    assert payload["user"]["email"] == "snapshot@example.com"
    assert "password_hash" not in payload["user"]
    assert [item["id"] for item in payload["accounts"]] == sorted(
        item["id"] for item in payload["accounts"]
    )
    assert str(_ARCHIVED_ACCOUNT_ID) in {item["id"] for item in payload["accounts"]}
    transaction_ids = {item["id"] for item in payload["transactions"]}
    assert str(_ACTIVE_TRANSACTION_ID) in transaction_ids
    assert str(_DELETED_TRANSACTION_ID) not in transaction_ids
    assert str(foreign_transaction_id) not in transaction_ids
    assert all(item["user_id"] == str(user.id) for item in payload["accounts"])
    assert all(item["user_id"] == str(user.id) for item in payload["categories"])
    assert all(item["user_id"] == str(user.id) for item in payload["transactions"])
    assert all(item["user_id"] == str(user.id) for item in payload["goals"])
    assert all(item["user_id"] == str(user.id) for item in payload["debts"])
    exported_debt = next(item for item in payload["debts"] if item["id"] == str(_DEBT_ID))
    assert exported_debt["bunga_pct"] == "7.2500"
    assert exported_debt["payments"][0]["id"] == str(_PAYMENT_ID)


def test_snapshot_and_zip_bytes_are_deterministic_for_fixed_export_time(
    client: TestClient,
    fresh_db: Session,
) -> None:
    _register(client, "deterministic@example.com")
    user = _get_user(fresh_db, "deterministic@example.com")
    _seed_owned_snapshot(fresh_db, user)

    first_snapshot = build_snapshot(db=fresh_db, user=user, exported_at=_FIXED_NOW)
    second_snapshot = build_snapshot(db=fresh_db, user=user, exported_at=_FIXED_NOW)
    first_json = canonical_json_bytes(first_snapshot)
    second_json = canonical_json_bytes(second_snapshot)
    first_archive = build_backup_archive(
        snapshot=first_snapshot,
        user_id=user.id,
        hash_salt="deterministic-test-salt",
    )
    second_archive = build_backup_archive(
        snapshot=second_snapshot,
        user_id=user.id,
        hash_salt="deterministic-test-salt",
    )

    assert first_json == second_json
    assert first_archive == second_archive
    assert (
        first_json
        == json.dumps(
            json.loads(first_json),
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode()
    )


def test_backup_manifest_matches_zip_entries_and_salted_user_hash(
    client: TestClient,
    fresh_db: Session,
) -> None:
    _register(client, "manifest@example.com")
    user = _get_user(fresh_db, "manifest@example.com")
    _seed_owned_snapshot(fresh_db, user)
    snapshot = build_snapshot(db=fresh_db, user=user, exported_at=_FIXED_NOW)
    salt = "manifest-test-salt"
    archive_bytes = build_backup_archive(
        snapshot=snapshot,
        user_id=user.id,
        hash_salt=salt,
    )

    with ZipFile(io.BytesIO(archive_bytes)) as archive:
        assert archive.namelist() == [SNAPSHOT_FILENAME, MANIFEST_FILENAME]
        assert archive.testzip() is None
        snapshot_bytes = archive.read(SNAPSHOT_FILENAME)
        manifest = json.loads(archive.read(MANIFEST_FILENAME))
        file_entry = manifest["files"][0]
        snapshot_info = archive.getinfo(SNAPSHOT_FILENAME)

    expected_hash = hmac.new(
        salt.encode(),
        f"pft-export-user:{user.id}".encode(),
        hashlib.sha256,
    ).hexdigest()
    assert manifest["schema_version"] == 1
    assert manifest["created_at"] == snapshot["exported_at"]
    assert manifest["user_id_hash"] == expected_hash
    assert str(user.id) not in json.dumps(manifest)
    assert file_entry["path"] == SNAPSHOT_FILENAME
    assert file_entry["crc32"] == snapshot_info.CRC
    assert file_entry["crc32"] == binascii.crc32(snapshot_bytes) & 0xFFFFFFFF
    assert file_entry["size"] == snapshot_info.file_size == len(snapshot_bytes)
    assert file_entry["sha256"] == hashlib.sha256(snapshot_bytes).hexdigest()


def test_backup_endpoint_returns_valid_dated_zip(
    client: TestClient,
    fresh_db: Session,
) -> None:
    token = _register(client, "backup-endpoint@example.com")
    user = _get_user(fresh_db, "backup-endpoint@example.com")
    _seed_owned_snapshot(fresh_db, user)

    response = client.get("/api/v1/export/backup.zip", headers=_headers(token))

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"
    assert response.headers["content-disposition"].startswith('attachment; filename="backup-')
    with ZipFile(io.BytesIO(response.content)) as archive:
        assert archive.testzip() is None
        snapshot = json.loads(archive.read(SNAPSHOT_FILENAME))
        manifest = json.loads(archive.read(MANIFEST_FILENAME))
    assert snapshot["user"]["id"] == str(user.id)
    assert (
        manifest["user_id_hash"]
        == hmac.new(
            (get_settings().export_hash_salt or get_settings().jwt_secret).encode(),
            f"pft-export-user:{user.id}".encode(),
            hashlib.sha256,
        ).hexdigest()
    )


def test_backup_restore_round_trip_preserves_counts_and_snapshot_checksum(
    client: TestClient,
    fresh_db: Session,
    tmp_path: Path,
) -> None:
    _register(client, "restore@example.com")
    source_user = _get_user(fresh_db, "restore@example.com")
    _seed_owned_snapshot(fresh_db, source_user)
    source_snapshot = build_snapshot(db=fresh_db, user=source_user, exported_at=_FIXED_NOW)
    source_archive = build_backup_archive(
        snapshot=source_snapshot,
        user_id=source_user.id,
        hash_salt="restore-test-salt",
    )
    with ZipFile(io.BytesIO(source_archive)) as archive:
        restored_payload = json.loads(archive.read(SNAPSHOT_FILENAME))

    engine = create_engine(f"sqlite:///{tmp_path / 'restore.db'}", future=True)

    @event.listens_for(engine, "connect")
    def _enable_foreign_keys(dbapi_connection, _connection_record) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    Base.metadata.create_all(engine)
    target_factory = sessionmaker(bind=engine, expire_on_commit=False)
    try:
        with target_factory() as target:
            restored_user = _restore_snapshot(restored_payload, target)
            restored_snapshot = build_snapshot(
                db=target,
                user=restored_user,
                exported_at=_FIXED_NOW,
            )
            counts = {
                "accounts": target.scalar(select(func.count(Account.id))),
                "categories": target.scalar(select(func.count(Category.id))),
                "transactions": target.scalar(select(func.count(Transaction.id))),
                "goals": target.scalar(select(func.count(Goal.id))),
                "debts": target.scalar(select(func.count(Debt.id))),
                "payments": target.scalar(select(func.count(DebtPayment.id))),
            }
    finally:
        Base.metadata.drop_all(engine)
        engine.dispose()

    assert counts == {
        "accounts": len(source_snapshot["accounts"]),
        "categories": len(source_snapshot["categories"]),
        "transactions": len(source_snapshot["transactions"]),
        "goals": len(source_snapshot["goals"]),
        "debts": len(source_snapshot["debts"]),
        "payments": sum(len(item["payments"]) for item in source_snapshot["debts"]),
    }
    assert (
        hashlib.sha256(canonical_json_bytes(restored_snapshot)).hexdigest()
        == hashlib.sha256(canonical_json_bytes(source_snapshot)).hexdigest()
    )
