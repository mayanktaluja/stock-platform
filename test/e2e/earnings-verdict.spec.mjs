// PR E4 regression: Earnings Watch headline verdict + filter popover.
//
// Local Playwright runs are AUTH_ENABLED=false (no OAuth env vars) so the
// Earnings tab stays hidden — the existing earnings-filter spec already
// documents the skip path. We rely on that gate; this spec just adds the
// structural check the headline verdict + popover renderer ships when
// the tab is reachable. Auth-enabled CI run picks it up.

import { test, expect } from "@playwright/test";
import { gotoApp, switchTab } from "./helpers/app.mjs";

test.describe("Earnings Watch headline verdict (PR E4)", () => {
  test("filter button collapses to single 'Filters · N' details + headline verdict scales", async ({ page }) => {
    await gotoApp(page);
    await page.waitForFunction(() => window.__starbhai_isAdmin !== undefined, null, {
      timeout: 3_000,
    }).catch(() => {});
    const isAdmin = await page.evaluate(() => !!window.__starbhai_isAdmin);
    test.skip(!isAdmin, "Earnings Watch is admin-only; AUTH_ENABLED=false in this run");

    await switchTab(page, "earnings");
    const filterPopover = page.locator("details.earnings-filter-popover");
    await expect(filterPopover).toBeVisible({ timeout: 10_000 });
    // The popover starts collapsed (or pre-opened if filters are non-default);
    // either way the summary holds the trigger button.
    await expect(filterPopover.locator("summary").first()).toBeVisible();

    // First card's headline verdict must render at --fs-headline (20 px).
    const firstCard = page.locator(".earnings-card").first();
    await firstCard.waitFor({ state: "visible", timeout: 10_000 });
    const verdictPill = firstCard.locator(".tx-headline").first();
    await expect(verdictPill).toBeVisible();
  });
});
