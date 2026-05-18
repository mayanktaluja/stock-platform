// PR B4 (Phase 2) — Catalyst timeline + macro-thesis health.

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

test.describe("Risk Lab — Catalyst timeline + health (PR B4)", () => {
  test("/api/risk-lab/macro-thesis surfaces upcoming_catalysts", async ({ request }) => {
    const res = await request.get("/api/risk-lab/macro-thesis");
    if (res.status() === 404 || res.status() === 503) test.skip(true, "lab disabled");
    const body = await res.json();
    expect(Array.isArray(body.upcoming_catalysts)).toBe(true);
    for (const c of body.upcoming_catalysts) {
      expect(c).toHaveProperty("days_until");
      expect(c.days_until).toBeGreaterThanOrEqual(0);
      expect(c.days_until).toBeLessThanOrEqual(30);
    }
  });

  test("Macro Thesis sub-view renders catalyst chips when present", async ({ page, request }) => {
    const apiRes = await request.get("/api/risk-lab/macro-thesis");
    if (apiRes.status() === 404 || apiRes.status() === 503) test.skip(true, "lab disabled");
    const body = await apiRes.json();
    test.skip(!body.upcoming_catalysts?.length, "no catalysts in window — skip");

    await gotoApp(page, { tab: "riskLab" });
    await page.click("button:has-text('Macro Thesis')");
    await expect(page.locator('[data-testid="macro-thesis-root"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="thesis-catalysts"]')).toBeVisible();
  });
});
