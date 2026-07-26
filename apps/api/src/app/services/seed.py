"""Default seed data applied to a brand-new user.

Triggered from the auth ``/register`` endpoint. Idempotent — safe to call more
than once for the same user (e.g. on retry from the FE after a network blip).

Source of truth for the seed lists: PRD §14 (Default Seed Data). Update both
this module and the PRD when the spreadsheet template changes.
"""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models.category import Category
from app.db.models.enums import CategoryKind
from app.db.models.user import User
from app.db.models.user_preference import UserPreference

# Locale + currency defaults — Indonesian first-user (PRD §14).
DEFAULT_LOCALE = "id-ID"
DEFAULT_CURRENCY = "IDR"
DEFAULT_EMERGENCY_FUND_MULTIPLIER = 3
DEFAULT_DEPENDENTS_COUNT = 1
DEFAULT_THEME = "system"

# Top-level (parent) expense category names that group the leaf categories
# under them. Anything not listed here is treated as a root category.
_EXPENSE_PARENTS: tuple[str, ...] = (
    "Cicilan",
    "Rutinitas",
    "Tabungan & Investasi",
    "Belanja",
)

# Default income categories (PRD §14) — flat, no parent grouping.
_DEFAULT_INCOME_CATEGORIES: tuple[str, ...] = (
    "Gaji",
    "Gaji Pasangan",
    "Bonus",
    "Hadiah",
    "Pendapatan Lain",
    "Hutang Diterima",
    "Piutang Diterima",
)

# Default expense categories (PRD §14) — grouped under the parents above.
# Anything starting with `_` (private to this dict) is intentionally not used.
_DEFAULT_EXPENSE_CATEGORIES: dict[str, tuple[str, ...]] = {
    "Cicilan": (
        "Cicilan Mobil",
        "Cicilan Bank",
        "Cicilan Kartu Kredit",
    ),
    "Rutinitas": (
        "Sewa/KPR",
        "Listrik",
        "Air",
        "Internet",
        "Zakat",
        "Pendidikan",
        "Pulsa",
    ),
    "Tabungan & Investasi": (
        "Saham",
        "ReksaDana",
        "Crypto",
        "Cash",
        "Usaha",
    ),
    "Belanja": (
        "Belanja Bulanan",
        "Belanja Mingguan",
        "Transport",
        "Bensin",
        "Makan",
        "Hiburan",
        "Kebutuhan Anak",
    ),
}


def _category_name_exists(
    db: Session, *, user_id: uuid.UUID, kind: CategoryKind, name: str
) -> bool:
    """Return True iff the user already has a non-archived category with this name."""
    stmt = select(Category.id).where(
        Category.user_id == user_id,
        Category.kind == kind,
        Category.name == name,
        Category.archived.is_(False),
    )
    return db.execute(stmt).first() is not None


def _seed_default_categories(db: Session, *, user_id: uuid.UUID) -> int:
    """Create the default category tree for a brand-new user. Idempotent.

    Returns the number of categories actually inserted (existing ones are
    skipped). Income categories are root-level; expense categories sit under
    one of the four parent groups from PRD §14.
    """
    inserted = 0

    # Income — flat, no parent.
    for name in _DEFAULT_INCOME_CATEGORIES:
        if _category_name_exists(db, user_id=user_id, kind=CategoryKind.INCOME, name=name):
            continue
        db.add(Category(user_id=user_id, name=name, kind=CategoryKind.INCOME))
        inserted += 1

    db.flush()

    # Expense — group leaves under named parents. Build parent map keyed by
    # (kind, name) → id so we don't query for each leaf.
    parent_ids: dict[str, uuid.UUID] = {}
    for parent_name in _EXPENSE_PARENTS:
        existing_parent_id = db.execute(
            select(Category.id).where(
                Category.user_id == user_id,
                Category.kind == CategoryKind.EXPENSE,
                Category.name == parent_name,
                Category.parent_id.is_(None),
            )
        ).scalar_one_or_none()
        if existing_parent_id is not None:
            parent_ids[parent_name] = existing_parent_id
            continue
        parent = Category(user_id=user_id, name=parent_name, kind=CategoryKind.EXPENSE)
        db.add(parent)
        db.flush()
        parent_ids[parent_name] = parent.id
        inserted += 1

    for parent_name, leaf_names in _DEFAULT_EXPENSE_CATEGORIES.items():
        parent_id = parent_ids[parent_name]
        for leaf_name in leaf_names:
            if _category_name_exists(
                db, user_id=user_id, kind=CategoryKind.EXPENSE, name=leaf_name
            ):
                continue
            db.add(
                Category(
                    user_id=user_id,
                    name=leaf_name,
                    kind=CategoryKind.EXPENSE,
                    parent_id=parent_id,
                )
            )
            inserted += 1

    return inserted


def _seed_default_preferences(db: Session, *, user_id: uuid.UUID) -> UserPreference:
    """Create the user's default preference row if it doesn't exist yet.

    The ``user_id`` column is unique, so re-running the seed for the same user
    is a no-op. The caller commits the session.
    """
    existing = db.execute(
        select(UserPreference).where(UserPreference.user_id == user_id)
    ).scalar_one_or_none()
    if existing is not None:
        return existing

    pref = UserPreference(
        user_id=user_id,
        locale=DEFAULT_LOCALE,
        currency=DEFAULT_CURRENCY,
        emergency_fund_multiplier=DEFAULT_EMERGENCY_FUND_MULTIPLIER,
        dependents_count=DEFAULT_DEPENDENTS_COUNT,
        theme=DEFAULT_THEME,
    )
    db.add(pref)
    db.flush()
    return pref


def seed_defaults_for_user(db: Session, user: User) -> None:
    """Seed default categories + preferences for a newly registered user.

    Idempotent: calling this twice for the same user does not duplicate rows
    (categories are matched by ``(user_id, kind, name)``, preferences by the
    unique ``user_id`` constraint).

    The caller owns the transaction — we ``flush`` but do not ``commit``.
    """
    _seed_default_categories(db, user_id=user.id)
    _seed_default_preferences(db, user_id=user.id)
