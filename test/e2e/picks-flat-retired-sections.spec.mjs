// India homepage redesign · PR1 contract guard (real fixture data).
//
// Pins the three user-requested changes to the India "picks" tab:
//   1. The "View" dropdown (Flat / Grouped) is removed — sections always
//      render flat, so there are no #picksGroupMode control and no group headers.
//   2. The "Today's shortlist · Fresh-buy" SECTION and the "Upcoming Earnings"
//      SECTION are removed from the homepage. The slim today-shortlist-state
//      summary banner is removed too — nothing on the India homepage references
//      best_to_buy_now anymore (the server still ships the key for other tabs).
//   3. Quality Growth is promoted to the 2nd rendered section, right after Top 30.
//
// Runs against whatever picks snapshot the env ships; self-skips when the tab
// renders no sections (fresh checkout without picks-latest.json).

import { test, expect } from "@playwright/test";
import { gotoApp, waitForPicksLoaded } from "./helpers/app.mjs";

// Canonical India section order after PR1 (best_to_buy_now + upcoming_earnings
// removed from PICKS_SECTIONS; quality_growth moved to index 1).
const CANON = [
  "top_ranked_30_v4",
  "quality_growth",
  "deep_value",
  "growing_sector_value",
  "snowflake_gap_lab",
  "best_fundamentals",
  "midterm",
  "dividend_aristocrats",
  "smallcap_gems",
  "insider_buying",
];

test.describe("India homepage · flat layout + retired sections", () => {
  test("no view dropdown / group headers; sections flat; Quality Growth 2nd; banner removed", async ({ page }) => {
    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    const sectionKeys = await page
      .locator('#picksTab .sws-pick-section[data-section-key]')
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-section-key")));
    test.skip(sectionKeys.length === 0, "no picks sections rendered in this snapshot");

    // 1. View dropdown + grouping are gone.
    await expect(page.locator("#picksGroupMode")).toHaveCount(0);
    await expect(page.locator(".sws-pick-group-header")).toHaveCount(0);

    // 2. The two retired sections never render (neither section nor chip);
    //    the slim shortlist summary banner is removed too.
    await expect(page.locator('.sws-pick-section[data-section-key="best_to_buy_now"]')).toHaveCount(0);
    await expect(page.locator('.sws-pick-section[data-section-key="upcoming_earnings"]')).toHaveCount(0);
    await expect(page.locator('.sws-pick-chip[data-section-key="best_to_buy_now"]')).toHaveCount(0);
    await expect(page.locator('.sws-pick-chip[data-section-key="upcoming_earnings"]')).toHaveCount(0);
    await expect(page.getByTestId("today-shortlist-state")).toHaveCount(0);

    expect(sectionKeys).not.toContain("best_to_buy_now");
    expect(sectionKeys).not.toContain("upcoming_earnings");

    // 3. Top 30 first, Quality Growth second.
    expect(sectionKeys[0]).toBe("top_ranked_30_v4");
    expect(sectionKeys[1]).toBe("quality_growth");

    // Every rendered key is known. PR2 declutter renders the curated "core"
    // screens first, then folds the rest into a "More screens" disclosure — so
    // assert core-before-non-core (no core section appears after a non-core one).
    const CORE = new Set([
      "top_ranked_30_v4",
      "quality_growth",
      "deep_value",
      "growing_sector_value",
      "best_fundamentals",
    ]);
    expect(sectionKeys.every((k) => CANON.includes(k))).toBe(true);
    const firstNonCore = sectionKeys.findIndex((k) => !CORE.has(k));
    if (firstNonCore !== -1) {
      expect(sectionKeys.slice(firstNonCore).some((k) => CORE.has(k))).toBe(false);
    }
  });
});
