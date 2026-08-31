// Calm "Experimental" tab flags.
//
// The Risk Lab / 5x Lab / Sector Outlook tabs used to carry a pulsing status
// dot + an inline-styled pill on the main rail — visually noisy on every page
// and a reduced-motion liability. PR7 replaces each with one token-based
// .tab-flag chip: no animation, same tab, same label. #458 flat-nav is intact
// (the tabs are not hidden; only the badge collapses <720px).
//
// 2026-08-28: Sector Outlook graduated — its chip is gone and the tab moved
// ahead of the labs on the rail, so only two flagged tabs remain. The exact
// count is asserted so a chip cannot silently reappear (or spread to a
// shipped tab).

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

test.describe("experimental tab flags", () => {
  test("exactly two calm, non-animated flags on the labelled tabs", async ({ page }) => {
    await gotoApp(page, { tab: "picks" });

    const flags = page.locator("#mainTabs .tab-flag");
    await expect(flags).toHaveCount(2);

    // None of the flags animate (the pulse keyframe is gone).
    const anims = await flags.evaluateAll((els) =>
      els.map((e) => getComputedStyle(e).animationName),
    );
    for (const a of anims) expect(a === "none" || a === "").toBeTruthy();

    // The flags sit on the two experimental tabs, which keep their labels.
    for (const [id, label] of [
      ["riskLabTabBtn", "Risk Lab"],
      ["multibaggerLabTabBtn", "5x Lab"],
    ]) {
      const btn = page.locator(`#${id}`);
      await expect(btn).toContainText(label);
      await expect(btn.locator(".tab-flag")).toHaveCount(1);
    }

    // Graduated tabs carry no chip at all.
    await expect(page.locator("#sectorOutlookTabBtn .tab-flag")).toHaveCount(0);

    // …and Sector Outlook sits ahead of both labs on the rail.
    const order = await page
      .locator("#mainTabs .tab")
      .evaluateAll((els) => els.map((e) => e.id));
    expect(order.indexOf("sectorOutlookTabBtn")).toBeLessThan(
      order.indexOf("riskLabTabBtn"),
    );
    expect(order.indexOf("sectorOutlookTabBtn")).toBeLessThan(
      order.indexOf("multibaggerLabTabBtn"),
    );
  });

  test("the flag collapses below 720px but the tab stays (flat-nav intact)", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const page = await ctx.newPage();
    await gotoApp(page, { tab: "picks" });
    // Badge hidden on mobile…
    await expect(page.locator("#riskLabTabBtn .tab-flag")).toBeHidden();
    // …but the tab button itself is still present in the DOM.
    await expect(page.locator("#riskLabTabBtn")).toHaveCount(1);
    await ctx.close();
  });
});
