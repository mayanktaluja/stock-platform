// PR T5 regression: Track Record headline hero.
//
// Opening the Track Record tab must render the headline band (Hit Rate ·
// Avg α · % Beat Nifty · Brier). Brier shows the honest "backfilling"
// sub-line until PR B8 lands the JSON.

import { test, expect } from "@playwright/test";
import { gotoApp, switchTab } from "./helpers/app.mjs";

async function mockTrackSidecars(page) {
  await page.route("**/api/track/sections**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ sections: [], lastComputedAt: "2026-05-27T00:00:00.000Z" }),
    });
  });
  await page.route("**/api/track/section-performance**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ available: true, sections: [], bestOverall: null, rows: [] }),
    });
  });
  await page.route("**/api/track/calibration**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ total: 0, resolved: 0, buckets: [] }),
    });
  });
}

test.describe("Track Record hero (PR T5)", () => {
  test("headline tiles render without the retired misses control", async ({ page }) => {
    await gotoApp(page);
    await switchTab(page, "track");

    const hero = page.locator("#trackHeroStrip");
    await expect(hero).toBeVisible({ timeout: 10_000 });

    await expect(hero.locator("#trackHitRateValue")).toBeVisible();
    await expect(hero.locator("#trackAvgAlphaValue")).toBeVisible();
    await expect(hero.locator("#trackBeatNiftyValue")).toBeVisible();
    await expect(hero.locator("#trackBrierValue")).toBeVisible();
    await expect(hero.locator("#trackMissesShownToggle")).toHaveCount(0);
    await expect(hero).not.toContainText("Misses");

    // Brier sub-line should be the honest empty state until PR B8 lands.
    const brierSub = (await page.locator("#trackBrierSub").innerText()).trim();
    expect(brierSub.toLowerCase()).toContain("backfilling");
  });

  test("populated history payload fills headline KPIs", async ({ page }) => {
    await mockTrackSidecars(page);
    await page.route("**/api/track/history**", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          performance: {
            total: 12,
            winRate: 58.3,
            avgAlpha: 2.34,
            avgReturn: 4.56,
            beatsNiftyRate: 66.7,
            benchmarkSampleSize: 12,
          },
          totalCount: 12,
          trades: [{
            id: "mock-track-1",
            type: "sws_top30_v3",
            symbol: "TEST.NS",
            name: "Test Ltd",
            sector: "Financials",
            snapshotAt: "2026-05-20T00:00:00.000Z",
            priceAtSnapshot: 100,
            regimeAtSnapshot: "CALM",
            returns: { currentPrice: 112, returnPct: 12, alpha: 2.34, beatsNifty: true, daysHeld: 7 },
          }],
          byType: {},
          byRegime: {},
          bySector: {},
          bySectionScorecard: {},
          lastComputedAt: "2026-05-27T00:00:00.000Z",
        }),
      });
    });

    await gotoApp(page);
    await switchTab(page, "track");

    await expect(page.locator("#trackHitRateValue")).toContainText("58.3%");
    await expect(page.locator("#trackAvgAlphaValue")).toContainText("+2.34%");
    await expect(page.locator("#trackBeatNiftyValue")).toContainText("66.7%");
    await expect(page.locator("#trackHitRateValue")).not.toHaveText("—");
    await expect(page.locator("#trackAvgAlphaValue")).not.toHaveText("—");
    await expect(page.locator("#trackBeatNiftyValue")).not.toHaveText("—");
  });

  test("empty history payload keeps honest empty state", async ({ page }) => {
    await mockTrackSidecars(page);
    await page.route("**/api/track/history**", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          trades: [],
          performance: {
            total: 0,
            winRate: null,
            avgReturn: null,
            avgAlpha: null,
            beatsNiftyRate: null,
          },
          currentNifty: null,
          totalCount: 0,
          message: "No paper trades recorded yet. Waiting for the next SWS pipeline run to snapshot picks.",
        }),
      });
    });

    await gotoApp(page);
    await switchTab(page, "track");

    await expect(page.locator("#trackHitRateValue")).toHaveText("—");
    await expect(page.locator("#trackAvgAlphaValue")).toHaveText("—");
    await expect(page.locator("#trackBeatNiftyValue")).toHaveText("—");
    await expect(page.locator("#trackHistoryTable")).toContainText("No paper trades recorded yet");
  });

  test("Track Record stats exposes seeded public history", async ({ request }) => {
    const statsRes = await request.get("/api/track/stats?bust=1");
    expect(statsRes.ok()).toBeTruthy();
    const stats = await statsRes.json();
    test.skip(!stats.publicLineCount, "Track Record has no public seed rows in this environment");
    expect(stats.publicLineCount).toBeGreaterThan(0);
    expect(stats.seedLineCount).toBeGreaterThan(0);
  });
});
