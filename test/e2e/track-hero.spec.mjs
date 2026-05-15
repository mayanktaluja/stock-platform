// PR T5 regression: Track Record 5-tile hero + misses-shown sticky-ON.
//
// Opening the Track Record tab must render the 5-tile band (Hit Rate ·
// Avg α · % Beat Nifty · Brier · Misses toggle). Toggling Misses must
// persist to localStorage and default ON across reloads. Brier shows
// the honest "backfilling" sub-line until PR B8 lands the JSON.

import { test, expect } from "@playwright/test";
import { gotoApp, switchTab } from "./helpers/app.mjs";

test.describe("Track Record hero (PR T5)", () => {
  test("5 tiles render, toggle writes localStorage on every flip", async ({ page }) => {
    await gotoApp(page);
    await switchTab(page, "track");

    const hero = page.locator("#trackHeroStrip");
    await expect(hero).toBeVisible({ timeout: 10_000 });

    // Five tiles present.
    await expect(hero.locator("#trackHitRateValue")).toBeVisible();
    await expect(hero.locator("#trackAvgAlphaValue")).toBeVisible();
    await expect(hero.locator("#trackBeatNiftyValue")).toBeVisible();
    await expect(hero.locator("#trackBrierValue")).toBeVisible();
    const toggle = hero.locator("#trackMissesShownToggle");
    await expect(toggle).toBeVisible();
    await expect(toggle).toBeChecked();

    // Brier sub-line should be the honest empty state until PR B8 lands.
    const brierSub = (await page.locator("#trackBrierSub").innerText()).trim();
    expect(brierSub.toLowerCase()).toContain("backfilling");

    // Toggle OFF → localStorage receives "off"; toggle back ON → "on".
    // The persistence test (sticky-ON across reload when localStorage is
    // unset) is covered by the separate "first-time visitor" spec; this
    // assertion is on the write side of the contract.
    await toggle.uncheck();
    await expect(toggle).not.toBeChecked();
    await expect
      .poll(async () => page.evaluate(() => localStorage.getItem("starbhai_missesShown")))
      .toBe("off");

    await toggle.check();
    await expect(toggle).toBeChecked();
    await expect
      .poll(async () => page.evaluate(() => localStorage.getItem("starbhai_missesShown")))
      .toBe("on");
  });

  test("first-time visitor: missing localStorage → default ON", async ({ page }) => {
    await gotoApp(page);
    // Helper clears localStorage on every navigation, so this run starts clean.
    await switchTab(page, "track");
    await expect(page.locator("#trackMissesShownToggle")).toBeChecked();
    const stored = await page.evaluate(() => localStorage.getItem("starbhai_missesShown"));
    expect(stored).toBeNull();
  });
});
