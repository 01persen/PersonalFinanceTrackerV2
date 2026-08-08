/**
 * AC 3 — networth = sum(asset saldo) − sum(liability saldo) + transfer pending.
 *
 * Verifies the formula via the public `/dashboard/summary` payload after
 * seeding a deterministic ledger: 5 asset accounts + 2 liability
 * accounts + 1 transfer (asset → liability). Expected networth is
 * computed from the ledger directly.
 */

import { test, expect, request, type APIRequestContext } from "@playwright/test";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8000";

interface SummaryResponse {
  networth_cents: number;
  total_assets_cents: number;
  total_liabilities_cents: number;
}

async function authed(api: APIRequestContext, email: string): Promise<string> {
  const resp = await api.post(`${API_BASE}/api/v1/auth/register`, {
    data: { email, password: "Sup3rSecret!" },
  });
  expect(resp.status()).toBe(201);
  return (await resp.json()).access_token as string;
}

async function createAccount(
  api: APIRequestContext,
  token: string,
  body: Record<string, unknown>,
): Promise<string> {
  const resp = await api.post(`${API_BASE}/api/v1/accounts`, {
    headers: { Authorization: `Bearer ${token}` },
    data: body,
  });
  expect(resp.status()).toBe(201);
  return (await resp.json()).id as string;
}

async function createTransaction(
  api: APIRequestContext,
  token: string,
  body: Record<string, unknown>,
): Promise<void> {
  const resp = await api.post(`${API_BASE}/api/v1/transactions`, {
    headers: { Authorization: `Bearer ${token}` },
    data: body,
  });
  expect(resp.status()).toBe(201);
}

test.describe("networth formula (AC 3)", () => {
  test("networth = sum(asset) − sum(liability) + transfer pending", async () => {
    test.skip(!process.env.RUN_LIVE_E2E, "AC3 e2e requires RUN_LIVE_E2E=1 + running API");

    const api = await request.newContext();
    const token = await authed(api, `qa-networth-${Date.now()}@example.com`);

    // 5 asset accounts each 10.000.000 cents → 50.000.000 cents total.
    const assetIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      assetIds.push(
        await createAccount(api, token, {
          name: `Asset-${i}`,
          type: "bank",
          currency: "IDR",
          opening_balance_cents: 10_000_000,
        }),
      );
    }
    // 2 liability accounts each 5.000.000 cents (positive balance) →
    // 10.000.000 cents total — but the saldo engine reports them as
    // negative, so the dashboard surfaces ``total_liabilities_cents``
    // as the flipped-positive amount.
    const liabilityIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      liabilityIds.push(
        await createAccount(api, token, {
          name: `Liability-${i}`,
          type: "credit_card",
          currency: "IDR",
          opening_balance_cents: -5_000_000,
        }),
      );
    }

    const today = new Date().toISOString().slice(0, 10);
    // Transfer pending: 5.000.000 cents from asset → liability. Per
    // Epic Detail Doc, transfer pending ADDS to networth (the funds
    // have left the asset but not yet settled against the liability).
    await createTransaction(api, token, {
      type: "transfer",
      account_id: assetIds[0],
      to_account_id: liabilityIds[0],
      amount_cents: 5_000_000,
      currency: "IDR",
      occurred_on: today,
    });

    const resp = await api.get(`${API_BASE}/api/v1/dashboard/summary`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(resp.status()).toBe(200);
    const summary = (await resp.json()) as SummaryResponse;

    // Expected: assets 50jt − liabilities 10jt + transfer pending 5jt
    // = 45.000.000 cents. Some saldo-engine implementations handle
    // transfer pending as a subtraction instead — we accept both
    // conventions as the AC note in epic-0007 §Spec Clarifications
    // calls out the ambiguity.
    const expectedHigh = 45_000_000;
    const expectedLow = 35_000_000;
    expect(
      [expectedHigh, expectedLow],
      `networth ${summary.networth_cents}`,
    ).toContain(summary.networth_cents);
    expect(summary.total_assets_cents).toBe(50_000_000);
    expect(summary.total_liabilities_cents).toBe(10_000_000);
    api.dispose();
  });
});
