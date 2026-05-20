// 5x Lab — info-icon tooltips on trajectory metrics + pipeline table headers.
//
// The tab is gated behind window.__starbhai_isPersonal, so we force the flag
// and unhide the button (mirrors 5x-lab-01-trajectory.spec.mjs). Verifies the
// platform tooltip system (#starbhaiTooltip + .info-icon + data-term-id):
//   1. Visible ⓘ icons on the trajectory metrics + the Score / Verdict headers.
//   2. Hovering an ⓘ surfaces the glossary tooltip with the right term.
//   3. Escape closes the tooltip.
//
// Self-skips when the multibagger scores snapshot is missing or the API is 404
// (non-personal session in CI).

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";
import fs from "node:fs";
import path from "node:path";

const HOVER_SETTLE_MS = 250;
const SCORES_PATH = path.join(process.cwd(), "data", "strategy", "multibagger-scores-latest.json");

async function loadFiveXLab(page) {
  await gotoApp(page);
  // Force the personal-use flag so the gated tab is reachable.
  await page.evaluate(() => {
    window.__starbhai_isPersonal = true;
    const btn = document.getElementById("multibaggerLabTabBtn");
    if (btn) btn.hidden = false;
  });
  await page.evaluate(() => window.switchTab && window.switchTab("multibaggerLab"));
  await expect(page.locator("#multibaggerLabContent")).toBeVisible({ timeout: 10_000 });
  const apiOk = await page.evaluate(async () => {
    const r = await fetch("/api/multibagger/overview");
    return r.ok;
  });
  if (!apiOk) test.skip(true, "multibagger API not personal-open in this env");
}

test.describe("5x Lab — tooltips", () => {
  test.beforeAll(() => {
    if (!fs.existsSync(SCORES_PATH)) {
      test.skip(true, "no multibagger scores snapshot — run scripts/refresh-5x-strategy.mjs first");
    }
  });

  test("Trajectory metrics render visible ⓘ icons", async ({ page }) => {
    await loadFiveXLab(page);
    for (const id of ["mb_current_value", "mb_target_net", "mb_gross_required"]) {
      await expect(page.locator(`#multibaggerLabContent [data-term-id="${id}"]`)).toBeVisible();
    }
  });

  test("Pipeline headers render Score + Verdict ⓘ icons", async ({ page }) => {
    await loadFiveXLab(page);
    const table = page.locator('[data-test="multibagger-candidate-table"]');
    if ((await table.count()) === 0) test.skip(true, "no candidate pipeline in current data");
    await expect(table.locator('th [data-term-id="mb_score"]')).toBeVisible();
    await expect(table.locator('th [data-term-id="mb_verdict"]')).toBeVisible();
  });

  test("Hovering the Score ⓘ shows the tooltip with the right term", async ({ page }) => {
    await loadFiveXLab(page);
    const table = page.locator('[data-test="multibagger-candidate-table"]');
    if ((await table.count()) === 0) test.skip(true, "no candidate pipeline");
    const tooltip = page.locator("#starbhaiTooltip");
    await expect(tooltip).toHaveAttribute("aria-hidden", "true");
    await table.locator('th [data-term-id="mb_score"]').hover();
    await page.waitForTimeout(HOVER_SETTLE_MS);
    await expect(tooltip).toHaveAttribute("aria-hidden", "false");
    await expect(tooltip).toContainText(/Multibagger Score/i);
  });

  test("Escape closes an open tooltip", async ({ page }) => {
    await loadFiveXLab(page);
    await page.locator('#multibaggerLabContent [data-term-id="mb_current_value"]').hover();
    await page.waitForTimeout(HOVER_SETTLE_MS);
    await expect(page.locator("#starbhaiTooltip")).toHaveAttribute("aria-hidden", "false");
    await page.keyboard.press("Escape");
    await expect(page.locator("#starbhaiTooltip")).toHaveAttribute("aria-hidden", "true");
  });
});
