// PR #7: browser back/forward navigates between tabs.

import { test, expect } from "@playwright/test";
import { gotoApp, switchTab } from "./helpers/app.mjs";

test.describe("PR #7 router popstate", () => {
  test("clicking through 3 tabs then pressing back twice restores state", async ({
    page,
  }) => {
    await gotoApp(page); // lands on picks
    await switchTab(page, "watchlist");
    await expect(page.locator("#watchlistTab")).toBeVisible();
    await switchTab(page, "track");
    await expect(page.locator("#trackTab")).toBeVisible();

    // Back → watchlist
    await page.goBack();
    await expect(page.locator("#watchlistTab")).toBeVisible({ timeout: 5000 });
    // Back → picks
    await page.goBack();
    await expect(page.locator("#picksTab")).toBeVisible({ timeout: 5000 });
    // Forward → watchlist
    await page.goForward();
    await expect(page.locator("#watchlistTab")).toBeVisible({ timeout: 5000 });
  });
});
