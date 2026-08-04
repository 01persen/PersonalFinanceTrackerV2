"""Stage E (QA) integration + e2e for sub-0006-07 — re-verify the full Epic AC
for debt tracker on the merged release branch.

Coverage map (each AC in the Epic Detail Doc gets a test):

  AC-1 — User bisa menambah utang dengan principal, bunga, tenor; monthly
         payment terhitung (flat) → ``test_full_scale_sample_case_*``
         + ``test_create_supports_every_kind_with_correct_monthly_payment``.
  AC-2 — Setiap cicilan mengurangi remaining_principal dan menambah
         total_interest → ``test_lifecycle_create_pay_payoff_del_back_to_active``
         + ``test_summary_aggregates_payments_from_real_write_endpoint``.
  AC-3 — Status otomatis berubah ke paid_off saat lunas
         → ``test_status_flips_to_paid_off_exactly_at_zero``.
  AC-4 — Sample case 12jt @10% flat / 12 bulan → cicilan ~1.1jt,
         total bunga ~1.2jt → ``test_full_scale_sample_case_*``.

Smoke + regression extras:

  - Cross-user isolation (404, no leak).
  - Source account nullable first-class.
  - PATCH merge / split-reconcile / amount-only reject.
  - DELETE on paid-off → flips back to active.
  - Tenor null → monthly_payment_cents null; summary.next_payment_due_date
    and months_remaining null.
  - Overpayment guard, zero/negative amount guard, server-controlled field
    guard (extra=forbid).
  - Auth required on every endpoint.
  - Lifecycle through GET summary + GET list + PATCH/DELETE for both debt
    and payment resources.
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

# --- helpers -----------------------------------------------------------------


def _register(client: TestClient, email: str) -> dict[str, str]:
    r = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "secret-12345"},
    )
    assert r.status_code == 201, r.text
    return {"access_token": r.json()["access_token"]}


def _headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# Money math (Indonesian rupiah):
#   1 IDR = 100 cents (sen). The API stores integer cents — never floats.
#   1jt   = 1,000,000 IDR      = 100,000,000 cents
#   1.1jt = 1,100,000 IDR      = 110,000,000 cents  ← sample monthly
#   1.2jt = 1,200,000 IDR      = 120,000,000 cents  ← sample total bunga
#   12jt  = 12,000,000 IDR     = 1,200,000,000 cents ← sample principal
SAMPLE_PRINCIPAL_CENTS = 1_200_000_000  # 12jt IDR
SAMPLE_MONTHLY_CENTS = 110_000_000  # 1.1jt IDR
SAMPLE_INTEREST_PER_CICILAN_CENTS = 10_000_000  # 0.1jt IDR
SAMPLE_PRINCIPAL_PER_CICILAN_CENTS = 100_000_000  # 1jt IDR
SAMPLE_TOTAL_INTEREST_CENTS = 120_000_000  # 1.2jt IDR


def _create_full_scale_loan(
    client: TestClient,
    h: dict[str, str],
    *,
    name: str = "KPR QA",
    kind: str = "KPR",
    principal_cents: int = SAMPLE_PRINCIPAL_CENTS,
    bunga_pct: str = "10",
    tenor_months: int | None = 12,
    start_date: str = "2026-08-01",
) -> dict[str, object]:
    """Helper that creates a debt using the exact numbers from the
    Epic Detail Doc headline sample case.

    12jt IDR principal @10% flat / 12 bulan → cicilan 1.1jt, total bunga 1.2jt.
    """
    r = client.post(
        "/api/v1/debts",
        headers=h,
        json={
            "name": name,
            "kind": kind,
            "principal_cents": principal_cents,
            "bunga_pct": bunga_pct,
            "tenor_months": tenor_months,
            "start_date": start_date,
            "note": "Stage 5 QA sample",
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


# --- AC-4 — full-scale sample case (12jt IDR @10% / 12 bulan) ----------------


def test_full_scale_sample_case_create_response(
    client: TestClient,
    fresh_db: Session,
) -> None:
    """AC-4 sample case: 12jt @10% / 12 bulan → monthly_payment_cents == 1.1jt,
    total bunga (via summary) == 1.2jt, on a fresh debt.

    Uses the spec's headline numbers (12,000,000 IDR = 1_200_000_000 cents).
    """
    auth = _register(client, "qa-ac4-create@example.com")
    h = _headers(auth["access_token"])

    body = _create_full_scale_loan(client, h)

    assert body["monthly_payment_cents"] == SAMPLE_MONTHLY_CENTS, (
        f"sample case monthly payment must be 1.1jt IDR (110_000_000 cents), "
        f"got {body['monthly_payment_cents']}"
    )
    assert body["status"] == "active"

    # Summary: total interest booked so far is 0 (no payments yet); the
    # *scheduled* total interest over the full tenor is 1.2jt — surfaced
    # implicitly by the 12 x 1.1jt - 12jt == 1.2jt reconciliation the
    # payment-ledger test below does.
    summary = client.get(f"/api/v1/debts/{body['id']}/summary", headers=h).json()
    assert summary["remaining_principal_cents"] == SAMPLE_PRINCIPAL_CENTS
    assert summary["total_interest_paid_cents"] == 0
    assert summary["next_payment_due_date"] == "2026-08-01"
    assert summary["months_remaining"] == 12


def test_full_scale_sample_case_reconciliation_after_payments(
    client: TestClient,
    fresh_db: Session,
) -> None:
    """AC-4 reconciliation: 12 cicilan x 1.1jt = 13.2jt, principal 12jt +
    interest 1.2jt → matches the spec exactly.

    This walks the *real* POST /payments write path so the integration
    test exercises everything that the calculator + summary AC depend
    on. No direct DB seeds — the test would be useless for regression
    if it bypassed the route.
    """
    auth = _register(client, "qa-ac4-recon@example.com")
    h = _headers(auth["access_token"])
    debt = _create_full_scale_loan(client, h)
    debt_id = debt["id"]

    # 12 cicilan. Flat schedule: 110_000_000 cents total per installment,
    # of which 10_000_000 is interest (1.2jt total / 12 = 0.1jt per cycle)
    # and 100_000_000 is principal (12jt / 12 = 1jt per cycle).
    for month_index in range(12):
        year = 2026 + (8 + month_index - 1) // 12
        month = (8 + month_index - 1) % 12 + 1
        rp = client.post(
            f"/api/v1/debts/{debt_id}/payments",
            headers=h,
            json={
                "occurred_on": f"{year}-{month:02d}-01",
                "amount_cents": SAMPLE_MONTHLY_CENTS,
                "principal_portion_cents": SAMPLE_PRINCIPAL_PER_CICILAN_CENTS,
                "interest_portion_cents": SAMPLE_INTEREST_PER_CICILAN_CENTS,
                "note": f"cicilan {month_index + 1}",
            },
        )
        assert rp.status_code == 201, rp.text

    # After 12 cicilan the summary should report a fully-paid debt.
    final = client.get(f"/api/v1/debts/{debt_id}/summary", headers=h).json()
    assert final["remaining_principal_cents"] == 0
    assert final["total_interest_paid_cents"] == SAMPLE_TOTAL_INTEREST_CENTS, (
        f"sample case total interest must be 1.2jt IDR (120_000_000 cents), "
        f"got {final['total_interest_paid_cents']}"
    )
    assert final["next_payment_due_date"] is None
    assert final["months_remaining"] == 0

    # And the debt itself flips to paid_off.
    debt_now = client.get(f"/api/v1/debts/{debt_id}", headers=h).json()
    assert debt_now["status"] == "paid_off"


# --- AC-1 — every debt kind is supported --------------------------------------


@pytest.mark.parametrize(
    "kind",
    ["loan", "credit_card", "paylater", "KTA", "KKB", "KPR", "other"],
)
def test_create_supports_every_kind_with_correct_monthly_payment(
    client: TestClient,
    fresh_db: Session,
    kind: str,
) -> None:
    """AC-1: every kind accepted by the spec round-trips with the flat
    calculator producing the expected monthly payment.

    Uses the same proportional scale (12_000_000 cents principal) the
    other debt tests use so the numbers are identical to sub-0006-01's
    table — full-scale numbers are covered by the sample-case test above.
    """
    auth = _register(client, f"qa-kind-{kind.lower().replace('_', '-')}@example.com")
    h = _headers(auth["access_token"])

    r = client.post(
        "/api/v1/debts",
        headers=h,
        json={
            "name": f"Debt {kind}",
            "kind": kind,
            "principal_cents": 12_000_000,
            "bunga_pct": "10",
            "tenor_months": 12,
            "start_date": "2026-08-01",
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["kind"] == kind
    assert body["monthly_payment_cents"] == 1_100_000, (
        f"flat monthly for 12jt / 10% / 12 months must be 1.1jt, got {body['monthly_payment_cents']}"
    )


# --- AC-2 + AC-3 — payment lifecycle ------------------------------------------


def test_status_flips_to_paid_off_exactly_at_zero(
    client: TestClient,
    fresh_db: Session,
) -> None:
    """AC-3: paying the last principal portion flips the debt to paid_off
    atomically. The summary must report remaining == 0 immediately.
    """
    auth = _register(client, "qa-ac3-flips@example.com")
    h = _headers(auth["access_token"])
    # 10jt IDR principal = 1_000_000_000 cents
    debt = _create_full_scale_loan(client, h, principal_cents=1_000_000_000)
    debt_id = debt["id"]

    # First cicilan: 9jt principal + 1jt interest → still 1jt remaining
    # 9jt principal = 900_000_000 cents, 1jt interest = 100_000_000 cents
    rp1 = client.post(
        f"/api/v1/debts/{debt_id}/payments",
        headers=h,
        json={
            "occurred_on": "2026-09-01",
            "amount_cents": 1_000_000_000,
            "principal_portion_cents": 900_000_000,
            "interest_portion_cents": 100_000_000,
        },
    )
    assert rp1.status_code == 201, rp1.text
    assert client.get(f"/api/v1/debts/{debt_id}", headers=h).json()["status"] == "active"

    # Second cicilan: exactly 1jt principal + 0.1jt interest → remaining hits 0
    # 1jt principal = 100_000_000 cents, 0.1jt interest = 10_000_000 cents
    rp2 = client.post(
        f"/api/v1/debts/{debt_id}/payments",
        headers=h,
        json={
            "occurred_on": "2026-10-01",
            "amount_cents": 110_000_000,
            "principal_portion_cents": 100_000_000,
            "interest_portion_cents": 10_000_000,
        },
    )
    assert rp2.status_code == 201, rp2.text

    # Status must be paid_off now
    debt_after = client.get(f"/api/v1/debts/{debt_id}", headers=h).json()
    assert debt_after["status"] == "paid_off", (
        "debt must flip to paid_off when remaining_principal hits 0"
    )

    summary = client.get(f"/api/v1/debts/{debt_id}/summary", headers=h).json()
    assert summary["remaining_principal_cents"] == 0
    assert summary["months_remaining"] == 0
    assert summary["next_payment_due_date"] is None


def test_lifecycle_create_pay_payoff_delete_back_to_active(
    client: TestClient,
    fresh_db: Session,
) -> None:
    """AC-2 + AC-3: full lifecycle via the write endpoints, no direct DB
    seeds. Covers the headline regression the sub-0006-02 carry-over
    defect fix addressed (delete of last payment must flip back to
    active).

    Use a 12jt principal divided evenly into 12 cicilan of 1jt principal
    each — this guarantees the 12th cicilan brings remaining to exactly
    0 and the auto-paid-off transition fires.
    """
    auth = _register(client, "qa-lifecycle@example.com")
    h = _headers(auth["access_token"])
    debt = _create_full_scale_loan(client, h, principal_cents=SAMPLE_PRINCIPAL_CENTS)
    debt_id = debt["id"]

    # 12 cicilan of 1jt principal + 0.1jt interest each.
    payment_ids: list[str] = []
    for i in range(12):
        rp = client.post(
            f"/api/v1/debts/{debt_id}/payments",
            headers=h,
            json={
                "occurred_on": f"2026-{((8 + i - 1) % 12) + 1:02d}-01",
                "amount_cents": SAMPLE_MONTHLY_CENTS,
                "principal_portion_cents": SAMPLE_PRINCIPAL_PER_CICILAN_CENTS,
                "interest_portion_cents": SAMPLE_INTEREST_PER_CICILAN_CENTS,
            },
        )
        assert rp.status_code == 201, rp.text
        payment_ids.append(rp.json()["id"])

    # By now the debt is paid_off (12 cicilan x 1jt = 12jt = original principal).
    assert client.get(f"/api/v1/debts/{debt_id}", headers=h).json()["status"] == "paid_off"

    # Delete the most recent payment → status flips back to active.
    rd = client.delete(f"/api/v1/debts/{debt_id}/payments/{payment_ids[-1]}", headers=h)
    assert rd.status_code == 204, rd.text
    after_del = client.get(f"/api/v1/debts/{debt_id}", headers=h).json()
    assert after_del["status"] == "active", (
        "deleting the most recent payment must flip paid_off back to active"
    )


def test_summary_aggregates_payments_from_real_write_endpoint(
    client: TestClient,
    fresh_db: Session,
) -> None:
    """AC-2 summary check using only the public POST /payments endpoint.

    3 cicilan against a 12jt debt @10% / 12bln leaves 9jt remaining and
    300rb interest booked (proportional to the sample case the spec uses
    for AC-4).

    Scale: 12jt = 1_200_000_000 cents, 1jt principal per cicilan
    = 100_000_000 cents, 0.1jt interest per cicilan = 10_000_000 cents.
    3 cicilan x 1jt principal = 3jt paid → 9jt remaining.
    3 cicilan x 0.1jt interest = 0.3jt interest → 30_000_000 cents.
    """
    auth = _register(client, "qa-summary-aggregate@example.com")
    h = _headers(auth["access_token"])
    debt = _create_full_scale_loan(client, h, principal_cents=SAMPLE_PRINCIPAL_CENTS)
    debt_id = debt["id"]

    for i in range(3):
        rp = client.post(
            f"/api/v1/debts/{debt_id}/payments",
            headers=h,
            json={
                "occurred_on": f"2026-{((8 + i - 1) % 12) + 1:02d}-01",
                "amount_cents": SAMPLE_MONTHLY_CENTS,
                "principal_portion_cents": SAMPLE_PRINCIPAL_PER_CICILAN_CENTS,
                "interest_portion_cents": SAMPLE_INTEREST_PER_CICILAN_CENTS,
            },
        )
        assert rp.status_code == 201, rp.text

    summary = client.get(f"/api/v1/debts/{debt_id}/summary", headers=h).json()
    assert (
        summary["remaining_principal_cents"]
        == SAMPLE_PRINCIPAL_CENTS - 3 * SAMPLE_PRINCIPAL_PER_CICILAN_CENTS
    )
    assert summary["total_interest_paid_cents"] == 3 * SAMPLE_INTEREST_PER_CICILAN_CENTS
    assert summary["months_remaining"] == 9


# --- Edge cases --------------------------------------------------------------


def test_tenor_null_debt_round_trip(
    client: TestClient,
    fresh_db: Session,
) -> None:
    """Tenor=null: monthly_payment_cents is null; summary surfaces null
    next_due and null months_remaining — matches sub-0006-01 spec."""
    auth = _register(client, "qa-null-tenor@example.com")
    h = _headers(auth["access_token"])

    body = _create_full_scale_loan(client, h, tenor_months=None, principal_cents=2_000_000_000)
    assert body["tenor_months"] is None
    assert body["monthly_payment_cents"] is None

    summary = client.get(f"/api/v1/debts/{body['id']}/summary", headers=h).json()
    assert summary["remaining_principal_cents"] == 2_000_000_000
    assert summary["next_payment_due_date"] is None
    assert summary["months_remaining"] is None


def test_overpayment_rejected_with_422(
    client: TestClient,
    fresh_db: Session,
) -> None:
    """A cicilan whose principal portion would exceed the remaining
    principal is rejected (no negative balance ever)."""
    auth = _register(client, "qa-overpay@example.com")
    h = _headers(auth["access_token"])
    debt = _create_full_scale_loan(client, h, principal_cents=1_000_000)
    debt_id = debt["id"]

    rp = client.post(
        f"/api/v1/debts/{debt_id}/payments",
        headers=h,
        json={
            "occurred_on": "2026-08-15",
            "amount_cents": 5_000_000,
            "principal_portion_cents": 5_000_000,
            "interest_portion_cents": 0,
        },
    )
    assert rp.status_code == 422, f"overpayment must be 422, got {rp.text}"
    assert "overpayment" in rp.text.lower() or "principal" in rp.text.lower()


def test_zero_amount_rejected_with_422(
    client: TestClient,
    fresh_db: Session,
) -> None:
    auth = _register(client, "qa-zero@example.com")
    h = _headers(auth["access_token"])
    debt = _create_full_scale_loan(client, h, principal_cents=1_000_000)
    debt_id = debt["id"]

    rp = client.post(
        f"/api/v1/debts/{debt_id}/payments",
        headers=h,
        json={
            "occurred_on": "2026-08-15",
            "amount_cents": 0,
            "principal_portion_cents": 0,
            "interest_portion_cents": 0,
        },
    )
    assert rp.status_code == 422, rp.text


def test_negative_amount_rejected_with_422(
    client: TestClient,
    fresh_db: Session,
) -> None:
    auth = _register(client, "qa-neg@example.com")
    h = _headers(auth["access_token"])
    debt = _create_full_scale_loan(client, h, principal_cents=1_000_000)
    debt_id = debt["id"]

    rp = client.post(
        f"/api/v1/debts/{debt_id}/payments",
        headers=h,
        json={
            "occurred_on": "2026-08-15",
            "amount_cents": -100,
            "principal_portion_cents": -100,
            "interest_portion_cents": 0,
        },
    )
    assert rp.status_code == 422, rp.text


def test_split_mismatch_rejected_with_422(
    client: TestClient,
    fresh_db: Session,
) -> None:
    auth = _register(client, "qa-splitmismatch@example.com")
    h = _headers(auth["access_token"])
    debt = _create_full_scale_loan(client, h, principal_cents=1_000_000)
    debt_id = debt["id"]

    rp = client.post(
        f"/api/v1/debts/{debt_id}/payments",
        headers=h,
        json={
            "occurred_on": "2026-08-15",
            "amount_cents": 100_000,
            "principal_portion_cents": 60_000,
            "interest_portion_cents": 50_000,  # 60k + 50k = 110k ≠ 100k
        },
    )
    assert rp.status_code == 422, rp.text


def test_server_controlled_field_rejected_with_422(
    client: TestClient,
    fresh_db: Session,
) -> None:
    """The Pydantic schemas are extra='forbid' on the write paths;
    server-controlled fields (id, debt_id) must be rejected."""
    auth = _register(client, "qa-extra@example.com")
    h = _headers(auth["access_token"])
    debt = _create_full_scale_loan(client, h, principal_cents=1_000_000)
    debt_id = debt["id"]

    rp = client.post(
        f"/api/v1/debts/{debt_id}/payments",
        headers=h,
        json={
            "occurred_on": "2026-08-15",
            "amount_cents": 100,
            "principal_portion_cents": 100,
            "interest_portion_cents": 0,
            "id": str(uuid.uuid4()),
            "debt_id": str(uuid.uuid4()),
        },
    )
    assert rp.status_code == 422, rp.text


def test_payment_on_paid_off_debt_rejected_with_422(
    client: TestClient,
    fresh_db: Session,
) -> None:
    """Once paid_off, new cicilan must be rejected with 422 — only the
    delete path can re-open the debt."""
    auth = _register(client, "qa-paid-off-block@example.com")
    h = _headers(auth["access_token"])
    debt = _create_full_scale_loan(client, h, principal_cents=1_000_000)
    debt_id = debt["id"]

    # First (and only) cicilan that exactly pays it off.
    rp = client.post(
        f"/api/v1/debts/{debt_id}/payments",
        headers=h,
        json={
            "occurred_on": "2026-08-15",
            "amount_cents": 1_000_000,
            "principal_portion_cents": 1_000_000,
            "interest_portion_cents": 0,
        },
    )
    assert rp.status_code == 201, rp.text
    assert client.get(f"/api/v1/debts/{debt_id}", headers=h).json()["status"] == "paid_off"

    # Subsequent cicilan → 422
    rp2 = client.post(
        f"/api/v1/debts/{debt_id}/payments",
        headers=h,
        json={
            "occurred_on": "2026-09-15",
            "amount_cents": 1,
            "principal_portion_cents": 1,
            "interest_portion_cents": 0,
        },
    )
    assert rp2.status_code == 422, rp2.text
    assert "paid_off" in rp2.text.lower()


# --- Cross-user isolation -----------------------------------------------------


def test_cross_user_isolation_on_payments(
    client: TestClient,
    fresh_db: Session,
) -> None:
    """User B must not read or write User A's debt or payments."""
    a = _register(client, "qa-iso-a@example.com")
    b = _register(client, "qa-iso-b@example.com")
    ha = _headers(a["access_token"])
    hb = _headers(b["access_token"])

    debt = _create_full_scale_loan(client, ha, principal_cents=100_000)
    debt_id = debt["id"]

    # User A: list OK
    rl = client.get(f"/api/v1/debts/{debt_id}/payments", headers=ha)
    assert rl.status_code == 200

    # User B: list → 404 (no leak)
    assert client.get(f"/api/v1/debts/{debt_id}/payments", headers=hb).status_code == 404
    # User B: write → 404
    rwrite = client.post(
        f"/api/v1/debts/{debt_id}/payments",
        headers=hb,
        json={
            "occurred_on": "2026-08-15",
            "amount_cents": 100,
            "principal_portion_cents": 100,
            "interest_portion_cents": 0,
        },
    )
    assert rwrite.status_code == 404
    # User B: summary → 404
    assert client.get(f"/api/v1/debts/{debt_id}/summary", headers=hb).status_code == 404
    # User B: get the debt → 404
    assert client.get(f"/api/v1/debts/{debt_id}", headers=hb).status_code == 404


