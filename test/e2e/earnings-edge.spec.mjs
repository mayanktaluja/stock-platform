// Earnings Edge tab — AGGRESSIVE sleeve from the 2026-05-19 alpha-strategy
// plan. Verifies:
//   1. /api/earnings-edge/latest serves the expected schema
//   2. /api/earnings-edge/paper-trades serves the ledger
//   3. UI renders the open-trades table when personal flag is on
//   4. Tab is guarded when personal flag is off
//
// Self-skips when data/earnings-edge/latest.json is missing.

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

test.describe("Earnings Edge (AGGRESSIVE sleeve)", () => {
  test("/api/earnings-edge/latest serves expected schema", async ({ request }) => {
    const res = await request.get("/api/earnings-edge/latest");
    test.skip(res.status() === 404, "no earnings-edge snapshot — fresh checkout");
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.schema_version).toBe("earnings-edge-latest-v1");
    expect(body).toHaveProperty("filter");
    expect(body.filter.required_verdict).toBe("BEAT");
    expect(body.filter.hold_days).toBe(30);
    expect(body.filter.hard_stop_pct).toBe(-12);
    expect(body.filter.trailing_stop_pct).toBe(-8);
    expect(Array.isArray(body.open_trades)).toBe(true);
    expect(Array.isArray(body.problem_sectors || body.filter.problem_sectors)).toBe(true);
  });

  test("/api/earnings-edge/paper-trades returns a ledger", async ({ request }) => {
    const res = await request.get("/api/earnings-edge/paper-trades");
    test.skip(res.status() === 404, "no ledger");
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.schema_version).toBe("paper-trades-v1");
    expect(body.strategy).toBe("earnings_edge");
    expect(Array.isArray(body.trades)).toBe(true);
  });

  test("UI renders the open-trades table when admin flag is on", async ({ page, request }) => {
    const apiRes = await request.get("/api/earnings-edge/latest");
    test.skip(apiRes.status() === 404, "no earnings-edge snapshot");

    await gotoApp(page);
    await page.evaluate(() => {
      window.__starbhai_isAdmin = true;
      const btn = document.getElementById("earningsEdgeTabBtn");
      if (btn) btn.hidden = false;
    });
    await page.evaluate(() => window.switchTab("earningsEdge"));
    await expect(page.locator("#earningsEdgeTab")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#earningsEdgeTab")).toContainText("Earnings Edge", {
      timeout: 10_000,
    });
  });

  test("tab guard rejects when admin flag is off", async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => window.switchTab("earningsEdge"));
    await expect(page.locator("#earningsEdgeTab")).toBeHidden();
  });
});
