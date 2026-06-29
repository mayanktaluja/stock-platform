// India Picks · PR4 — market-regime context strip.
//
// Wires the existing /api/macro/regime feed into the picks loader and renders a
// risk-on/off context strip at the top of the homepage. Verifies the populated
// strip (tone keyed to severity, label, confidence, sector impacts) and graceful
// absence when the feed is unreachable.

import { test, expect } from "@playwright/test";
import { gotoApp, waitForPicksLoaded } from "./helpers/app.mjs";

const PICKS_BODY = {
  schema_version: "picks-latest-v4",
  scoring_version: "test",
  scanned_at: "2026-06-15T06:00:00.000Z",
  indexConstituentsAvailable: false,
  sections: {
    top_ranked_30_v4: [{
      ticker: "ANCHOR",
      name: "Anchor Ltd",
      sector: "Industrials",
      current_price_inr: 100,
      fair_value_inr: 130,
      upside_pct: 30,
      v4_score_100: 65,
      v4_verdict: "STRONG",
      score: 65,
      snowflake_total: 22,
      one_line: "Synthetic anchor row",
      data_freshness_at: "2026-06-15T06:00:00.000Z",
    }],
  },
};

async function mockPicks(page) {
  await page.route("**/api/sws-picks**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (!pathname.endsWith("/api/sws-picks") && !pathname.endsWith("/api/sws-picks-summary")) {
      await route.fallback();
      return;
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(PICKS_BODY) });
  });
}

test.describe("India Picks · market-regime strip", () => {
  test("renders the regime strip with tone, label, confidence and sector impacts", async ({ page }) => {
    await mockPicks(page);
    await page.route("**/api/macro/regime", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          regime: "OIL_SHOCK",
          regimeLabel: "Oil Shock",
          severity: 3,
          confidence: 0.7,
          sectorImpacts: [
            { sector: "Aviation", impact: -3, reason: "Fuel costs up" },
            { sector: "Energy", impact: 2, reason: "Crude rally" },
          ],
          generatedAt: "2026-06-29T12:00:00.000Z",
        }),
      });
    });

    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    const strip = page.getByTestId("picks-regime-strip");
    await expect(strip).toBeVisible();
    await expect(strip).toHaveAttribute("data-tone", "caution"); // severity 3 → elevated
    await expect(strip).toContainText(/Oil Shock/);
    await expect(strip).toContainText(/70% conf/);
    await expect(strip.locator(".sws-regime-sector").first()).toContainText(/Aviation -3/);
  });

  test("hides the strip gracefully when the macro feed is unreachable", async ({ page }) => {
    await mockPicks(page);
    await page.route("**/api/macro/regime", (route) => route.abort());

    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    await expect(page.getByTestId("picks-regime-strip")).toHaveCount(0);
    // The rest of the page still renders.
    await expect(page.locator('.sws-pick-section[data-section-key="top_ranked_30_v4"]')).toBeVisible();
  });
});
