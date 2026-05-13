// E2E test 0.5 — Stock detail modal opens from a pick card.
//
// Regression target: the SWS-pick card click handler (handlePickCardClick →
// openSwsModal) must (1) flip the modal backdrop to .open, (2) populate
// #swsModalTitle once the per-stock fetch resolves, and (3) dismiss cleanly
// on Escape. The pick-card path is the most-exercised of the 15 surfaces
// that open this modal.

import { test, expect } from "@playwright/test";
import { gotoApp, waitForPicksLoaded } from "./helpers/app.mjs";

test.describe("Stock detail modal (SWS)", () => {
  test("clicking a pick card opens, populates, and Escape closes", async ({ page }) => {
    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    const firstCard = page.locator(".sws-pick-card").first();
    await firstCard.click();

    const backdrop = page.locator("#swsModalBackdrop");
    await expect(backdrop).toHaveClass(/open/, { timeout: 5_000 });

    const title = page.locator("#swsModalTitle");
    await expect(title).toBeVisible({ timeout: 15_000 });
    const titleText = (await title.innerText()).trim();
    expect(titleText.length, "#swsModalTitle must render ticker text").toBeGreaterThan(0);

    await page.keyboard.press("Escape");
    await expect(backdrop).not.toHaveClass(/open/, { timeout: 5_000 });
  });
});
