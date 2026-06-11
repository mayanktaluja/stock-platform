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

// E1: ">" command mode in the global search.
test.describe("E1 command palette (> prefix)", () => {
  test("typing > lists commands; clicking one navigates", async ({ page }) => {
    await gotoApp(page);
    await page.keyboard.press("Meta+K");
    await page.keyboard.type("> go to");
    const cmds = page.locator('[data-testid="cmdk-command"]');
    await expect(cmds.first()).toBeVisible();
    expect(await cmds.count()).toBeGreaterThanOrEqual(3);

    // Pick the Track Record command specifically.
    await page.locator('[data-cmd="tab:track"]').click();
    await expect(page.locator("#trackTab")).toBeVisible();
  });

  test("Enter runs the top match — theme toggle flips data-theme", async ({ page }) => {
    await gotoApp(page);
    const before = await page.evaluate(() =>
      document.documentElement.getAttribute("data-theme"),
    );
    await page.keyboard.press("Meta+K");
    await page.keyboard.type("> theme");
    await page.keyboard.press("Enter");
    const after = await page.evaluate(() =>
      document.documentElement.getAttribute("data-theme"),
    );
    expect(after).not.toBe(before);
    // Search box cleared + results closed after running.
    await expect(page.locator("#searchInput")).toHaveValue("");
  });

  test("non-matching command query shows empty state, not stock results", async ({ page }) => {
    await gotoApp(page);
    await page.keyboard.press("Meta+K");
    await page.keyboard.type("> zzzznothing");
    await expect(page.locator("#searchResults")).toContainText(
      "No matching commands",
    );
  });
});
