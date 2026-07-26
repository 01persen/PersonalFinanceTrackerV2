"""Default-seed service tests — covers idempotency and the PRD §14 seed list.

Runs against a throwaway in-memory SQLite so the test is hermetic and doesn't
need the Alembic environment. The service uses ``flush`` only — the caller
owns the commit, so we wrap each call in a session and assert post-flush state.
"""

from __future__ import annotations

from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.db.models.category import Category
from app.db.models.enums import CategoryKind
from app.db.models.user import User
from app.db.models.user_preference import UserPreference
from app.services.seed import (
    DEFAULT_CURRENCY,
    DEFAULT_EMERGENCY_FUND_MULTIPLIER,
    DEFAULT_LOCALE,
    seed_defaults_for_user,
)


def _make_session() -> tuple[Session, sessionmaker[Session]]:
    engine = create_engine(
        "sqlite://",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )

    @event.listens_for(engine, "connect")
    def _fk_on(dbapi_conn, _):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    return factory(), factory


def _seed_user(session: Session) -> User:
    user = User(email="seed-test@example.com", password_hash="x")
    session.add(user)
    session.flush()
    return user


def test_seed_creates_default_categories() -> None:
    session, _ = _make_session()
    user = _seed_user(session)

    seed_defaults_for_user(session, user)
    session.commit()

    cats = (
        session.query(Category)
        .filter(Category.user_id == user.id)
        .order_by(Category.kind, Category.parent_id.is_(None), Category.name)
        .all()
    )

    # 7 income roots + 4 expense parents + (3+7+5+7=22) expense leaves.
    assert len(cats) == 7 + 4 + 22

    income = [c for c in cats if c.kind == CategoryKind.INCOME]
    assert all(c.parent_id is None for c in income)
    income_names = {c.name for c in income}
    assert income_names == {
        "Gaji",
        "Gaji Pasangan",
        "Bonus",
        "Hadiah",
        "Pendapatan Lain",
        "Hutang Diterima",
        "Piutang Diterima",
    }

    expense_parents = [c for c in cats if c.kind == CategoryKind.EXPENSE and c.parent_id is None]
    assert {p.name for p in expense_parents} == {
        "Cicilan",
        "Rutinitas",
        "Tabungan & Investasi",
        "Belanja",
    }

    expense_leaves = [c for c in cats if c.kind == CategoryKind.EXPENSE and c.parent_id is not None]
    parent_by_id = {p.id: p.name for p in expense_parents}
    grouped: dict[str, set[str]] = {p.name: set() for p in expense_parents}
    for leaf in expense_leaves:
        grouped[parent_by_id[leaf.parent_id]].add(leaf.name)

    assert grouped["Cicilan"] == {"Cicilan Mobil", "Cicilan Bank", "Cicilan Kartu Kredit"}
    assert grouped["Rutinitas"] == {
        "Sewa/KPR",
        "Listrik",
        "Air",
        "Internet",
        "Zakat",
        "Pendidikan",
        "Pulsa",
    }
    assert grouped["Tabungan & Investasi"] == {
        "Saham",
        "ReksaDana",
        "Crypto",
        "Cash",
        "Usaha",
    }
    assert grouped["Belanja"] == {
        "Belanja Bulanan",
        "Belanja Mingguan",
        "Transport",
        "Bensin",
        "Makan",
        "Hiburan",
        "Kebutuhan Anak",
    }


def test_seed_creates_default_preferences() -> None:
    session, _ = _make_session()
    user = _seed_user(session)

    seed_defaults_for_user(session, user)
    session.commit()

    pref = session.query(UserPreference).filter(UserPreference.user_id == user.id).one()
    assert pref.locale == DEFAULT_LOCALE
    assert pref.currency == DEFAULT_CURRENCY
    assert pref.emergency_fund_multiplier == DEFAULT_EMERGENCY_FUND_MULTIPLIER
    assert pref.dependents_count == 1
    assert pref.theme == "system"


def test_seed_is_idempotent_for_categories() -> None:
    session, _ = _make_session()
    user = _seed_user(session)

    seed_defaults_for_user(session, user)
    session.commit()
    first_count = session.query(Category).filter(Category.user_id == user.id).count()

    seed_defaults_for_user(session, user)
    session.commit()
    second_count = session.query(Category).filter(Category.user_id == user.id).count()

    assert first_count == second_count == 33  # 7 income + 4 parents + 22 leaves


def test_seed_is_idempotent_for_preferences() -> None:
    session, _ = _make_session()
    user = _seed_user(session)

    seed_defaults_for_user(session, user)
    session.commit()
    pref_id = session.query(UserPreference).filter(UserPreference.user_id == user.id).one().id

    seed_defaults_for_user(session, user)
    session.commit()
    pref_ids = [
        p.id for p in session.query(UserPreference).filter(UserPreference.user_id == user.id).all()
    ]

    assert pref_ids == [pref_id]


def test_seed_does_not_overwrite_user_added_category() -> None:
    session, _ = _make_session()
    user = _seed_user(session)
    seed_defaults_for_user(session, user)
    session.commit()

    # User adds a custom income category after the seed.
    custom = Category(user_id=user.id, name="Freelance", kind=CategoryKind.INCOME)
    session.add(custom)
    session.commit()

    seed_defaults_for_user(session, user)
    session.commit()

    names = {
        c.name
        for c in session.query(Category)
        .filter(Category.user_id == user.id, Category.kind == CategoryKind.INCOME)
        .all()
    }
    assert "Freelance" in names  # user's custom row untouched
    assert len(names) == 8  # 7 defaults + 1 custom


def test_seed_skips_already_existing_default_category() -> None:
    """Simulate a partial DB state — user already has one default row."""
    session, _ = _make_session()
    user = _seed_user(session)

    # Pre-seed one default category manually to mimic a partial state.
    session.add(Category(user_id=user.id, name="Gaji", kind=CategoryKind.INCOME))
    session.commit()

    seed_defaults_for_user(session, user)
    session.commit()

    gaji_rows = (
        session.query(Category).filter(Category.user_id == user.id, Category.name == "Gaji").all()
    )
    assert len(gaji_rows) == 1  # no duplicate created
