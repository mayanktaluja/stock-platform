// E2E test 0.3 — Watchlist star persistence.
//
// Regression target: starring a stock via the stock-detail modal must
//   1. flip the button's aria-pressed state immediately, AND
//   2. persist server-side — confirmed by switching to the Watchlist tab
//      and seeing the row appear.
//
// Today the canonical star surface is inside the stock-detail modal title
// (`#swsModalTitle .watchlist-btn`). PR P9 will add an inline ★ on each pick
// card; PR W3 will hydrate the in-memory `watchlist` Set on boot so the
// modal star paints with the correct aria-pressed even before the Watchlist
// tab is visited. Until then, the modal aria-pressed check only runs in the
// "just toggled" direction.

import { test, expect } from "@playwright/test";
import { gotoApp, switchTab, waitForPicksLoaded } from "./helpers/app.mjs";

test.describe("Watchlist star persistence", () => {
  test("star toggle from modal: aria-pressed flips, row reaches Watchlist tab", async ({ page }) => {
    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    await page.locator(".sws-pick-card").first().click();
    await page.locator("#swsModalTitle").waitFor({ state: "visible", timeout: 15_000 });
    const star = page.locator("#swsModalTitle .watchlist-btn").first();
    await expect(star).toBeVisible({ timeout: 5_000 });

    const symbol = await star.getAttribute("data-watchlist-symbol");
    expect(symbol, "modal star must expose data-watchlist-symbol").toBeTruthy();

    const wasPressed = (await star.getAttribute("aria-pressed")) === "true";
    await star.click();
    await expect
      .poll(async () => star.getAttribute("aria-pressed"))
      .toBe(wasPressed ? "false" : "true");

    // Close modal and inspect the Watchlist tab — server-persisted state
    // owns truth here; in-memory Set hydration is a known gap (PR W3 fix).
    await page.keyboard.press("Escape");
    await switchTab(page, "watchlist");
    const watchlistTab = page.locator("#watchlistTab");
    await expect(watchlistTab).toBeVisible();

    if (!wasPressed) {
      // We added it — row must appear.
      await expect
        .poll(
          async () => watchlistTab.locator(`[data-watchlist-symbol="${symbol}"]`).count(),
          { timeout: 10_000, message: "Watchlist row should appear for newly-starred symbol" }
        )
        .toBeGreaterThan(0);
    } else {
      // We removed it — row must be gone.
      await expect
        .poll(
          async () => watchlistTab.locator(`[data-watchlist-symbol="${symbol}"]`).count(),
          { timeout: 10_000, message: "Watchlist row should be absent for unstarred symbol" }
        )
        .toBe(0);
    }
  });
});