# --- Auth ---------------------------------------------------------------------


def test_every_endpoint_requires_auth(
    client: TestClient,
    fresh_db: Session,
) -> None:
    """All debt + payment routes require a bearer token."""
    some_id = str(uuid.uuid4())

    assert client.get("/api/v1/debts").status_code == 401
    assert client.post("/api/v1/debts", json={}).status_code == 401
    assert client.get(f"/api/v1/debts/{some_id}").status_code == 401
    assert client.patch(f"/api/v1/debts/{some_id}", json={}).status_code == 401
    assert client.delete(f"/api/v1/debts/{some_id}").status_code == 401
    assert client.get(f"/api/v1/debts/{some_id}/summary").status_code == 401
    assert client.get(f"/api/v1/debts/{some_id}/payments").status_code == 401
    assert (
        client.post(
            f"/api/v1/debts/{some_id}/payments",
            json={
                "occurred_on": "2026-08-15",
                "amount_cents": 100,
                "principal_portion_cents": 100,
                "interest_portion_cents": 0,
            },
        ).status_code
        == 401
    )
    assert client.delete(f"/api/v1/debts/{some_id}/payments/{some_id}").status_code == 401


# --- Source account nullable --------------------------------------------------


def test_source_account_nullable_first_class(
    client: TestClient,
    fresh_db: Session,
) -> None:
    """A cicilan with source_account_id=null (cash in hand) is a valid
    first-class case — sub-0006-02 AC explicitly."""
    auth = _register(client, "qa-source-nullable@example.com")
    h = _headers(auth["access_token"])
    debt = _create_full_scale_loan(client, h, principal_cents=1_000_000)
    debt_id = debt["id"]

    rp = client.post(
        f"/api/v1/debts/{debt_id}/payments",
        headers=h,
        json={
            "occurred_on": "2026-08-15",
            "amount_cents": 1_000_000,
            "principal_portion_cents": 1_000_000,
            "interest_portion_cents": 0,
            "source_account_id": None,
        },
    )
    assert rp.status_code == 201, rp.text
    assert rp.json()["source_account_id"] is None


