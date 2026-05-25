// E2E test 0.6 — Earnings Watch filter state persistence.
//
// Regression target: changing a filter on the Earnings tab must persist when
// the user navigates away and back. Admin-403 path is not exercised here
// because local dev runs with AUTH_ENABLED=false (gate bypassed). See
// test/e2e/README.md for the auth-enabled variant.

import { test, expect } from "@playwright/test";
import { gotoApp, switchTab } from "./helpers/app.mjs";

test.describe("Earnings Watch filters", () => {
  test("days-filter selection survives a tab round-trip", async ({ page }) => {
    await gotoApp(page);

    // Earnings tab is admin-only. /api/auth/me sets window.__starbhai_isAdmin
    // when AUTH_ENABLED + the session resolves to an admin record. Local
    // Playwright runs with AUTH_ENABLED=false (no OAuth env vars), so
    // auth.init() never marks the user admin and the tab stays hidden.
    // Skip the test in that case — admin-403 + filter behaviour is covered
    // by the separate "auth-enabled" run documented in test/e2e/README.md.
    await page.waitForFunction(() => window.__starbhai_isAdmin !== undefined, null, {
      timeout: 3_000,
    }).catch(() => {});
    const isAdmin = await page.evaluate(() => !!window.__starbhai_isAdmin);
    test.skip(!isAdmin, "Earnings Watch is admin-only; AUTH_ENABLED=false in this run");

    await switchTab(page, "earnings");

    const daysFilter = page.locator("#earningsDaysFilter");
    await expect(daysFilter).toBeVisible({ timeout: 10_000 });

    await daysFilter.selectOption("60");
    await expect(daysFilter).toHaveValue("60");

    await switchTab(page, "picks");
    await switchTab(page, "earnings");
    await expect(page.locator("#earningsDaysFilter")).toHaveValue("60");
  });
});
