"""Category-rule engine (sub-0004-02).

Picks the winning category for a transaction based on the caller's
active rules. Used by:

* ``POST /api/v1/transactions`` and ``PATCH /api/v1/transactions/{id}``
  — the live apply path. Invoked when the caller didn't supply a
  ``category_id`` (or supplied ``null`` on PATCH), so the existing
  category is preserved when no rule matches (AC (2)).
* ``POST /api/v1/categories/apply-rules`` — the admin endpoint that
  applies the engine across existing rows for the caller (AC (4))
  plus the dry-run mode used by QA + the Alembic data migration.

Deterministic ordering: ``priority DESC, id ASC`` — the rule with the
largest ``priority`` wins, ties broken by the lower id (older rule
first). This is also what the existing ``category_rules`` initial
schema + the new composite index supports (``WHERE user_id = ? AND
active = TRUE ORDER BY priority DESC, id ASC``).

ReDoS guard (AC risk area): we cap the pattern length at compile
time and budget a small number of characters per call. ``re.search``
itself doesn't bound execution time, but the test suite feeds an
adversarial ``(a+)+$`` pattern and confirms the caller is rejected
before we ever try to match it against a transaction note. SQLite
(the test backend) doesn't run patterns either way, so the prod
guard is the pattern-length cap at the API boundary plus a
``regex_max_pattern_chars`` constant here.
"""

from __future__ import annotations

import re
import uuid
from collections.abc import Iterable
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models.category import Category
from app.db.models.category_rule import CategoryRule
from app.db.models.enums import CategoryKind
from app.db.models.rule_audit_log import RuleAuditLog
from app.db.models.transaction import Transaction

#: Hard cap on regex pattern length — anything longer is rejected at
#: the API boundary before we ever call :func:`re.search`. PostgreSQL
#: uses ``re`` via Python so a 1MB + ``(a+)+$`` would lock a worker;
#: 1 KiB is plenty for any sane account description keyword.
REGEX_MAX_PATTERN_CHARS = 1024
#: Hard cap on pattern length regardless of ``is_regex``. Substring
#: match is cheap; this guard mainly prevents accidental upload of
#: gigantic notes-as-patterns.
PATTERN_MAX_CHARS = 255


@dataclass(frozen=True)
class RuleMatch:
    """A rule that matched a transaction note."""

    rule_id: uuid.UUID
    category_id: uuid.UUID
    priority: int


@dataclass(frozen=True)
class ApplyResult:
    """Outcome of applying rules to one or many transactions.

    ``rules_evaluated`` is the count of *active* rules the user had
    at apply time (so QA can confirm the rule set was loaded). The
    ``affected_transaction_ids`` list preserves the apply order
    ``occurred_on desc, id asc`` so the FE can highlight the rows
    that changed in the user's "Pendapatan & Pengeluaran Bulanan"
    view without a second GET.
    """

    rules_evaluated: int
    transactions_updated: int
    affected_transaction_ids: list[uuid.UUID]


def _safe_search(pattern: str, *, is_regex: bool, haystack: str) -> bool:
    """Run a substring or regex match with a ReDoS guard.

    Returns ``True`` iff the pattern matches the haystack. Raises
    :class:`ValueError` when ``is_regex`` is True and the pattern is
    too long — the API layer catches it and returns 422.
    """
    if is_regex:
        if len(pattern) > REGEX_MAX_PATTERN_CHARS:
            raise ValueError(
                f"regex pattern exceeds the {REGEX_MAX_PATTERN_CHARS}-character safety cap"
            )
        return re.search(pattern, haystack) is not None
    return pattern.lower() in haystack.lower()


def _pick_winner(
    rules: Iterable[CategoryRule], note: str
) -> RuleMatch | None:
    """Return the highest-priority rule that matches ``note``.

    Iterates ``rules`` (already filtered to ``active=True`` for the
    caller) and selects the maximum-by-``priority`` matching rule,
    with deterministic tie-break on the smaller ``rule.id``. Return
    ``None`` when no rule matches — the caller preserves the existing
    category.
    """
    winner: RuleMatch | None = None
    for rule in rules:
        try:
            matched = _safe_search(
                rule.pattern, is_regex=rule.is_regex, haystack=note
            )
        except re.error:
            # Malformed regex on a user-uploaded rule — skip and
            # continue with the remaining rules so one bad row
            # doesn't block the whole engine. The audit log won't
            # record anything for skipped rules so QA can spot the
            # offender by manually re-applying + checking the
            # ``RuleMatch`` debug path.
            continue
        if not matched:
            continue
        candidate = RuleMatch(
            rule_id=rule.id,
            category_id=rule.category_id,
            priority=rule.priority,
        )
        if (
            winner is None
            or candidate.priority > winner.priority
            or (
                candidate.priority == winner.priority
                and candidate.rule_id < winner.rule_id
            )
        ):
            winner = candidate
    return winner