# --- Patch / merge reconcile -------------------------------------------------


def test_patch_amount_only_rejected_with_422(
    client: TestClient,
    fresh_db: Session,
) -> None:
    auth = _register(client, "qa-patch-amount@example.com")
    h = _headers(auth["access_token"])
    debt = _create_full_scale_loan(client, h, principal_cents=1_000_000)
    debt_id = debt["id"]

    rp = client.post(
        f"/api/v1/debts/{debt_id}/payments",
        headers=h,
        json={
            "occurred_on": "2026-08-15",
            "amount_cents": 100_000,
            "principal_portion_cents": 80_000,
            "interest_portion_cents": 20_000,
        },
    )
    payment_id = rp.json()["id"]

    # PATCH amount only → 422
    rpatch = client.patch(
        f"/api/v1/debts/{debt_id}/payments/{payment_id}",
        headers=h,
        json={"amount_cents": 999_999},
    )
    assert rpatch.status_code == 422, rpatch.text
    assert "amount_cents" in rpatch.text


def test_patch_split_mismatch_rejected_with_422(
    client: TestClient,
    fresh_db: Session,
) -> None:
    auth = _register(client, "qa-patch-split@example.com")
    h = _headers(auth["access_token"])
    debt = _create_full_scale_loan(client, h, principal_cents=1_000_000)
    debt_id = debt["id"]

    rp = client.post(
        f"/api/v1/debts/{debt_id}/payments",
        headers=h,
        json={
            "occurred_on": "2026-08-15",
            "amount_cents": 100_000,
            "principal_portion_cents": 80_000,
            "interest_portion_cents": 20_000,
        },
    )
    payment_id = rp.json()["id"]

    # PATCH with split that doesn't reconcile against the *amount*
    # (50k + 30k = 80k, not the 100k amount) → 422
    rpatch = client.patch(
        f"/api/v1/debts/{debt_id}/payments/{payment_id}",
        headers=h,
        json={
            "amount_cents": 100_000,
            "principal_portion_cents": 50_000,
            "interest_portion_cents": 30_000,
        },
    )
    assert rpatch.status_code == 422, rpatch.text


