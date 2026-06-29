// India Picks · PR3 — inline conviction accent + consolidated risk row.
//
// Each card now carries a data-conviction tier (left-border band keyed to the V4
// score/verdict) so the strongest names read at a glance, and the scattered risk
// flags (NSE surveillance, thin coverage, FV caution, stale data) are consolidated
// into one labelled risk row instead of cluttering the ticker line.

import { test, expect } from "@playwright/test";
import { gotoApp, waitForPicksLoaded } from "./helpers/app.mjs";

function baseRow(ticker, score, verdict) {
  return {
    ticker,
    name: `${ticker} Ltd`,
    sector: "Industrials",
    current_price_inr: 100,
    fair_value_inr: 130,
    upside_pct: 30,
    valuation_band: "DISCOUNT",
    fair_value_confidence: "HIGH",
    v4_score_100: score,
    v4_verdict: verdict,
    score,
    snowflake_total: 20,
    one_line: "Synthetic row",
    data_freshness_at: "2026-06-15T06:00:00.000Z",
  };
}

test.describe("India Picks · conviction accent + risk row", () => {
  test("cards carry a conviction tier; risk flags consolidate into one risk row", async ({ page }) => {
    await page.route("**/api/sws-picks**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (!pathname.endsWith("/api/sws-picks") && !pathname.endsWith("/api/sws-picks-summary")) {
        await route.fallback();
        return;
      }
      const risky = {
        ...baseRow("RISKY", 60, "STRONG"),
        data_completeness_pct: 40,
        regulatory_flags: { surveillance: { list: "ASM", timeframe: "ST-1" } },
        entry_band: {
          available: true,
          entry_state: "NO_BUY_ABOVE",
          fresh_buy_eligible: false,
          no_buy_above_inr: 120,
          reasons: [{ code: "fv_low_confidence", message: "FV confidence low" }],
        },
      };
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          schema_version: "picks-latest-v4",
          scoring_version: "test",
          scanned_at: "2026-06-15T06:00:00.000Z",
          indexConstituentsAvailable: false,
          sections: {
            top_ranked_30_v4: [
              baseRow("STRONGTP", 75, "TOP_PICK"),
              baseRow("WATCHLO", 44, "WATCH"),
              risky,
            ],
          },
        }),
      });
    });

    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    const card = (t) => page.locator(`.sws-pick-card[data-ticker="${t}"]`);

    // Conviction tiers keyed off score/verdict.
    await expect(card("STRONGTP")).toHaveAttribute("data-conviction", "strong");
    await expect(card("WATCHLO")).toHaveAttribute("data-conviction", "watch");
    await expect(card("RISKY")).toHaveAttribute("data-conviction", "high");

    // The risky card consolidates every risk flag into one labelled risk row.
    const riskRow = card("RISKY").locator(".sws-pick-risk-row");
    await expect(riskRow).toHaveCount(1);
    await expect(riskRow.locator(".sws-pick-risk-label")).toContainText(/Risk/i);
    await expect(riskRow.locator(".sws-surveillance-badge")).toContainText("ASM");
    await expect(riskRow.locator(".sws-thin-coverage-badge")).toContainText(/40/);
    await expect(riskRow).toContainText(/FV caution/);

    // Those risk flags are no longer duplicated in the ticker line.
    const tickerLine = card("RISKY").locator(".sws-pick-card-ticker");
    await expect(tickerLine.locator(".sws-surveillance-badge")).toHaveCount(0);
    await expect(tickerLine.locator(".sws-thin-coverage-badge")).toHaveCount(0);

    // A clean strong pick has no risk row at all.
    await expect(card("STRONGTP").locator(".sws-pick-risk-row")).toHaveCount(0);
  });
});
