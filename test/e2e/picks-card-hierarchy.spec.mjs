// India Picks · PR3 — pick-card focal hierarchy + chip overflow.
//
// The ticker line used to interleave up to 8 badges next to the symbol, so
// every card read as equally loud. PR3 lifts the informational badges
// (section-context, New/↑N, freshness) into a dedicated chip row below the
// decision row, collapses anything past the 4th behind a "+N" toggle, and
// keeps the ticker + score + verdict as the focal point. The always-visible
// risk row is NOT part of the overflow — material risk flags never hide.

import { test, expect } from "@playwright/test";
import { gotoApp, waitForPicksLoaded } from "./helpers/app.mjs";

function baseRow(ticker, score, verdict, extra = {}) {
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
    snowflake: { health: 5, future: 5, past: 4, value: 4, dividend: 3 },
    one_line: "Synthetic row",
    data_freshness_at: "2026-06-15T06:00:00.000Z",
    ...extra,
  };
}

// A growing_sector_value row that emits 5 chip slots: New/↑N (one slot),
// sector-tailwind, Future, FV 30%+, and freshness — one past the 4-visible cap.
// Mirrors the known-good Growing-Sector-Value fixture in sws-picks-filters.spec.
function manyChipRow() {
  return baseRow("MANYCHIP", 66, "STRONG", {
    sector: "Automobile",
    fair_value_inr: 140,
    upside_pct: 40,
    valuation_band: "DEEP_DISCOUNT",
    snowflake: { future_growth: 4, future: 4 },
    sector_tailwind_label: "STRONG_TAILWIND",
    sector_tailwind_confidence: "HIGH",
    sector_tailwind_reason: "Sector momentum",
    fv_discount_badge_30plus: true,
    section_status: { newly_added: true, trending: true, rank_delta: 3, prior_scanned_at: "2026-06-14T06:00:00.000Z" },
    entry_band: { available: true, entry_state: "BUY_ZONE", fresh_buy_eligible: true, reasons: [] },
  });
}

function riskyRow() {
  return baseRow("RISKY", 60, "STRONG", {
    data_completeness_pct: 40,
    regulatory_flags: { surveillance: { list: "ASM", timeframe: "ST-1" } },
    entry_band: {
      available: true,
      entry_state: "NO_BUY_ABOVE",
      fresh_buy_eligible: false,
      no_buy_above_inr: 120,
      reasons: [{ code: "fv_low_confidence", message: "FV confidence low" }],
    },
  });
}

async function routePicks(page) {
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
          top_ranked_30_v4: [baseRow("CLEANTP", 75, "TOP_PICK"), riskyRow()],
          best_to_buy_now: [],
          deep_value: [],
          quality_growth: [],
          growing_sector_value: [manyChipRow()],
        },
      }),
    });
  });
}

test.describe("India Picks · card focal hierarchy", () => {
  test("informational badges move off the ticker line into the chip row", async ({ page }) => {
    await routePicks(page);
    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    const many = page.locator('.sws-pick-card[data-ticker="MANYCHIP"]');
    await expect(many).toHaveCount(1);

    // Ticker line carries the symbol + sector only — no status/section badges.
    const tickerLine = many.locator(".sws-pick-card-ticker");
    await expect(tickerLine).toContainText("MANYCHIP");
    await expect(tickerLine.locator(".sws-pick-badge")).toHaveCount(0);
    await expect(tickerLine.locator(".sws-fund-badge")).toHaveCount(0);

    // Those badges now live in the dedicated chip row.
    const chiprow = many.locator(".sws-pick-chiprow");
    await expect(chiprow).toHaveCount(1);
    await expect(chiprow.locator(".sws-pick-badge--new")).toHaveCount(1);

    // Focal elements read without any interaction.
    await expect(many.locator(".sws-pick-card-score-num")).toBeVisible();
    await expect(many.locator(".sws-pick-card-score-verdict")).toBeVisible();
    await expect(many.locator('[data-testid="decision-state"]').first()).toBeVisible();
  });

  test("chips past the 4th collapse behind +N and expand without opening the modal", async ({ page }) => {
    await routePicks(page);
    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    const chiprow = page.locator('.sws-pick-card[data-ticker="MANYCHIP"] .sws-pick-chiprow');
    // At most 4 chip slots are visible before expanding.
    await expect(chiprow.locator('.swp-chip-slot:not([data-overflow])')).toHaveCount(4);
    const overflow = chiprow.locator(".swp-chip-slot[data-overflow]");
    await expect(overflow.first()).toBeHidden();

    const more = chiprow.locator(".swp-chip-more");
    await expect(more).toHaveText("+1");
    // dispatchEvent, not click(): in the 2-section e2e fixture the sticky
    // section header overlaps the card, so a real pointer click lands on the
    // header. Dispatching fires the button's own onclick — exercising the
    // toggle + its stopPropagation guard — without the overlay getting in the way.
    await more.dispatchEvent("click");

    // Overflow chip is now visible, and the card modal did NOT open.
    await expect(overflow.first()).toBeVisible();
    await expect(more).toHaveText("−");
    await expect(page.locator("#swsModalBackdrop")).not.toHaveClass(/open/);
  });

  test("the risk row stays visible and never overflows", async ({ page }) => {
    await routePicks(page);
    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    const risky = page.locator('.sws-pick-card[data-ticker="RISKY"]');
    const riskRow = risky.locator(".sws-pick-risk-row");
    await expect(riskRow).toBeVisible();
    await expect(riskRow.locator(".sws-surveillance-badge")).toContainText("ASM");
    // The risk row is a sibling of the chip row, not inside it, so it is never
    // subject to the +N overflow.
    await expect(risky.locator(".sws-pick-chiprow .sws-pick-risk-row")).toHaveCount(0);
  });
});