def test_patch_valid_update_then_status_flips(
    client: TestClient,
    fresh_db: Session,
) -> None:
    """A valid PATCH that lowers a debt's remaining principal below 0
    transitions paid_off → active. Defensive check that the helper
    `refresh_debt_status` is wired through the PATCH path too."""
    auth = _register(client, "qa-patch-valid@example.com")
    h = _headers(auth["access_token"])
    debt = _create_full_scale_loan(client, h, principal_cents=100_000)
    debt_id = debt["id"]

    # Pay it off.
    rp = client.post(
        f"/api/v1/debts/{debt_id}/payments",
        headers=h,
        json={
            "occurred_on": "2026-08-15",
            "amount_cents": 100_000,
            "principal_portion_cents": 100_000,
            "interest_portion_cents": 0,
        },
    )
    payment_id = rp.json()["id"]
    assert client.get(f"/api/v1/debts/{debt_id}", headers=h).json()["status"] == "paid_off"

    # PATCH the principal portion down → remaining > 0 → active
    rpatch = client.patch(
        f"/api/v1/debts/{debt_id}/payments/{payment_id}",
        headers=h,
        json={
            "amount_cents": 50_000,
            "principal_portion_cents": 40_000,
            "interest_portion_cents": 10_000,
        },
    )
    assert rpatch.status_code == 200, rpatch.text
    assert client.get(f"/api/v1/debts/{debt_id}", headers=h).json()["status"] == "active"


