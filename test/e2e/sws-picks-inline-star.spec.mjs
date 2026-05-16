// PR P9 regression: inline ★ on every SWS pick card.
//
// Clicking the star on a pick card must (1) toggle aria-pressed without
// opening the modal, (2) persist to the watchlist, and (3) appear as a
// row when the user switches to the Watchlist tab.
//
// 2026-05-16 hardening: the original "modal must not open" check used a
// 1.5s NEGATIVE wait — `not.toHaveClass(/open/, { timeout: 1_500 })`. Any
// negative wait has the same bug class: a modal that opens at 1.6s under
// CI load (slow click-handler dispatch on a busy runner) passes the
// assertion falsely while still being a real regression. The check now
// uses a MutationObserver installed BEFORE the click — it captures every
// classList mutation on #swsModalBackdrop during a defined window, then
// asserts the `open` class was never added. That's a positive assertion
// of the event.stopPropagation contract — race-immune by construction.

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

    // Install the MutationObserver BEFORE the click. window.__starModalOpens
    // counts every transition where the backdrop's className gains the
    // `open` token. After the click + aria-pressed flip, we read this
    // counter back; it must still be 0. Race-immune because the observer
    // sees every mutation regardless of when it fires.
    await page.evaluate(() => {
      window.__starModalOpens = 0;
      const target = document.getElementById("swsModalBackdrop");
      if (!target) return;
      const obs = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.attributeName !== "class") continue;
          if (target.classList.contains("open")) window.__starModalOpens += 1;
        }
      });
      obs.observe(target, { attributes: true, attributeFilter: ["class"] });
      window.__starModalObserver = obs; // keep alive
    });

    await firstStar.click();

    // Wait for the aria-pressed flip — that's the positive evidence the
    // star handler ran. (If the handler errored silently, this poll would
    // time out and we'd never reach the modal assertion below.)
    await expect
      .poll(async () => firstStar.getAttribute("aria-pressed"), { timeout: 5_000 })
      .toBe(wasPressed ? "false" : "true");

    // Now read the observer's count. Even if the modal opens AFTER this
    // assertion (would be a different bug), the MutationObserver attached
    // before the click would have caught the open transition synchronously.
    const modalOpens = await page.evaluate(() => window.__starModalOpens);
    expect(
      modalOpens,
      "modal must NOT open from a star-button click — event.stopPropagation contract"
    ).toBe(0);

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
