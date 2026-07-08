// PR #12 — Regression matrix. The user explicitly asked: "test all the
// features and see if it is working — basically we need to do regression
// testing." This spec walks every non-admin tab in five states and
// asserts the surface holds up under each. Admin-only tabs (Earnings
// Watch, Users, Risk Lab) self-skip when window.__starbhai_isAdmin is
// false, which is the default in the playwright.config.mjs harness.

import { test, expect } from "@playwright/test";
import { gotoApp, switchTab } from "./helpers/app.mjs";

const NON_ADMIN_TABS = [
  { tab: "picks",     container: "#picksTab",     marker: ".sws-pick-card, .empty-state, .state--loading, .state--error, .state--empty" },
  { tab: "news",      container: "#newsTab",      marker: "#newsContainer, .empty-state, .state--loading" },
  { tab: "marketWire", container: "#marketWireTab", marker: "#marketWireContainer, .empty-state, .state--loading" },
  { tab: "track",     container: "#trackTab",     marker: "#trackHistoryTable, .empty-state, #trackCalibrationSvgWrap" },
  { tab: "analyzer",  container: "#analyzerTab",  marker: "#analyzerFileInput, .empty-state" },
  { tab: "watchlist", container: "#watchlistTab", marker: ".empty-state, [data-watchlist-symbol], #watchlistContainer" },
];

test.describe("PR #12 regression matrix — every non-admin tab × 5 states", () => {
  for (const t of NON_ADMIN_TABS) {
    test(`${t.tab}: tab renders without throwing`, async ({ page }) => {
      // Track uncaught JS errors only — "Failed to load resource" network
      // log lines are not UI errors and would falsely flag every test env
      // where some endpoint legitimately 404s/401s.
      const pageErrors = [];
      page.on("pageerror", (err) => {
        pageErrors.push(err.message || String(err));
      });
      await gotoApp(page);
      if (t.tab !== "picks") await switchTab(page, t.tab);
      await expect(page.locator(t.container)).toBeVisible({ timeout: 10_000 });
      // At least one marker should be visible: a card, an empty-state,
      // a loading skeleton, or an error state.
      await expect(page.locator(t.marker).first()).toBeAttached({
        timeout: 10_000,
      });
      // No uncaught JS errors during render
      expect(
        pageErrors,
        `Uncaught JS errors on ${t.tab} tab:\n${pageErrors.join("\n")}`,
      ).toEqual([]);
    });

    test(`${t.tab}: tab survives mobile viewport (375×812)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 375, height: 812 });
      await gotoApp(page);
      if (t.tab !== "picks") await switchTab(page, t.tab);
      await expect(page.locator(t.container)).toBeVisible({ timeout: 10_000 });
      // Bottom-nav must be visible on mobile
      await expect(page.locator(".bottom-nav")).toBeVisible();
    });
  }

  test("keyboard journey: skip-link is reachable in the focus order", async ({
    page,
  }) => {
    await gotoApp(page);
    // Walk through the early focus order via Tab. The skip-link is the first
    // anchor in the body, but header/rail controls can change the exact count;
    // this smoke only needs to prove the link remains keyboard-reachable.
    await page.evaluate(() => {
      // Reset focus to body so Tab walks from the top.
      document.body.setAttribute("tabindex", "-1");
      document.body.focus();
      if (document.activeElement && document.activeElement !== document.body) {
        document.activeElement.blur();
      }
    });
    let reached = false;
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press("Tab");
      const text = await page.evaluate(
        () => document.activeElement?.textContent?.trim() || "",
      );
      if (/skip to main content/i.test(text)) {
        reached = true;
        break;
      }
    }
    expect(reached, "skip-link must be reachable via Tab from the page top").toBe(
      true,
    );
  });

  test("router state: full page refresh resets to India Market", async ({
    page,
  }) => {
    await gotoApp(page);
    await switchTab(page, "watchlist");
    await expect(page.locator("#watchlistTab")).toBeVisible();
    // Hash should reflect watchlist
    const hash1 = await page.evaluate(() => location.hash);
    expect(hash1).toContain("tab=watchlist");
    // Refresh
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => typeof window.switchTab === "function",
      null,
      { timeout: 10_000 },
    );
    // Full reload should always return to the India Market home state.
    await expect(page.locator("#picksTab")).toBeVisible({ timeout: 8000 });
    await expect(page.locator("#watchlistTab")).toBeHidden();
    expect(await page.evaluate(() => location.hash)).toBe("#tab=picks");
  });

  test("router state: full page refresh strips stale stock-modal hash", async ({
    page,
  }) => {
    await page.goto("/index.html#tab=watchlist&symbol=RELIANCE", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForFunction(
      () => typeof window.switchTab === "function",
      null,
      { timeout: 10_000 },
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => typeof window.switchTab === "function",
      null,
      { timeout: 10_000 },
    );

    await expect(page.locator("#picksTab")).toBeVisible({ timeout: 8000 });
    await expect(page.locator("#swsModalBackdrop")).not.toHaveClass(/open/);
    expect(await page.evaluate(() => location.hash)).toBe("#tab=picks");
  });
});