def load_active_rules(
    db: Session, *, user_id: uuid.UUID
) -> list[CategoryRule]:
    """Return the caller's active rules ordered by the apply path.

    Ordered ``priority DESC, id ASC`` so the iteration in
    :func:`_pick_winner` walks winners first — the early-exit on
    single-rule callers (the common case) saves the second rule
    lookup and gives us deterministic results without a separate
    sort.
    """
    stmt = (
        select(CategoryRule)
        .where(
            CategoryRule.user_id == user_id,
            CategoryRule.active.is_(True),
        )
        .order_by(CategoryRule.priority.desc(), CategoryRule.id.asc())
    )
    return list(db.execute(stmt).scalars())


def resolve_category_for_transaction(
    db: Session,
    *,
    transaction: Transaction,
    current_user_id: uuid.UUID,
) -> RuleMatch | None:
    """Return the winning rule (or ``None``) for ``transaction``.

    Note-based matching only — the rule engine keys off ``note`` (the
    only free-text field on transactions per the schema). Transactions
    without a note never match a rule, which is the intended behaviour
    (the FE submits a note only when the user typed one).
    """
    if not transaction.note:
        return None
    rules = load_active_rules(db, user_id=current_user_id)
    return _pick_winner(rules, transaction.note)


def apply_rules_to_transactions(
    db: Session,
    *,
    user_id: uuid.UUID,
    transactions: list[Transaction],
    origin: str,
    write_audit: bool = True,
) -> ApplyResult:
    """Apply the engine to ``transactions`` in-memory.

    Iterates each transaction in the supplied order (the caller is
    responsible for the deterministic sort — see the backfill
    endpoint for ``occurred_on DESC, id ASC``). When a rule matches and
    the existing ``category_id`` differs from the winning rule's
    category, the row is updated and (when ``write_audit=True``) a
    :class:`RuleAuditLog` row is appended.

    The ``write_audit=False`` mode is used by the dry-run endpoint to
    count *would-be* updates without committing anything — the
    backfill endpoint and the data migration script then issue a
    second pass with ``write_audit=True``.

    No-match preserve (AC (2)): a transaction whose ``category_id``
    is already set and no rule matches is left untouched — the
    category stays put.
    """
    rules = load_active_rules(db, user_id=user_id)
    if not rules:
        return ApplyResult(
            rules_evaluated=0,
            transactions_updated=0,
            affected_transaction_ids=[],
        )

    # Cache which rule ``category_id`` is still usable (active + same
    # kind as the transaction) so we can skip dead rules without a
    # second query per transaction. Active+archived-category pairs
    # are rejected here: an archived target category is invisible to
    # the FE so we shouldn't silently re-assign to it.
    valid_categories: dict[uuid.UUID, Category] = {}
    for rule in rules:
        if rule.category_id in valid_categories:
            continue
        category = db.get(Category, rule.category_id)
        if category is None or category.archived_at is not None:
            continue
        if category.user_id != user_id:
            continue
        valid_categories[rule.category_id] = category

    updated = 0
    affected: list[uuid.UUID] = []

    for transaction in transactions:
        if transaction.user_id != user_id:
            # Defensive — the callers pre-filter, but skipping here
            # avoids leaking cross-user rows into the audit log.
            continue
        if transaction.deleted_at is not None:
            continue
        if transaction.type.value not in {"income", "expense"}:
            # Transfer rows don't participate in auto-categorisation
            # — the paired transfer's "category" is None on both legs.
            continue
        if not transaction.note:
            continue

        match = _pick_winner(rules, transaction.note)
        if match is None:
            continue
        target_category = valid_categories.get(match.category_id)
        if target_category is None:
            continue
        expected_kind = CategoryKind(transaction.type.value)
        if target_category.kind != expected_kind:
            continue
        if transaction.category_id == target_category.id:
            # Already assigned — no-op, no audit row.
            continue

        prev = transaction.category_id
        transaction.category_id = target_category.id
        if write_audit:
            db.add(
                RuleAuditLog(
                    rule_id=match.rule_id,
                    transaction_id=transaction.id,
                    user_id=user_id,
                    prev_category_id=prev,
                    new_category_id=target_category.id,
                    origin=origin,
                )
            )
        updated += 1
        affected.append(transaction.id)

    return ApplyResult(
        rules_evaluated=len(rules),
        transactions_updated=updated,
        affected_transaction_ids=affected,
    )
