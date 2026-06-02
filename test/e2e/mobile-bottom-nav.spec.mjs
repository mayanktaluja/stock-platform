// PR #10: bottom-nav visible at ≤720px, click delegates to switchTab,
// aria-current sync with the active tab.

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

test.describe("PR #10 mobile bottom-nav", () => {
  test("bottom-nav is hidden on desktop (>720px)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoApp(page);
    const nav = page.locator(".bottom-nav");
    await expect(nav).toBeHidden();
  });

  test("bottom-nav is visible at 375px width", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await gotoApp(page);
    const nav = page.locator(".bottom-nav");
    await expect(nav).toBeVisible({ timeout: 5000 });
  });

  test("top tab rail controls remain usable on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await gotoApp(page);
    const rail = page.locator("#mainTabs");
    const right = page.locator('.main-tabs-rail [data-scroll-dir="right"]');
    await expect(right).toBeVisible({ timeout: 5000 });
    const before = await rail.evaluate((el) => el.scrollLeft);
    await right.click();
    await expect.poll(() => rail.evaluate((el) => el.scrollLeft)).toBeGreaterThan(before);
    await expect(page.locator(".bottom-nav")).toBeVisible();
  });

  test("clicking a bottom-nav button switches tab", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await gotoApp(page);
    await page
      .locator('.bottom-nav-btn[data-tab="watchlist"]')
      .click({ force: true });
    await expect(page.locator("#watchlistTab")).toBeVisible({ timeout: 5000 });
  });
});
