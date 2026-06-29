// India Picks · PR5 — Snowflake pillar mini-bars.
//
// Each card decomposes its "Snow N/30" badge into 5 SWS pillars (Health/Future/
// Past/Value/Dividend, 0–6 each) from s.snowflake — already on every row. The fill
// is colour-banded by level so a value trap (strong Health/Future, weak Value)
// reads at a glance. Cards without snowflake data render no bars.

import { test, expect } from "@playwright/test";
import { gotoApp, waitForPicksLoaded } from "./helpers/app.mjs";

function base(ticker) {
  return {
    ticker,
    name: `${ticker} Ltd`,
    sector: "Industrials",
    current_price_inr: 100,
    fair_value_inr: 130,
    upside_pct: 30,
    v4_score_100: 65,
    v4_verdict: "STRONG",
    score: 65,
    snowflake_total: 19,
    one_line: "Synthetic row",
    data_freshness_at: "2026-06-15T06:00:00.000Z",
  };
}

test.describe("India Picks · pillar mini-bars", () => {
  test("cards render 5 colour-banded pillar bars from snowflake; absent when no data", async ({ page }) => {
    await page.route("**/api/sws-picks**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (!pathname.endsWith("/api/sws-picks") && !pathname.endsWith("/api/sws-picks-summary")) {
        await route.fallback();
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          schema_version: "picks-latest-v4",
          scoring_version: "test",
          scanned_at: "2026-06-15T06:00:00.000Z",
          indexConstituentsAvailable: false,
          sections: {
            top_ranked_30_v4: [
              // Strong Health/Future, weak Value — the value-trap shape.
              { ...base("PILLARS"), snowflake: { health: 6, future: 5, past: 4, value: 1, dividend: 3 } },
              // No snowflake object → no pillar bars.
              base("NOPILLARS"),
            ],
          },
        }),
      });
    });

    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    const card = (t) => page.locator(`.sws-pick-card[data-ticker="${t}"]`);

    const pillars = card("PILLARS").locator(".sws-pick-pillars");
    await expect(pillars).toHaveCount(1);
    await expect(pillars.locator(".sws-pillar")).toHaveCount(5);
    await expect(pillars).toContainText("Health");
    await expect(pillars).toContainText("Value");

    // High pillar (Health 6) and low pillar (Value 1) are level-banded for colour.
    await expect(card("PILLARS").locator('.sws-pillar:has(.sws-pillar-label:text-is("Health")) .sws-pillar-fill'))
      .toHaveAttribute("data-lvl", "6");
    await expect(card("PILLARS").locator('.sws-pillar:has(.sws-pillar-label:text-is("Value")) .sws-pillar-fill'))
      .toHaveAttribute("data-lvl", "1");

    // A row without snowflake data renders no pillar bars.
    await expect(card("NOPILLARS").locator(".sws-pick-pillars")).toHaveCount(0);
  });
});
