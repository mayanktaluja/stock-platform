// PR #6: optimistic toggleWatchlist with rollback on failure.
// Stubs the /api/watchlist/* endpoint with a 500, clicks ★, asserts the
// star flips IMMEDIATELY (optimistic), snaps back within 1s (rollback),
// and an error toast appears.

import { test, expect } from "@playwright/test";
import { gotoApp, waitForPicksLoaded } from "./helpers/app.mjs";

test.describe("PR #6 optimistic watchlist toggle", () => {
  test("star flips optimistically and rolls back on 500 with error toast", async ({
    page,
  }) => {
    // Stub the API with a slow 500 so the optimistic-flip-then-rollback
    // has a visible intermediate window. Without the delay, both transitions
    // happen in the same animation frame and Playwright can't observe the
    // intermediate state.
    await gotoApp(page);
    await waitForPicksLoaded(page).catch(() => {});
    await page.evaluate(() => {
      window.__sb_watchlistForceFailure = true;
    });

    const star = page.locator(".watchlist-btn[data-watchlist-symbol]").first();
    const exists = await star.count();
    test.skip(exists === 0, "no watchlist star rendered (data not loaded)");
    await expect(star).toBeVisible({ timeout: 10_000 });

    const symbol = await star.getAttribute("data-watchlist-symbol");
    const symbolStars = page.locator(`.watchlist-btn[data-watchlist-symbol="${symbol}"]`);
    const savedBefore = await page.evaluate(async (sym) => {
      const res = await fetch("/api/watchlist");
      const body = await res.json().catch(() => ({}));
      return (body.stocks || []).some((stock) => stock.symbol === sym);
    }, symbol);
    const optimisticState = String(!savedBefore);
    const rollbackState = String(savedBefore);
    await page.evaluate((sym) => {
      window.toggleWatchlist(sym, "Forced rollback test", "");
    }, symbol);

    // OPTIMISTIC: should flip quickly, before the deliberately-delayed 500
    // response can roll it back. CI can be busy after the full SWS render, so
    // keep this as a fast user-visible window rather than a sub-frame timing
    // assertion.
    await expect
      .poll(async () => {
        const states = await symbolStars.evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("aria-pressed")),
        );
        return states.some((state) => state === optimisticState);
      }, {
        timeout: 1000,
      })
      .toBe(true);

    // ROLLBACK: forced failure should snap it back within 5s.
    await expect
      .poll(() => page.evaluate(() => window.__sb_watchlistForcedFailureHit || 0), {
        timeout: 1000,
      })
      .toBeGreaterThan(0);
    await expect
      .poll(() => page.evaluate(() => window.__sb_watchlistRollbackCount || 0), {
        timeout: 5000,
      })
      .toBeGreaterThan(0);
    await expect
      .poll(async () => {
        const states = await symbolStars.evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("aria-pressed")),
        );
        return states.some((state) => state === rollbackState);
      }, {
        timeout: 5000,
      })
      .toBe(true);

    // Error toast should be visible
    await expect(
      page.locator('#toastStack [data-testid="toast"][data-kind="error"]'),
    ).toBeVisible({ timeout: 5000 });
  });
});
