// US Picks · universe dropdown (S&P 500 / NASDAQ-100 / Russell 2000 / Dow 30).
// Mirrors sws-picks-filters.spec.mjs for the India tab. Self-skips without the
// US picks fixture; the dropdown options' enable/disable is driven by
// data.universeFilters.available (server-stamped from us-index-constituents.json).

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gotoApp } from "./helpers/app.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PICKS_PATH = path.join(__dirname, "..", "..", "data", "sws-us", "picks-latest.json");
const HAS_FIXTURE = fs.existsSync(PICKS_PATH);

async function openUSPicks(page) {
  await gotoApp(page);
  await page.evaluate(() => { window.__starbhai_isAdmin = true; });
  await page.evaluate(() => window.switchTab("usPicks"));
  await expect(page.locator("#usPicksTab")).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(
    () => document.querySelectorAll("#usPicksContainer .sws-pick-card").length > 0,
    null,
    { timeout: 15_000 },
  );
}

test.describe("US Picks · universe dropdown", () => {
  test.skip(!HAS_FIXTURE, "no data/sws-us/picks-latest.json fixture present");

  test("renders the universe filter with the four US index options", async ({ page }) => {
    await openUSPicks(page);
    const sel = page.locator("#usPicksUniverseFilter");
    await expect(sel).toBeVisible();
    const txt = await sel.innerText();
    expect(txt).toMatch(/All scored/);
    expect(txt).toMatch(/S&P 500/);
    expect(txt).toMatch(/NASDAQ-100/);
    expect(txt).toMatch(/Russell 2000/);
    expect(txt).toMatch(/Dow Jones 30/);
  });

  test("each index option is enabled iff the server reports its constituents loaded", async ({ page }) => {
    await openUSPicks(page);
    const state = await page.evaluate(() => {
      const avail = (currentUSPicksData && currentUSPicksData.universeFilters && currentUSPicksData.universeFilters.available) || [];
      const sel = document.getElementById("usPicksUniverseFilter");
      const opts = [...sel.options].filter((o) => o.value !== "all").map((o) => ({ value: o.value, disabled: o.disabled }));
      return { avail, opts };
    });
    expect(state.opts.length).toBeGreaterThan(0);
    // The hydrate contract: a non-"all" option is disabled exactly when its index
    // list isn't loaded (graceful degradation). Robust to whatever data is present.
    for (const o of state.opts) {
      expect(o.disabled, `option ${o.value} disabled should equal !available`).toBe(!state.avail.includes(o.value));
    }
  });

  test("selecting S&P 500 narrows to index members, then restores", async ({ page }) => {
    await openUSPicks(page);
    const before = await page.locator("#usPicksContainer .sws-pick-card").count();
    // How many curated picks the server flagged as S&P 500 members.
    const sp500Picks = await page.evaluate(() => {
      const d = currentUSPicksData;
      if (!d || !d.sections) return 0;
      const seen = new Set();
      for (const items of Object.values(d.sections)) {
        if (Array.isArray(items)) for (const it of items) if (it && it.sp500) seen.add(it.ticker);
      }
      return seen.size;
    });
    await page.selectOption("#usPicksUniverseFilter", "sp500");
    await page.waitForTimeout(300);
    const after = await page.locator("#usPicksContainer .sws-pick-card").count();
    expect(after).toBeLessThanOrEqual(before);
    if (sp500Picks > 0) expect(after).toBeGreaterThan(0);
    // Correctness: every visible card after the filter is an S&P 500 member.
    const allMembers = await page.evaluate(() => {
      const d = currentUSPicksData;
      const sp = new Set();
      for (const items of Object.values(d.sections)) {
        if (Array.isArray(items)) for (const it of items) if (it && it.sp500) sp.add(it.ticker);
      }
      const tickers = [...document.querySelectorAll("#usPicksContainer .sws-pick-card")].map((c) => c.getAttribute("data-ticker"));
      return tickers.every((t) => sp.has(t));
    });
    expect(allMembers).toBe(true);
    await page.selectOption("#usPicksUniverseFilter", "all");
    await page.waitForTimeout(300);
    expect(await page.locator("#usPicksContainer .sws-pick-card").count()).toBe(before);
  });
});
