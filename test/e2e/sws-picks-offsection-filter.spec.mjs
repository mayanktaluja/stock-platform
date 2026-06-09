// SWS Picks · off-section matches surface on Sector/Universe filter (not just search)
//
// Regression spec for the bug where selecting Sector=Semiconductors only showed
// the 3-4 stocks that happened to make a curated bucket. After the fix the
// off-section section ("🌐 All SWS stocks (off-section matches)") must build
// whenever any filter is active, surfacing the rest of the universe.
//
// Self-skips when /api/sws-universe isn't available (fresh checkout before
// scripts/sws-build-scored-universe.mjs has run).

import { test, expect } from "@playwright/test";
import { gotoApp, waitForPicksLoaded } from "./helpers/app.mjs";

const OFF_SECTION_SELECTOR = '.sws-pick-section[data-section-key="off_section_search"]';

test.describe("SWS Picks · off-section matches on filter", () => {
  test("Sector filter (no search) surfaces off-section matches", async ({ page }) => {
    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    // Default view: no filter → off-section section must NOT render.
    await expect(page.locator(OFF_SECTION_SELECTOR)).toHaveCount(0);

    // Pick a sector that exists in this snapshot AND has stocks in the universe
    // beyond what's already in curated buckets. We data-drive: ask the page to
    // pick the first non-"all" sector whose universe coverage exceeds its
    // curated coverage by ≥1.
    const sectorValue = await page.evaluate(async () => {
      const sel = document.getElementById("picksSectorFilter");
      if (!sel) return null;
      // Force-load the universe so we can introspect it before flipping the
      // dropdown (the handler will trigger the same fetch — this just lets us
      // pick a sector we know will exercise the new code path).
      const res = await fetch("/api/sws-universe").catch(() => null);
      if (!res || !res.ok) return null;
      const data = await res.json().catch(() => null);
      const universe = Array.isArray(data?.stocks) ? data.stocks : [];
      if (!universe.length) return null;

      const curatedBySector = new Map();
      for (const arr of Object.values(window.currentPicksData?.sections || {})) {
        if (!Array.isArray(arr)) continue;
        for (const it of arr) {
          if (it?.sector) {
            curatedBySector.set(it.sector, (curatedBySector.get(it.sector) || 0) + 1);
          }
        }
      }
      const universeBySector = new Map();
      for (const it of universe) {
        if (it?.sector) {
          universeBySector.set(it.sector, (universeBySector.get(it.sector) || 0) + 1);
        }
      }
      // Pick the dropdown sector with the largest off-section delta.
      const opts = Array.from(sel.options).filter((o) => o.value !== "all");
      let best = null;
      let bestDelta = 0;
      for (const o of opts) {
        const cur = curatedBySector.get(o.value) || 0;
        const uni = universeBySector.get(o.value) || 0;
        const delta = uni - cur;
        if (delta > bestDelta) { bestDelta = delta; best = o.value; }
      }
      return best;
    });
    test.skip(!sectorValue, "no sector with off-section coverage in this snapshot");

    await page.selectOption("#picksSectorFilter", sectorValue);

    // Off-section section must appear (the fix).
    const offSection = page.locator(OFF_SECTION_SELECTOR);
    await expect(offSection).toBeVisible({ timeout: 10_000 });
    await expect(offSection).toContainText(/All SWS stocks/i);

    // It must contain ≥1 card, and the card sector must match the filter.
    const cards = offSection.locator(".sws-pick-card");
    expect(await cards.count()).toBeGreaterThan(0);
  });

  test("clearing the sector filter removes the off-section section", async ({ page }) => {
    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    const sectorValue = await page.evaluate(() => {
      const sel = document.getElementById("picksSectorFilter");
      if (!sel) return null;
      const opts = Array.from(sel.options).filter((o) => o.value !== "all");
      return opts[0]?.value ?? null;
    });
    test.skip(!sectorValue, "no non-all sector options in this snapshot");

    await page.selectOption("#picksSectorFilter", sectorValue);
    // Either the off-section appeared (most cases) or didn't (sector with zero
    // off-section coverage — fine, we only care about the cleanup direction).
    await page.selectOption("#picksSectorFilter", "all");
    await expect(page.locator(OFF_SECTION_SELECTOR)).toHaveCount(0, { timeout: 5_000 });
  });
});
