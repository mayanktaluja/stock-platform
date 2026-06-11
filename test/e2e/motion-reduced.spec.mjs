// E3: motion choreography honours prefers-reduced-motion.
//
// The modal enter settle (fade + rise + scale) must run for no-preference
// users and collapse to effectively-instant under reduce — the global
// prefers-reduced-motion block zeroes animation durations.

import { test, expect } from "@playwright/test";
import { gotoApp, waitForPicksLoaded } from "./helpers/app.mjs";

async function openModalAnimation(page) {
  await gotoApp(page, { tab: "picks" });
  await waitForPicksLoaded(page);
  await page.locator("#picksTab .sws-pick-card").first().click();
  await expect(page.locator("#swsModalBody")).toBeVisible({ timeout: 10_000 });
  return page
    .locator("#swsModalBackdrop.open .sws-modal")
    .evaluate((el) => {
      const cs = getComputedStyle(el);
      return { name: cs.animationName, duration: cs.animationDuration };
    });
}

test.describe("E3 motion", () => {
  test("modal enter animates for no-preference users", async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: "no-preference" });
    const page = await ctx.newPage();
    const anim = await openModalAnimation(page);
    expect(anim.name).toBe("modal-enter");
    expect(parseFloat(anim.duration)).toBeGreaterThan(0.1);
    await ctx.close();
  });

  test("modal enter is effectively instant under reduced motion", async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await ctx.newPage();
    const anim = await openModalAnimation(page);
    // Global reduce block zeroes durations (0.001ms) — anything ≤ a frame.
    expect(parseFloat(anim.duration)).toBeLessThan(0.02);
    await ctx.close();
  });
});
