// Presentation sharpening for the India Picks tab (read-side, no engine change):
//   1. Tiered "Best to Buy Now" — Buy now / Wait for price / Watchlist only
//      sub-buckets derived read-side from entry_band (services/swsBestToBuyTiers.js).
//   2. "Best Fundamentals" renamed to "Core Compounders" on the India tab only.
//
// Regression guard: the rename must NOT leak to Track Record, which keeps its
// own "Best Fundamentals" naming. Specs self-skip when data preconditions
// (a populated picks-latest.json) aren't met rather than fail noisily.

import { test, expect } from "@playwright/test";
import { gotoApp, waitForPicksLoaded } from "./helpers/app.mjs";

const BUYNOW = "best_to_buy_now";
const COMPOUNDERS = "best_fundamentals"; // machine key is unchanged; only the label moved

test.describe("India Picks · tier presentation", () => {
  test("Today's shortlist SECTION and summary banner are both removed", async ({ page }) => {
    // The best_to_buy_now SECTION (three entry-band sub-buckets) was removed from
    // the India homepage first; the slim "Today's shortlist" summary banner that
    // briefly replaced it is now gone too. Nothing on the India homepage references
    // best_to_buy_now anymore. The server still ships sections.best_to_buy_now for
    // other consumers (US/KR/TW tabs, paper trades, track record).
    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    await expect(page.locator(`.sws-pick-section[data-section-key="${BUYNOW}"]`)).toHaveCount(0);
    await expect(page.locator(`.sws-pick-chip[data-section-key="${BUYNOW}"]`)).toHaveCount(0);
    await expect(page.locator(".sws-pick-bucket-header")).toHaveCount(0);
    await expect(page.getByTestId("today-shortlist-state")).toHaveCount(0);
  });

  test("Best Fundamentals is labelled 'Core Compounders' on the India tab", async ({ page }) => {
    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    const title = page
      .locator(`.sws-pick-section[data-section-key="${COMPOUNDERS}"] .sws-pick-section-title .section-name`)
      .first();
    await expect(title).toHaveCount(1, { timeout: 10_000 });
    await expect(title).toContainText("Core Compounders");
    await expect(title).not.toContainText("Best Fundamentals");
  });

  test("regression: Track Record still uses 'Best Fundamentals' label", async ({ page }) => {
    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);
    // The track-record section label is served unchanged from the backend
    // (services/trackRecord/sectionPerformance.js). Verify via the API so the
    // guard doesn't depend on the heavy Track Record tab rendering.
    const res = await page.request.get("/api/track/section-performance");
    test.skip(!res.ok(), `track section-performance API ${res.status()} — skipping rename-leak guard`);
    const body = await res.text();
    expect(body).toContain("Best Fundamentals");
    expect(body).not.toContain("Core Compounders");
  });
});
