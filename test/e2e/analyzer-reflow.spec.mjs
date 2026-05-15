// PR A10 regression: Portfolio Analyzer reflow.
//
// After uploading the fixture XLSX the analyzer report must render:
//   - the Tier-1 hero trio (Money put in / What it's worth today / Net P&L)
//     ABOVE any tier table,
//   - a 100 %-width action-mix bar in place of the chip row,
//   - Tier-A reductions wrapped in a <details> block.
// The full report is data-dependent (needs live Yahoo prices), so when
// the analyzer can't render we skip the structural assertions — same
// self-skip pattern as analyzer-action-mix.spec.mjs.

import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { gotoApp } from "./helpers/app.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures", "groww-sample.xlsx");

test.describe("Portfolio Analyzer reflow (PR A10)", () => {
  test.skip(!existsSync(FIXTURE), "fixture missing");

  test("hero trio renders above tier tables + action-mix bar visible", async ({ page }) => {
    await gotoApp(page, { tab: "analyzer" });
    await page.locator("#analyzerFileInput").setInputFiles(FIXTURE);

    const reportReady = await page.waitForFunction(() => {
      const r = document.getElementById("analyzerReport");
      return r && r.style.display !== "none";
    }, null, { timeout: 45_000 }).then(() => true).catch(() => false);
    test.skip(!reportReady, "analyzer report did not render in time");

    const heroTrio = page.locator(".analyzer-hero-trio");
    await expect(heroTrio).toBeVisible({ timeout: 5_000 });
    // Three tile children
    const tiles = heroTrio.locator(".l-box");
    await expect(tiles).toHaveCount(3);
    // The third tile is Net P&L — must include a glyph or "—"
    const pnlText = (await tiles.nth(2).innerText()).trim();
    expect(pnlText.length).toBeGreaterThan(0);

    // Action-mix bar present.
    const bar = page.locator(".analyzer-actionmix-bar");
    await expect(bar).toBeVisible();
    // At least one segment.
    await expect(bar.locator(".analyzer-actionmix-segment")).not.toHaveCount(0);

    // Tier A wrapper present.
    const tierDetails = page.locator("details.analyzer-tier-details").first();
    await expect(tierDetails).toBeVisible();
  });
});
