// Risk Lab — freshness/degraded banner + action queue + actionable rows.
//
// Self-skips when Risk Lab data is disabled/missing. The degraded UI assertions
// only run when the API reports a degraded state, so the spec does not fail
// after a fully fresh Risk Lab refresh.

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

async function loadRiskLabPayload(request) {
  const apiRes = await request.get("/api/risk-lab/picks-adjusted");
  if (apiRes.status() === 404 || apiRes.status() === 503) {
    test.skip(true, "Risk Lab disabled or picks-adjusted file not generated");
  }
  expect(apiRes.ok()).toBe(true);
  return apiRes.json();
}

async function openRiskLabTab(page) {
  await gotoApp(page, { tab: "riskLab" });
  await expect(page.locator("button:has-text('Quality Lens')")).toBeVisible({ timeout: 15_000 });
}

test.describe("Risk Lab — freshness hardening", () => {
  test("/api/risk-lab/picks-adjusted exposes freshness state and action queue", async ({ request }) => {
    const body = await loadRiskLabPayload(request);
    expect(["ok", "degraded"]).toContain(body.lab_status);
    expect(body.promotion_state).toMatch(/^experimental_/);
    expect(body.runtime_audit?.artifacts?.picks_adjusted).toBeTruthy();
    expect(Array.isArray(body.risk_lab_state?.issues)).toBe(true);
    expect(Array.isArray(body.action_queue)).toBe(true);
  });

  test("degraded API state renders stale banner and prioritized action queue", async ({ page, request }) => {
    const body = await loadRiskLabPayload(request);
    if (!body.risk_lab_state?.degraded) {
      test.skip(true, "Risk Lab artifacts are fresh; degraded banner is intentionally hidden");
    }
    await openRiskLabTab(page);

    await expect(page.getByTestId("risk-lab-degraded-banner")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("risk-lab-degraded-banner")).toContainText("experimental not promoted");
    await expect(page.getByTestId("risk-lab-action-queue")).toBeVisible();
    await expect(page.getByTestId("risk-lab-promotion-state")).toHaveText(body.promotion_state);
    const firstAction = page.getByTestId("risk-lab-action-item").first();
    await expect(firstAction).toBeVisible();
    await expect(firstAction).toContainText(/^P\d/);
  });

  test("ticker rows are actionable through the stock detail modal helper", async ({ page, request }) => {
    const body = await loadRiskLabPayload(request);
    const qualityRows = (body.stocks || []).filter(
      (s) => (s.quality_flags?.length || 0) > 0 || s.quality_veto?.vetoed,
    );
    if (qualityRows.length === 0) test.skip(true, "Quality lens has no rows to click");

    await openRiskLabTab(page);
    await page.evaluate(() => {
      window.__riskLabModalClick = null;
      window.openStockDetailModal = (ticker, source) => {
        window.__riskLabModalClick = { ticker, source };
      };
    });

    const firstRow = page.getByTestId("risk-lab-row").first();
    await expect(firstRow).toBeVisible();
    const firstTicker = (await firstRow.locator("> div").first().textContent()).trim();
    await firstRow.click();
    await expect.poll(() => page.evaluate(() => window.__riskLabModalClick)).toEqual({
      ticker: firstTicker,
      source: "risk-lab",
    });
  });
});
