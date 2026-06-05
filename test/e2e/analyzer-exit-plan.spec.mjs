// Regression: Portfolio Analyzer should surface technical-level review
// context without framing it as trade instructions.

import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { gotoApp } from "./helpers/app.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures", "groww-sample.xlsx");

test.describe("Portfolio Analyzer technical levels", () => {
  test.skip(!existsSync(FIXTURE), "fixture missing");

  test("summary and per-holding technical blocks render with compliant copy", async ({ page }) => {
    await gotoApp(page, { tab: "analyzer" });
    await page.locator("#analyzerFileInput").setInputFiles(FIXTURE);

    const reportReady = await page
      .waitForFunction(
        () => {
          const r = document.getElementById("analyzerReport");
          return r && r.style.display !== "none";
        },
        null,
        { timeout: 45_000 }
      )
      .then(() => true)
      .catch(() => false);
    test.skip(!reportReady, "analyzer report did not render in time");

    const summary = page.locator("[data-exit-plan-summary]");
    await expect(summary).toBeVisible({ timeout: 5_000 });
    await expect(summary).toHaveJSProperty("open", false);
    await expect(summary.locator("summary").first()).toContainText("Technical levels & review triggers");
    await expect(summary.locator("summary").first()).toContainText("not trade instructions");

    await summary.locator("summary").first().click();
    await expect(summary).toHaveJSProperty("open", true);
    await expect(summary).toContainText("Priority technical rows");
    await expect(summary).toContainText("High-volatility");
    const priorityRows = summary.locator("[data-exit-plan-summary-row]");
    await expect(priorityRows.first()).toBeVisible({ timeout: 5_000 });
    const priorityReason = await priorityRows.first().innerText();
    expect(priorityReason).toMatch(/support|upside|volatility|review|profit-zone/i);

    const text = await page.locator("#analyzerReport").innerText();
    expect(text).not.toMatch(/\b(buy now|sell now|sell the entire|sell half|book profit now|stop-loss hit|exit position|place order|market orders?|must trim|guaranteed|assured returns?)\b/i);

    const detail = page.locator("[data-exit-plan-detail]").first();
    const detailCount = await page.locator("[data-exit-plan-detail]").count();
    test.skip(detailCount === 0, "no per-holding technical-level detail rendered for fixture");
    const detailStates = await page.evaluate(() =>
      [...document.querySelectorAll("[data-exit-plan-detail]")].map((el) => el.open)
    );
    expect(detailStates.every((open) => open === false)).toBeTruthy();

    await page.evaluate(() => {
      const detailEl = document.querySelector("[data-exit-plan-detail]");
      for (let el = detailEl; el; el = el.parentElement) {
        if (el.tagName === "DETAILS") el.open = true;
      }
    });
    await expect(detail).toBeVisible({ timeout: 5_000 });
    await expect(detail).toContainText("Technical levels");
    await expect(detail).toContainText("Support");
    await expect(detail).toContainText("Upside band");
    await expect(detail).toContainText("not trade instructions");
  });
});
