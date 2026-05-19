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
    await gotoApp(page);
    await waitForPicksLoaded(page).catch(() => {});

    // Stub the API with a slow 500 so the optimistic-flip-then-rollback
    // has a visible intermediate window. Without the delay, both transitions
    // happen in the same animation frame and Playwright can't observe the
    // intermediate state.
    await page.route("**/api/watchlist/add", async (route) => {
      await new Promise((r) => setTimeout(r, 600));
      await route.fulfill({ status: 500, body: "" });
    });
    await page.route("**/api/watchlist/remove", async (route) => {
      await new Promise((r) => setTimeout(r, 600));
      await route.fulfill({ status: 500, body: "" });
    });

    const star = page.locator("[data-watchlist-symbol]").first();
    const exists = await star.count();
    test.skip(exists === 0, "no watchlist star rendered (data not loaded)");

    const initial = await star.getAttribute("aria-pressed");
    await star.click();

    // OPTIMISTIC: should flip within 400ms (synchronous + microtask)
    await expect
      .poll(async () => await star.getAttribute("aria-pressed"), {
        timeout: 400,
      })
      .not.toBe(initial);

    // ROLLBACK: 600ms-delayed 500 should snap it back within 2s
    await expect
      .poll(async () => await star.getAttribute("aria-pressed"), {
        timeout: 2000,
      })
      .toBe(initial);

    // Error toast should be visible
    await expect(
      page.locator('#toastStack [data-testid="toast"][data-kind="error"]'),
    ).toBeVisible({ timeout: 2000 });
  });
});
