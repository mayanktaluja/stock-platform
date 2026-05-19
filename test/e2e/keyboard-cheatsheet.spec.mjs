// PR #8: '?' toggles the shortcuts cheatsheet modal.

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

test.describe("PR #8 shortcuts cheatsheet", () => {
  test("'?' opens the cheatsheet, Escape closes it", async ({ page }) => {
    await gotoApp(page);
    await page.locator("body").click({ position: { x: 500, y: 400 } });

    const cheatsheet = page.locator("#shortcutsModal");
    await expect(cheatsheet).toBeHidden();

    await page.keyboard.press("?");
    await expect(cheatsheet).toBeVisible({ timeout: 2000 });

    // Cheatsheet must list at least 5 kbd entries
    const kbds = cheatsheet.locator("kbd");
    expect(await kbds.count()).toBeGreaterThanOrEqual(5);

    // Escape closes
    await page.keyboard.press("Escape");
    await expect(cheatsheet).toBeHidden({ timeout: 2000 });
  });

  test("cheatsheet has the right ARIA dialog attributes", async ({ page }) => {
    await gotoApp(page);
    const attrs = await page.evaluate(() => {
      const el = document.getElementById("shortcutsModal");
      return {
        role: el?.getAttribute("role"),
        ariaModal: el?.getAttribute("aria-modal"),
        labelledBy: el?.getAttribute("aria-labelledby"),
      };
    });
    expect(attrs.role).toBe("dialog");
    expect(attrs.ariaModal).toBe("true");
    expect(attrs.labelledBy).toBe("shortcutsModalTitle");
  });
});
