// Two-Key Entry (PR-2, advisory stage) — the entry-timing chip renders beside the
// untouched value badge, keyed to the nightly-stamped entry_timing.state, and rows
// without entry_timing (legacy / region forks / NO_DATA) render exactly as before.
//
// Route-mocked (no live-data precondition): the spec fulfills /api/sws-picks with
// synthetic rows in each timing state and asserts the chip's presence, label, and
// absence — plus that the Key-1 "Actionable now" badge is untouched by the overlay.

import { test, expect } from "@playwright/test";
import { gotoApp, waitForPicksLoaded } from "./helpers/app.mjs";

function baseRow(ticker, entryTiming) {
  return {
    ticker,
    name: `${ticker} Ltd`,
    sector: "Industrials",
    current_price_inr: 100,
    fair_value_inr: 130,
    upside_pct: 30,
    valuation_band: "DISCOUNT",
    fair_value_confidence: "HIGH",
    v4_score_100: 70,
    v4_verdict: "STRONG",
    score: 70,
    snowflake_total: 20,
    one_line: "Synthetic row",
    data_freshness_at: "2026-06-15T06:00:00.000Z",
    entry_band: {
      available: true,
      entry_state: "BUY_ZONE",
      fresh_buy_eligible: true,
      no_buy_above_inr: 117,
      reasons: [],
    },
    ...(entryTiming ? { entry_timing: entryTiming } : {}),
  };
}

test.describe("India Picks · Two-Key entry-timing chip (advisory)", () => {
  test("chip renders per timing state; legacy rows render no chip; value badge untouched", async ({ page }) => {
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
              baseRow("KNIFEY", {
                version: "entry-timing-v1-2026-07",
                state: "FALLING_KNIFE",
                reasons: ["knife_1m"],
                momentum_pct_3m: 0.12,
                fiftytwo_week_position: 0.05,
                tier: 1,
              }),
              baseRow("CONFIRMD", {
                version: "entry-timing-v1-2026-07",
                state: "ENTRY_CONFIRMED",
                reasons: ["confirmed_momentum_base"],
                momentum_pct_3m: 0.68,
                fiftytwo_week_position: 0.42,
                tier: 1,
              }),
              baseRow("MACROHLD", {
                version: "entry-timing-v1-2026-07",
                state: "MACRO_DEFER",
                reasons: ["macro_defer_sector", "confirmed_momentum_base"],
                momentum_pct_3m: 0.7,
                fiftytwo_week_position: 0.5,
                tier: 1,
              }),
              baseRow("LEGACY", null),
            ],
          },
        }),
      });
    });

    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    const cardFor = (ticker) =>
      page.locator(".sws-pick-card", { hasText: ticker }).first();

    // Knife: chip present with the knife label + red class.
    const knifeChip = cardFor("KNIFEY").locator('[data-testid="entry-readiness-chip"]');
    await expect(knifeChip).toHaveText("Knife falling");
    await expect(knifeChip).toHaveClass(/sws-entry-timing-chip--knife/);

    // Confirmed: both keys visible — value badge AND timing chip.
    const confirmedCard = cardFor("CONFIRMD");
    await expect(confirmedCard.locator('[data-testid="entry-readiness-chip"]')).toHaveText("Timing ✓");
    await expect(confirmedCard.locator('[data-testid="decision-state"]').first()).toBeVisible();

    // Macro defer renders its own label.
    await expect(cardFor("MACROHLD").locator('[data-testid="entry-readiness-chip"]')).toHaveText("Macro hold");

    // Legacy row (no entry_timing): NO chip, and the Key-1 badge still renders —
    // the overlay is strictly additive.
    const legacyCard = cardFor("LEGACY");
    await expect(legacyCard.locator('[data-testid="entry-readiness-chip"]')).toHaveCount(0);
    await expect(legacyCard.locator('[data-testid="decision-state"]').first()).toBeVisible();
  });
});
