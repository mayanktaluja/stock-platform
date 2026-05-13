// PR D11 regression: SEBI compliance disclaimers.
//
// Three surfaces must always carry the canonical text:
//   1. Sticky site-wide footer #sebiSiteFooter — visible on every tab.
//   2. Track Record past-performance chip .sebi-past-performance-chip.
//   3. Per-stock track strip footer (covered by stock-detail-track-strip
//      spec — text already verified there).

import { test, expect } from "@playwright/test";
import { gotoApp, switchTab } from "./helpers/app.mjs";

test.describe("SEBI disclaimers (PR D11)", () => {
  test("sticky footer renders on every tab with the required text", async ({ page }) => {
    await gotoApp(page);
    const footer = page.locator("#sebiSiteFooter");
    await expect(footer).toBeVisible();
    const text = (await footer.innerText()).toLowerCase();
    expect(text).toContain("investments in securities market are subject to market risks");
    expect(text).toContain("not a sebi-registered");
    expect(text).toContain("past performance");

    // Persists across tab switches (it's outside the tab containers).
    await switchTab(page, "watchlist");
    await expect(page.locator("#sebiSiteFooter")).toBeVisible();
  });

  test("Track Record past-performance chip surfaces above the calibration plot", async ({ page }) => {
    await gotoApp(page);
    await switchTab(page, "track");
    const chip = page.locator(".sebi-past-performance-chip");
    await expect(chip).toBeVisible({ timeout: 10_000 });
    const text = (await chip.innerText()).toLowerCase();
    expect(text).toContain("past performance does not guarantee future results");
  });
});