# --- Listing + pagination -----------------------------------------------------


def test_payment_list_paginated_newest_first(
    client: TestClient,
    fresh_db: Session,
) -> None:
    """Payment list is paginated, sorted by occurred_on DESC then
    created_at DESC then id ASC (deterministic ordering — the sub-0004-00
    flake carry-over the TL noted)."""
    auth = _register(client, "qa-list-paged@example.com")
    h = _headers(auth["access_token"])
    # 10jt principal = 1_000_000_000 cents. 5 cicilan of 1jt principal each.
    debt = _create_full_scale_loan(client, h, principal_cents=1_000_000_000)
    debt_id = debt["id"]

    payment_ids: list[str] = []
    for i in range(5):
        rp = client.post(
            f"/api/v1/debts/{debt_id}/payments",
            headers=h,
            json={
                "occurred_on": f"2026-{((8 + i - 1) % 12) + 1:02d}-01",
                "amount_cents": SAMPLE_MONTHLY_CENTS,
                "principal_portion_cents": SAMPLE_PRINCIPAL_PER_CICILAN_CENTS,
                "interest_portion_cents": SAMPLE_INTEREST_PER_CICILAN_CENTS,
            },
        )
        payment_ids.append(rp.json()["id"])

    # Default page size
    rl = client.get(f"/api/v1/debts/{debt_id}/payments", headers=h)
    assert rl.status_code == 200
    body = rl.json()
    assert body["total"] == 5
    assert len(body["items"]) == 5
    # Newest first (Dec → Nov → Oct → Sep → Aug for our loop)
    assert body["items"][0]["occurred_on"] > body["items"][-1]["occurred_on"]

    # Paginate: limit=2 offset=2 → 2 rows
    rp = client.get(f"/api/v1/debts/{debt_id}/payments?limit=2&offset=2", headers=h)
    page = rp.json()
    assert page["total"] == 5
    assert len(page["items"]) == 2
    assert page["limit"] == 2
    assert page["offset"] == 2


