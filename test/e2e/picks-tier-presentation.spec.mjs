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
  test("Best to Buy Now renders three entry-band sub-buckets", async ({ page }) => {
    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    const section = page.locator(`.sws-pick-section[data-section-key="${BUYNOW}"]`);
    await expect(section).toHaveCount(1, { timeout: 10_000 });

    const headers = section.locator(".sws-pick-bucket-header");
    await expect(headers).toHaveCount(3);
    await expect(section.locator(".sws-pick-bucket-header", { hasText: "Buy now" })).toHaveCount(1);
    await expect(section.locator(".sws-pick-bucket-header", { hasText: "Wait for price" })).toHaveCount(1);
    await expect(section.locator(".sws-pick-bucket-header", { hasText: "Watchlist only" })).toHaveCount(1);
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
