// India homepage redesign · PR1 contract guard (real fixture data).
//
// Pins the three user-requested changes to the India "picks" tab:
//   1. The "View" dropdown (Flat / Grouped) is removed — sections always
//      render flat, so there are no #picksGroupMode control and no group headers.
//   2. The "Today's shortlist · Fresh-buy" SECTION and the "Upcoming Earnings"
//      SECTION are removed from the homepage. The slim today-shortlist-state
//      banner survives (it reads sections.best_to_buy_now directly, independent
//      of the section registry).
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
  test("no view dropdown / group headers; sections flat; Quality Growth 2nd; banner kept", async ({ page }) => {
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
    //    the slim shortlist banner stays.
    await expect(page.locator('.sws-pick-section[data-section-key="best_to_buy_now"]')).toHaveCount(0);
    await expect(page.locator('.sws-pick-section[data-section-key="upcoming_earnings"]')).toHaveCount(0);
    await expect(page.locator('.sws-pick-chip[data-section-key="best_to_buy_now"]')).toHaveCount(0);
    await expect(page.locator('.sws-pick-chip[data-section-key="upcoming_earnings"]')).toHaveCount(0);
    await expect(page.getByTestId("today-shortlist-state")).toBeVisible();

    expect(sectionKeys).not.toContain("best_to_buy_now");
    expect(sectionKeys).not.toContain("upcoming_earnings");

    // 3. Top 30 first, Quality Growth second.
    expect(sectionKeys[0]).toBe("top_ranked_30_v4");
    expect(sectionKeys[1]).toBe("quality_growth");

    // Rendered sections preserve the canonical order (filtered to whatever the
    // snapshot populated) — every key is known and indices strictly increase.
    const canonIdx = sectionKeys.map((k) => CANON.indexOf(k));
    expect(canonIdx).not.toContain(-1);
    for (let i = 1; i < canonIdx.length; i++) {
      expect(canonIdx[i]).toBeGreaterThan(canonIdx[i - 1]);
    }
  });
});
