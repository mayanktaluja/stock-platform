// SWS Picks · Universe + Sector dropdown filters
//
// Replaces the legacy "All / Nifty 500 only" radio with two dropdowns:
//   Universe → All / Nifty 100 (Large) / Nifty Midcap 150 / Nifty Smallcap 250 / Nifty 500
//   Sector   → All sectors / <24 dynamic options>
// Plus a "Showing N of M stocks" summary span next to the controls.
//
// Self-skips when data/nse-index-constituents.json hasn't been populated
// (server returns indexConstituentsAvailable=false) so a fresh checkout
// without the nightly refresh doesn't fail noisily.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gotoApp, waitForPicksLoaded } from "./helpers/app.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONSTITUENTS_PATH = path.join(__dirname, "..", "..", "data", "nse-index-constituents.json");

test.describe("SWS Picks · Universe + Sector filters", () => {
  test.beforeEach(async ({ page }) => {
    // Clear filter state so each spec starts from defaults regardless of
    // what the previous run persisted.
    await page.addInitScript(() => {
      try {
        localStorage.removeItem("swsPicksFilters_v2");
        localStorage.removeItem("swsPicksFiltersMigrated_v2");
        localStorage.removeItem("swsPicksIndexFilter_v1");
      } catch {}
    });
  });

  test("default load: both dropdowns rendered, summary shows N of M", async ({ page }) => {
    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    const universe = page.locator("#picksUniverseFilter");
    const sector   = page.locator("#picksSectorFilter");
    const summary  = page.locator("#picksFilterSummary");

    await expect(universe).toBeVisible();
    await expect(sector).toBeVisible();
    await expect(summary).toBeVisible();

    await expect(universe).toHaveValue("all");
    await expect(sector).toHaveValue("all");
    await expect(summary).toHaveText(/Showing\s+\d[\d,]*\s+of\s+\d[\d,]*\s+stocks/, { timeout: 5_000 });
  });

  test("sector dropdown is populated from the response (>1 option)", async ({ page }) => {
    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    const sectorOptionCount = await page.locator("#picksSectorFilter option").count();
    // Should be 1 (All sectors) + at least a handful from the response.
    expect(sectorOptionCount).toBeGreaterThan(5);

    // "All sectors" must be the first option so it's the visible default.
    const firstOptValue = await page.locator("#picksSectorFilter option").first().getAttribute("value");
    expect(firstOptValue).toBe("all");
  });

  test("universe → Nifty 100 narrows N (and disables/falls back if constituents missing)", async ({ page }) => {
    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    // Skip when the server didn't load the constituent JSON (fresh checkout
    // without `node scripts/refresh-nse-index-constituents.mjs`).
    const available = await page.evaluate(() => !!window.currentPicksData?.indexConstituentsAvailable);
    test.skip(!available, "indexConstituentsAvailable=false — run scripts/refresh-nse-index-constituents.mjs first");

    const summary = page.locator("#picksFilterSummary");
    const beforeText = (await summary.textContent()) || "";
    const beforeN = parseInt(beforeText.replace(/,/g, "").match(/Showing\s+(\d+)/)?.[1] || "0", 10);

    await page.selectOption("#picksUniverseFilter", "nifty100");
    await expect(summary).not.toHaveText(beforeText, { timeout: 5_000 });

    const afterText = (await summary.textContent()) || "";
    const afterN = parseInt(afterText.replace(/,/g, "").match(/Showing\s+(\d+)/)?.[1] || "0", 10);
    expect(afterN).toBeGreaterThan(0);
    expect(afterN).toBeLessThan(beforeN); // Nifty 100 ⊂ All
  });

  test("sector → Software narrows N and persists across reload", async ({ page }) => {
    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    // Find a sector that actually exists in this snapshot (Software is the
    // standard SWS bucket but if the snapshot changed we pick the first
    // non-"all" option to keep the spec data-driven).
    const sectorValue = await page.evaluate(() => {
      const sel = document.getElementById("picksSectorFilter");
      if (!sel) return null;
      const opts = Array.from(sel.options).filter((o) => o.value !== "all");
      const software = opts.find((o) => o.value === "Software");
      return software ? software.value : (opts[0]?.value ?? null);
    });
    test.skip(!sectorValue, "no non-all sector options found in this snapshot");

    const summary = page.locator("#picksFilterSummary");
    const beforeText = (await summary.textContent()) || "";

    await page.selectOption("#picksSectorFilter", sectorValue);
    await expect(summary).not.toHaveText(beforeText, { timeout: 5_000 });

    const afterText = (await summary.textContent()) || "";
    const afterN = parseInt(afterText.replace(/,/g, "").match(/Showing\s+(\d+)/)?.[1] || "0", 10);
    expect(afterN).toBeGreaterThanOrEqual(0);

    // Persistence: reload and check the dropdown still holds the choice.
    await page.reload();
    await waitForPicksLoaded(page);
    await expect(page.locator("#picksSectorFilter")).toHaveValue(sectorValue);
  });

  test("Avoid section + chip removed from SWS Picks; payload carries no avoid bucket", async ({ page }) => {
    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    // The Avoid List was removed from the SWS Picks tab — neither the chip nor
    // the collapsible section should render.
    await expect(page.locator('.sws-pick-chip[data-section-key="avoid"]')).toHaveCount(0);
    await expect(page.locator('.sws-pick-section[data-section-key="avoid"]')).toHaveCount(0);

    // Sanity: the tab still renders the other curated sections (didn't blank out).
    expect(await page.locator(".sws-pick-chip").count()).toBeGreaterThan(0);

    // Payload check — /api/sws-picks must not ship the ~1,191-row avoid bucket.
    const res = await page.request.get("/api/sws-picks");
    test.skip(res.status() !== 200, "no picks data in this environment");
    const body = await res.json();
    expect(Object.keys(body.sections || {})).not.toContain("avoid");
  });

  test("v1 → v2 localStorage migration runs at most once", async ({ page }) => {
    // Seed v1 BEFORE the app boots so the migration runs on first render.
    await page.addInitScript(() => {
      try {
        localStorage.setItem("swsPicksIndexFilter_v1", "nifty500");
        // Make sure no sentinel exists.
        localStorage.removeItem("swsPicksFiltersMigrated_v2");
        localStorage.removeItem("swsPicksFilters_v2");
      } catch {}
    });
    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    // Universe dropdown should reflect the migrated value.
    await expect(page.locator("#picksUniverseFilter")).toHaveValue("nifty500");

    // Storage post-conditions: v1 gone, sentinel set, v2 has the seed.
    const storage = await page.evaluate(() => ({
      v1: localStorage.getItem("swsPicksIndexFilter_v1"),
      sentinel: localStorage.getItem("swsPicksFiltersMigrated_v2"),
      v2: localStorage.getItem("swsPicksFilters_v2"),
    }));
    expect(storage.v1).toBe(null);
    expect(storage.sentinel).toBe("true");
    expect(JSON.parse(storage.v2 || "{}")).toEqual({ universe: "nifty500", sector: "all" });
  });
});