# --- PATCH on debt + DELETE on debt ------------------------------------------


def test_patch_debt_recalculates_monthly_payment(
    client: TestClient,
    fresh_db: Session,
) -> None:
    """Editing principal/bunga/tenor triggers a fresh monthly_payment_cents
    calc (server-side, never editable through the API)."""
    auth = _register(client, "qa-patch-debt@example.com")
    h = _headers(auth["access_token"])
    debt = _create_full_scale_loan(client, h, principal_cents=12_000_000)
    debt_id = debt["id"]

    rpatch = client.patch(
        f"/api/v1/debts/{debt_id}",
        headers=h,
        json={"principal_cents": 24_000_000, "bunga_pct": 12, "tenor_months": 24},
    )
    assert rpatch.status_code == 200, rpatch.text
    assert rpatch.json()["monthly_payment_cents"] == 1_240_000, (
        f"24jt @12% / 24bln → monthly must be 1.24jt, got {rpatch.json()['monthly_payment_cents']}"
    )


def test_patch_debt_rejects_server_owned_monthly_payment(
    client: TestClient,
    fresh_db: Session,
) -> None:
    """Client can't smuggle in a `monthly_payment_cents` — the server
    recomputes it on every PATCH."""
    auth = _register(client, "qa-patch-owned@example.com")
    h = _headers(auth["access_token"])
    debt = _create_full_scale_loan(client, h)
    debt_id = debt["id"]

    rpatch = client.patch(
        f"/api/v1/debts/{debt_id}",
        headers=h,
        json={"monthly_payment_cents": 1},
    )
    assert rpatch.status_code == 422, rpatch.text


