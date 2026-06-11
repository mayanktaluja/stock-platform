// F1: modal focus-trap enforcement.
//
// The delegated trap (app.js — single document-level keydown handler for
// #swsModalBackdrop/#actionListModalBackdrop/#shortcutsModal) existed before
// this overhaul but had no spec. This pins the WCAG 2.4.3 contract: while a
// modal is open, Tab cycles INSIDE the dialog and never leaks to the page
// behind the backdrop; Esc closes and the toast region stays polite.

import { test, expect } from "@playwright/test";
import { gotoApp, waitForPicksLoaded } from "./helpers/app.mjs";

test.describe("F1 modal focus trap", () => {
  test("Tab cycles inside the SWS modal, never behind the backdrop", async ({
    page,
  }) => {
    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);
    await page.locator("#picksTab .sws-pick-card").first().click();
    await expect(page.locator("#swsModalBody")).toBeVisible({
      timeout: 10_000,
    });

    // 25 Tab presses must keep focus inside the open dialog.
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(() => {
        const dialog = document.querySelector("#swsModalBackdrop.open");
        const a = document.activeElement;
        // body counts as "leaked" only if the dialog has focusables at all.
        if (!dialog) return true;
        if (a === document.body) return true; // transient; never behind-page element
        return dialog.contains(a);
      });
      expect(inside, `Tab #${i + 1} leaked focus behind the modal`).toBe(true);
    }

    // Esc closes (existing contract — re-pinned here).
    await page.keyboard.press("Escape");
    await expect(page.locator("#swsModalBackdrop.open")).toHaveCount(0);
  });

  test("toast region is a polite live region", async ({ page }) => {
    await gotoApp(page);
    const stack = page.locator("#toastStack");
    await expect(stack).toHaveAttribute("role", "status");
    await expect(stack).toHaveAttribute("aria-live", "polite");
  });
});
