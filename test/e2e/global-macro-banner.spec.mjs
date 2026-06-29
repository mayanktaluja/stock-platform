import { test, expect } from "@playwright/test";
import { gotoApp, waitForPicksLoaded } from "./helpers/app.mjs";

// The heavy global #macroRegimeBanner was retired from the India shell. The India
// homepage redesign (PR4) re-introduced macro context as a COMPACT, opt-out strip
// (.sws-pick-regime-strip) fed by /api/macro/regime — deliberately, not the old
// banner. This guard keeps the old banner gone while allowing the new strip.
test.describe("global macro regime banner", () => {
  test("the old heavy global macro banner stays retired on the India shell", async ({ page }) => {
    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);
    // The old element + its branding must not come back.
    await expect(page.locator("#macroRegimeBanner")).toHaveCount(0);
    const visibleText = await page.locator("body").evaluate((body) => body.innerText);
    expect(visibleText).not.toMatch(/\bMarket Regime\b/);
  });

  test("India homepage renders the compact regime strip from /api/macro/regime", async ({ page }) => {
    await page.route("**/api/macro/regime", (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        regime: "CALM",
        regimeLabel: "Calm",
        severity: 1,
        confidence: 0.8,
        sectorImpacts: [],
        generatedAt: "2026-06-29T12:00:00.000Z",
      }),
    }));
    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    const strip = page.getByTestId("picks-regime-strip");
    await expect(strip).toBeVisible();
    await expect(strip).toContainText(/Regime/i);   // the compact "Regime" kicker
    await expect(strip).toContainText(/Calm/);
    // It is the compact strip, NOT the retired heavy banner.
    await expect(page.locator("#macroRegimeBanner")).toHaveCount(0);
  });
});
