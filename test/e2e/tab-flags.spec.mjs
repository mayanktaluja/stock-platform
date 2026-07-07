// Calm "Experimental" tab flags.
//
// The Risk Lab / 5x Lab / Sector Outlook tabs used to carry a pulsing status
// dot + an inline-styled pill on the main rail — visually noisy on every page
// and a reduced-motion liability. PR7 replaces each with one token-based
// .tab-flag chip: no animation, same tab, same label. #458 flat-nav is intact
// (the tabs are not hidden or reordered; only the badge collapses <720px).

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

test.describe("experimental tab flags", () => {
  test("exactly three calm, non-animated flags on the labelled tabs", async ({ page }) => {
    await gotoApp(page, { tab: "picks" });

    const flags = page.locator("#mainTabs .tab-flag");
    await expect(flags).toHaveCount(3);

    // None of the flags animate (the pulse keyframe is gone).
    const anims = await flags.evaluateAll((els) =>
      els.map((e) => getComputedStyle(e).animationName),
    );
    for (const a of anims) expect(a === "none" || a === "").toBeTruthy();

    // The flags sit on the three experimental tabs, which keep their labels.
    for (const [id, label] of [
      ["riskLabTabBtn", "Risk Lab"],
      ["multibaggerLabTabBtn", "5x Lab"],
      ["sectorOutlookTabBtn", "Sector Outlook"],
    ]) {
      const btn = page.locator(`#${id}`);
      await expect(btn).toContainText(label);
      await expect(btn.locator(".tab-flag")).toHaveCount(1);
    }
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
