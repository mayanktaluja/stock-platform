// PR #6: per-symbol in-flight guard. Two rapid clicks on the same star
// must fire ONLY ONE POST — without this, the second click's response
// rolls back the first's optimistic flip (the race the adversarial
// pass F-15 flagged).

import { test, expect } from "@playwright/test";
import { gotoApp, waitForPicksLoaded } from "./helpers/app.mjs";

test.describe("PR #6 watchlist double-click guard", () => {
  test("two rapid clicks fire only one POST to /api/watchlist", async ({
    page,
  }) => {
    await gotoApp(page);
    await waitForPicksLoaded(page).catch(() => {});

    // Slow the API down enough that the second click definitely overlaps
    // with the first (Playwright's auto-wait between clicks is ~30 ms).
    // 1500 ms gives a comfortable margin.
    const posts = [];
    await page.route("**/api/watchlist/**", async (route) => {
      const url = route.request().url();
      if (route.request().method() === "POST") posts.push(url);
      await new Promise((r) => setTimeout(r, 1500));
      await route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) });
    });

    const star = page.locator("[data-watchlist-symbol]").first();
    const exists = await star.count();
    test.skip(exists === 0, "no watchlist star rendered");

    // Two rapid clicks — fire from inside page evaluate to dispatch both
    // events synchronously, then return. Playwright's click() can introduce
    // its own gaps; we want the guard exercised in the fastest path possible.
    await star.evaluate((el) => {
      el.click();
      el.click();
    });

    // Wait long enough for the in-flight POST to resolve so any 2nd-POST
    // would have been recorded by now.
    await page.waitForTimeout(2200);

    expect(
      posts.length,
      `expected 1 POST, got ${posts.length}: ${posts.join(", ")}`,
    ).toBe(1);
  });
});
