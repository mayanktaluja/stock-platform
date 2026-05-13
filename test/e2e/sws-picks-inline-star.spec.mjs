// PR P9 regression: inline ★ on every SWS pick card.
//
// Clicking the star on a pick card must (1) toggle aria-pressed without
// opening the modal, (2) persist to the watchlist, and (3) appear as a
// row when the user switches to the Watchlist tab.

import { test, expect } from "@playwright/test";
import { gotoApp, switchTab, waitForPicksLoaded } from "./helpers/app.mjs";

test.describe("SWS Picks inline ★ (PR P9)", () => {
  test("clicking ★ on a pick card adds to Watchlist without opening modal", async ({ page }) => {
    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    const firstStar = page.locator(".sws-pick-card .sws-pick-inline-star .watchlist-btn").first();
    await expect(firstStar).toBeVisible({ timeout: 10_000 });
    const sym = await firstStar.getAttribute("data-watchlist-symbol");
    expect(sym).toBeTruthy();
    const wasPressed = (await firstStar.getAttribute("aria-pressed")) === "true";
    await firstStar.click();
    // Modal must NOT open from this click — event.stopPropagation contract.
    await expect(page.locator("#swsModalBackdrop")).not.toHaveClass(/open/, { timeout: 1_500 });

    await expect
      .poll(async () => firstStar.getAttribute("aria-pressed"))
      .toBe(wasPressed ? "false" : "true");

    if (!wasPressed) {
      // Newly added → Watchlist row should appear.
      await switchTab(page, "watchlist");
      const watchlistTab = page.locator("#watchlistTab");
      await expect(watchlistTab).toBeVisible();
      await expect
        .poll(async () => watchlistTab.locator(`[data-watchlist-symbol="${sym}"]`).count(), {
          timeout: 10_000,
        })
        .toBeGreaterThan(0);
    }
  });
});
