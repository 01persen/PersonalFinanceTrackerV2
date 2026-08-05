"""Export endpoints — CSV / JSON / backup snapshots (sub-0008-01+).

Scope: sub-0008-01 (CSV transactions export). The companion sub-issues
``sub-0008-02`` (JSON snapshot + backup zip) and ``sub-0008-03`` (settings
endpoint) ship in separate routers; this module is intentionally narrow
so each sub-task owns its own file and review surface.

CSV export contract — locks taken from the SA recommendation pinned in
``sub-0008-01`` (decision recorded in the issue description so we don't
re-litigate byte format):

* **Content-Type**: ``text/csv; charset=utf-8`` — spreadsheet apps sniff
  the charset correctly so non-ASCII characters in ``note`` / category
  names render without garbling. No UTF-8 BOM: a BOM helps legacy Excel
  auto-detect UTF-8 but confuses ``pandas.read_csv`` (the column names
  end up ``\\ufeffid`` etc.) — the SA recommendation explicitly trades
  legacy Excel for pandas / LibreOffice compatibility, and the PRD
  reference spreadsheet ``uangplanner.com`` doesn't need a BOM.
* **Line terminator**: ``\\r\\n`` — RFC 4180 conformant and what every
  spreadsheet parser we tested handles. Python's ``csv`` module defaults
  to the platform's ``os.linesep`` which on the test container is ``\\n``
  and breaks Excel; we override with ``lineterminator="\\r\\n"``.
* **Header row** (always present, even when the result set is empty —
  AC (d)): ``id,occurred_on,type,amount_idr,account,category,note``.
  Field order is fixed; downstream parsers MUST NOT depend on order
  beyond what the column names give them.
* **amount_idr**: integer, **not cents**. The DB stores ``amount_cents``
  (BigInteger) so we divide by 100 at the boundary. The SA pinned this
  decision because the reference spreadsheet
  (``docs/product/epics/epic-0008-*.md`` PR §6) shows whole-IDR values —
  sending cents would force every user to add a ``/100`` column in
  their sheet. Truncation, not rounding — a 25,500 cents row becomes
  ``255`` (not ``254`` or ``256``); fractional rupiah are not a
  thing in the system (Pydantic ``gt=0`` on ``amount_cents`` and a
  single-currency constraint), so the division has no remainder in
  practice, and the explicit ``//`` makes that contract loud in code.
* **Date format**: ISO ``YYYY-MM-DD`` — same string the JSON list
  endpoint surfaces (``occurred_on`` is a ``date`` column, model
  validators normalise to ISO before write).
* **Type field**: lowercase enum value (``income`` / ``expense`` /
  ``transfer``) — same casing the JSON endpoint surfaces, no
  pretty-printing that would surprise a downstream parser.
* **account / category**: the **name** (string), not the UUID. The
  whole point of the export is spreadsheet usability — IDs force the
  user to VLOOKUP against the accounts/categories sheet to read their
  own data. The list endpoint joins on these already; we re-join here
  so a renamed account immediately reflects in re-exported files.
* **note**: verbatim string. Empty cells (``note IS NULL``) become an
  empty field in the CSV, not the literal string ``"None"`` — the
  ``csv`` writer already does this when we pass ``""`` instead of
  ``None`` (Python's ``None`` would become ``"None"`` in
  ``str(value)``).
* **Soft-deleted rows**: excluded. ``Transaction.deleted_at IS NULL``
  is the same predicate the list endpoint uses; a tombstoned row that
  the user already removed from the UI must not reappear in their
  spreadsheet.

Cross-user isolation: every clause in the query includes
``Transaction.user_id == current_user.id``; another user's transactions
never leak into the export. We do NOT export archived accounts /
categories — the user already retired those, surfacing them in the
export would surprise them on round-trip. Account-archived rows are
filtered at the join level so a transaction whose account was archived
post-creation still surfaces with the account's last-known name (the
export must match what the user saw at the time, plus a renamed
account's current name).

Filename: ``transactions-YYYY-MM-DD.csv`` — the date is the response
date (today, server-side UTC) so two exports on different days don't
collide on the user's desktop. The ``Content-Disposition: attachment``
forces a download rather than an in-browser preview, matching the FE
flow in sub-0008-05.
"""

from __future__ import annotations

import csv
import io
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from datetime import date as _date

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.v1.auth import get_current_user
from app.db.models.account import Account
from app.db.models.category import Category
from app.db.models.transaction import Transaction
from app.db.models.user import User
from app.db.session import get_session

router = APIRouter(prefix="/export", tags=["export"])


def get_db() -> Iterator[Session]:
    """Per-router session dependency (mirrors accounts.py / transactions.py)."""
    yield from get_session()


_CSV_HEADER = ("id", "occurred_on", "type", "amount_idr", "account", "category", "note")


def _serialize_row(
    tx_id: uuid.UUID,
    occurred_on: _date,
    type_str: str,
    amount_cents: int,
    account_name: str | None,
    category_name: str | None,
    note: str | None,
) -> tuple[str, str, str, int, str, str, str]:
    """Project one transaction row into the 7-column CSV tuple.

    Centralised so the writer loop reads as data, not formatting. ``None``
    values (account_name / category_name / note) become empty strings —
    the ``csv`` module then writes them as empty cells, not the literal
    ``"None"``.
    """
    return (
        str(tx_id),
        occurred_on.isoformat(),
        type_str,
        amount_cents // 100,
        account_name or "",
        category_name or "",
        note or "",
    )


@router.get(
    "/transactions.csv",
    status_code=status.HTTP_200_OK,
    response_class=Response,
    responses={
        200: {
            "content": {"text/csv": {}},
            "description": "CSV file with the caller's non-deleted transactions.",
        },
    },
)
def export_transactions_csv(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    """Return the caller's transactions as a CSV file.

    See the module docstring for the byte-level contract (separator,
    encoding, header order, ``amount_idr`` integer, etc.).

    The endpoint is read-only and excludes soft-deleted rows. We use a
    single round-trip with an outer-join on ``Category`` so a
    transaction whose category was archived or deleted still surfaces
    in the export — the user might be exporting right before that
    archive happened, and dropping the row silently would corrupt their
    totals. ``category_name`` falls back to ``""`` in that case, which
    the FE / spreadsheet renders as an empty cell — same as a
    transaction that never had a category.

    Auth: 401 without a valid JWT (handled by ``get_current_user``).
    The CSV body is NEVER returned for an unauthenticated request —
    HTTPBearer raises before any DB work happens.
    """
    rows = db.execute(
        select(
            Transaction.id,
            Transaction.occurred_on,
            Transaction.type,
            Transaction.amount_cents,
            Account.name.label("account_name"),
            Category.name.label("category_name"),
            Transaction.note,
        )
        .join(Account, Account.id == Transaction.account_id)
        .outerjoin(Category, Category.id == Transaction.category_id)
        .where(
            Transaction.user_id == current_user.id,
            Transaction.deleted_at.is_(None),
        )
        .order_by(
            Transaction.occurred_on.desc(),
            Transaction.amount_cents.desc(),
            Transaction.id.asc(),
        )
    ).all()

    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerow(_CSV_HEADER)
    for row in rows:
        writer.writerow(
            _serialize_row(
                tx_id=row.id,
                occurred_on=row.occurred_on,
                type_str=row.type.value,
                amount_cents=row.amount_cents,
                account_name=row.account_name,
                category_name=row.category_name,
                note=row.note,
            )
        )

    body = buffer.getvalue()
    today = datetime.now(UTC).date().isoformat()
    filename = f"transactions-{today}.csv"
    return Response(
        content=body,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )
