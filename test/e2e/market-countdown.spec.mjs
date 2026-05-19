// PR #10: #marketCountdown shows a live "opens in X" / "closes in X"
// label inside the market-status pill, driven by updateClock().

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

test.describe("PR #10 market countdown chip", () => {
  test("#marketCountdown is populated within 2s of boot", async ({ page }) => {
    await gotoApp(page);
    const el = page.locator("#marketCountdown");
    await expect(el).toBeAttached();
    // updateClock fires every second; give it 2 ticks to populate.
    await expect
      .poll(async () => (await el.textContent())?.trim(), { timeout: 3000 })
      .toMatch(/opens in|closes in/i);
  });

  test("countdown contains 'opens in' or 'closes in' text", async ({ page }) => {
    await gotoApp(page);
    const text = await page
      .locator("#marketCountdown")
      .textContent({ timeout: 5000 });
    expect(text).toMatch(/(opens|closes) in/i);
  });
});
