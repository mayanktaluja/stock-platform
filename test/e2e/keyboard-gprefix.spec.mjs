// PR #8: g-prefix tab jumps. Type `g` then `w` within 600 ms to jump
// to the Watchlist tab. Must be a no-op when focus is inside an input.

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

test.describe("PR #8 g-prefix tab jumps", () => {
  test("'g w' switches to Watchlist tab", async ({ page }) => {
    await gotoApp(page);
    await page.locator("body").click({ position: { x: 500, y: 400 } });
    await page.keyboard.press("g");
    await page.keyboard.press("w");
    await expect(page.locator("#watchlistTab")).toBeVisible({ timeout: 5000 });
  });

  test("'g t' switches to Track Record tab", async ({ page }) => {
    await gotoApp(page);
    await page.locator("body").click({ position: { x: 500, y: 400 } });
    await page.keyboard.press("g");
    await page.keyboard.press("t");
    await expect(page.locator("#trackTab")).toBeVisible({ timeout: 5000 });
  });

  test("g-prefix is suppressed when focus is inside #searchInput", async ({
    page,
  }) => {
    await gotoApp(page);
    await page.locator("#searchInput").focus();
    await page.keyboard.press("g");
    await page.keyboard.press("w");
    // Picks must stay visible — the g w should NOT have fired tab-jump
    await expect(page.locator("#picksTab")).toBeVisible({ timeout: 2000 });
    // Search input should contain "gw" since we just typed into it
    const value = await page.locator("#searchInput").inputValue();
    expect(value).toBe("gw");
  });
});
