// Regression: the "Performance Track Record" credibility ribbon was removed
// from the SWS Picks landing page (PRs #198 + #200). It previously rendered
// five forward-return ribbons + an SVG chart at the top of the tab, fed by
// GET /api/sws/credibility. It didn't present well and was pulled completely.
//
// These tests guard against re-introduction: the section must not be in the
// DOM, the picks accordion must still render without it, and the API route
// must be gone. The separate Track Record *tab* is intentionally untouched.

import { test, expect } from "@playwright/test";
import { gotoApp, waitForPicksLoaded } from "./helpers/app.mjs";

test.describe("SWS Picks — credibility ribbon removed", () => {
  test("no credibility ribbon in the DOM", async ({ page }) => {
    await gotoApp(page, { tab: "picks" });
    // Core guard — needs no fixtures, always runs.
    await expect(page.locator("#picksCredibilitySection")).toHaveCount(0);
    await expect(page.locator(".credibility-section")).toHaveCount(0);
    await expect(page.locator("#picksCredibilityRibbons")).toHaveCount(0);
    await expect(page.locator("#picksCredibilityChart")).toHaveCount(0);
  });

  test("picks accordion still renders with the ribbon gone", async ({ page }) => {
    const probe = await page.request.get("/api/sws-picks");
    test.skip(
      probe.status() === 404,
      "no SWS scan committed yet — picks accordion has no data to render",
    );
    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);
    // The header now sits directly above the filter bar — nothing wedged between.
    await expect(page.locator("#picksFilters")).toBeVisible();
  });

  test("GET /api/sws/credibility route is removed", async ({ request }) => {
    const res = await request.get("/api/sws/credibility");
    expect(res.status()).toBe(404);
  });
});
