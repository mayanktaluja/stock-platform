// Regression: info-icon glyphs must stay small (~14px) on mobile.
//
// A WCAG touch-target rule once set `.info-icon { min-width:44px;
// min-height:44px }` inside @media (max-width:720px). Because the base
// rule paints `.info-icon` as a 14px circle (border-radius:50% + yellow
// fill), that min-size inflated every info glyph into a giant yellow disc
// on phones (the user-reported bug). The fix removed the override so info
// icons render at their base 14px on all viewports. This spec locks it in:
// a future edit that re-adds a 44px min-size to `.info-icon` fails here.
//
// These are inline cursor:help tooltips — exempt under the WCAG 2.5.8
// inline-target rule — so a small tap target is acceptable.

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

const MAX_PX = 22; // correct is 14–16px; the bug rendered 44px.
const LIMIT = 30; // measure a sample — the rule is global, so this catches it.

test.describe("info-icon stays desktop-sized on mobile", () => {
  test(".info-icon glyphs are ≤22px at a 375×812 viewport", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await gotoApp(page);

    // Best-effort: wait for picks (and their info icons) to render. In an
    // env without seeded picks the tab shows an empty state with no info
    // icons — the count check below self-skips that case.
    await page
      .locator(".info-icon")
      .first()
      .waitFor({ state: "attached", timeout: 15_000 })
      .catch(() => {});

    const icons = page.locator(".info-icon");
    const count = await icons.count();
    test.skip(count === 0, "No .info-icon rendered (picks/glossary not seeded)");

    let measured = 0;
    for (let i = 0; i < count && measured < LIMIT; i++) {
      const box = await icons.nth(i).boundingBox();
      if (!box) continue; // collapsed <details> / display:none — not visible
      measured++;
      expect(
        box.width,
        `info-icon #${i} width = ${box.width}px (must be ≤${MAX_PX}, not the 44px bug)`,
      ).toBeLessThanOrEqual(MAX_PX);
      expect(
        box.height,
        `info-icon #${i} height = ${box.height}px (must be ≤${MAX_PX}, not the 44px bug)`,
      ).toBeLessThanOrEqual(MAX_PX);
    }
    test.skip(measured === 0, "No visible .info-icon to measure");
  });
});
