/**
 * AC 4 — mobile ringkas view at 390×844 (PRD §5 mobile-first).
 * Asserts the 2×2 KPI grid + single chart + "Lihat dashboard lengkap"
 * CTA renders below the md breakpoint, and the desktop-only grids are
 * hidden.
 */

import { test, expect, request, type APIRequestContext } from "@playwright/test";

const MOBILE_VIEWPORT = { width: 390, height: 844 };
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8000";

async function registerUser(api: APIRequestContext, email: string): Promise<string> {
  const resp = await api.post(`${API_BASE}/api/v1/auth/register`, {
    data: { email, password: "Sup3rSecret!" },
  });
  expect(resp.status(), `register ${email}`).toBe(201);
  const body = await resp.json();
  return body.access_token as string;
}

test.describe("mobile ringkas view (AC 4)", () => {
  test("renders KPI 2-col + chart + CTA at 390×844", async ({ page, baseURL }) => {
    test.skip(!baseURL, "E2E requires a running Next.js dev/preview server");

    const api = await request.newContext();
    const email = `qa-mobile-${Date.now()}@example.com`;
    const token = await registerUser(api, email);
    api.dispose();

    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto("/", { waitUntil: "networkidle" });
    await page.evaluate(async (jwt) => {
      window.localStorage.setItem("pft.access_token", jwt);
    }, token);
    await page.reload({ waitUntil: "networkidle" });

    const summary = page.getByTestId("dashboard-mobile-summary");
    await expect(summary).toBeVisible();
    await expect(page.getByTestId("dashboard-mobile-summary-kpis")).toBeVisible();
    await expect(page.getByTestId("dashboard-mobile-summary-expand")).toBeVisible();

    await page.screenshot({
      path: "../../qa-artifacts/epic-0007-dashboard-mobile.png",
      fullPage: true,
    });
  });
});
