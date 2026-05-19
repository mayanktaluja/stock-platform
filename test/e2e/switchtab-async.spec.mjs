// PR #5: switchTab is now async (refactored to a dispatch table that
// awaits the per-tab enter() handler). This spec locks in:
//   1. switchTab returns a Promise (so PR #7's hash writer can await it).
//   2. The function is still globally callable (inline onclick=
//      "switchTab('picks')" handlers must keep working).
//   3. Calling with an unknown tab falls through to picks (preserves
//      pre-PR5 default behaviour).

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

test.describe("PR #5 switchTab dispatch refactor", () => {
  test("window.switchTab exists and returns a Promise", async ({ page }) => {
    await gotoApp(page);
    const r = await page.evaluate(() => {
      const out = window.switchTab("picks");
      return {
        isFunction: typeof window.switchTab === "function",
        isThenable: !!(out && typeof out.then === "function"),
      };
    });
    expect(r.isFunction).toBe(true);
    expect(r.isThenable).toBe(true);
  });

  test("switchTab to a known tab makes that tab visible", async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => window.switchTab("watchlist"));
    await expect(page.locator("#watchlistTab")).toBeVisible({ timeout: 5000 });
  });

  test("switchTab with an unknown tab falls through to picks", async ({
    page,
  }) => {
    await gotoApp(page);
    await page.evaluate(() => window.switchTab("nonexistent-tab"));
    await expect(page.locator("#picksTab")).toBeVisible({ timeout: 5000 });
  });
});