def test_delete_debt_cascade_removes_payments(
    client: TestClient,
    fresh_db: Session,
) -> None:
    """Deleting the parent debt removes the payment rows (cascade).
    Listing afterwards returns 404 because the parent is gone."""
    auth = _register(client, "qa-delete-cascade@example.com")
    h = _headers(auth["access_token"])
    debt = _create_full_scale_loan(client, h, principal_cents=1_000_000)
    debt_id = debt["id"]

    rp = client.post(
        f"/api/v1/debts/{debt_id}/payments",
        headers=h,
        json={
            "occurred_on": "2026-08-15",
            "amount_cents": 100_000,
            "principal_portion_cents": 100_000,
            "interest_portion_cents": 0,
        },
    )
    assert rp.status_code == 201

    rd = client.delete(f"/api/v1/debts/{debt_id}", headers=h)
    assert rd.status_code == 204

    # GET debt → 404
    assert client.get(f"/api/v1/debts/{debt_id}", headers=h).status_code == 404
    # GET summary → 404
    assert client.get(f"/api/v1/debts/{debt_id}/summary", headers=h).status_code == 404
    # GET payments → 404 (parent gone, list route 404s before querying)
    assert client.get(f"/api/v1/debts/{debt_id}/payments", headers=h).status_code == 404
