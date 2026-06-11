// D1: Picks tab + stock-detail modal redesign guard.
//
// The redesign is contract-safe: it changes how the surface LOOKS (tokens,
// hover, skeletons), never the DOM handles. This spec pins both halves:
//  1. the contract selectors still resolve,
//  2. the visual layer is token-driven (snowflake SVG carries var(--…)
//     styles, not hardcoded hex) and actually flips between themes.

import { test, expect } from "@playwright/test";
import { gotoApp, waitForPicksLoaded } from "./helpers/app.mjs";

test.describe("D1 picks redesign", () => {
  test("contract selectors intact + cards re-theme", async ({ page }) => {
    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    // Contract handles the e2e suite depends on.
    const card = page.locator("#picksTab .sws-pick-card").first();
    await expect(card).toBeVisible();
    await expect(
      page.locator("#picksTab .sws-pick-section[data-section-key]").first(),
    ).toBeAttached();

    // Dark (suite default) → light: the card surface must change.
    const cardBg = () =>
      card.evaluate((el) => getComputedStyle(el).backgroundColor);
    const darkBg = await cardBg();
    await page.evaluate(() => localStorage.setItem("theme", "light"));
    await page.reload();
    await waitForPicksLoaded(page);
    const lightBg = await cardBg();
    expect(lightBg).not.toBe(darkBg);
  });

  test("snowflake hexagon is token-driven in the modal", async ({ page }) => {
    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    await page.locator("#picksTab .sws-pick-card").first().click();
    const modal = page.locator("#swsModalBody");
    await expect(modal).toBeVisible({ timeout: 10_000 });

    const svg = modal.locator('svg[aria-label*="Snowflake"]').first();
    // Snowflake requires deep-brief pillar data; self-skip on fixtures without it.
    if ((await svg.count()) === 0) {
      test.skip(true, "no snowflake in fixture modal (no pillar data)");
    }

    const inner = await svg.evaluate((el) => el.innerHTML);
    // Band/label colours must reference tokens…
    expect(inner).toContain("var(--");
    // …and the legacy hardcoded band hex must be gone.
    for (const legacy of ["#34d399", "#fbbf24", "#f87171", "#0f1319"]) {
      expect(inner).not.toContain(legacy);
    }

    // The polygon stroke resolves to a real colour (var() actually applied —
    // guards the SVG-attribute-vs-style gotcha).
    const stroke = await svg
      .locator("polygon[style*='stroke']")
      .last()
      .evaluate((el) => getComputedStyle(el).stroke);
    expect(stroke).toMatch(/^rgb/);
  });

  test("compact density tightens pick-card padding", async ({ page }) => {
    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);
    const pad = () =>
      page
        .locator("#picksTab .sws-pick-card")
        .first()
        .evaluate((el) => getComputedStyle(el).paddingTop);
    expect(await pad()).toBe("14px"); // comfortable = legacy geometry
    await page.evaluate(() => localStorage.setItem("density", "compact"));
    await page.reload();
    await waitForPicksLoaded(page);
    expect(await pad()).toBe("10px");
  });
});
