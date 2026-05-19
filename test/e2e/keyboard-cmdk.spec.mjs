// PR #8: Cmd/Ctrl-K focuses the header search box.

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

test.describe("PR #8 Cmd/Ctrl-K shortcut", () => {
  test("Meta+K focuses #searchInput", async ({ page }) => {
    await gotoApp(page);
    // Click body to ensure focus isn't already in the input
    await page.locator("body").click({ position: { x: 500, y: 400 } });
    const beforeFocus = await page.evaluate(() =>
      document.activeElement?.id || document.activeElement?.tagName,
    );
    expect(beforeFocus).not.toBe("searchInput");

    // Press Meta+K (Cmd on macOS Chromium). Use both meta and control
    // since Playwright runs Chromium where Meta is the canonical mac key.
    await page.keyboard.press("Meta+K");
    const after = await page.evaluate(() => document.activeElement?.id);
    expect(after).toBe("searchInput");
  });

  test("Ctrl+K also focuses (Windows/Linux equivalent)", async ({ page }) => {
    await gotoApp(page);
    await page.locator("body").click({ position: { x: 500, y: 400 } });
    await page.keyboard.press("Control+K");
    const after = await page.evaluate(() => document.activeElement?.id);
    expect(after).toBe("searchInput");
  });
});
