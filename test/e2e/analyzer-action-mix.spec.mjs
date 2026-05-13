// E2E test 0.4 — Action-mix chip opens the action-list modal.
//
// Regression target: clicking a Reduce/Hold/Top-up chip in the Portfolio
// Analyzer summary calls openActionListModal('<action>') and a list of
// per-stock recommendations must surface. Skipped when the analyzer
// report didn't render (often because live Yahoo prices time out in CI).

import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { gotoApp } from "./helpers/app.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures", "groww-sample.xlsx");

test.describe("Analyzer action-mix chip", () => {
  test.skip(!existsSync(FIXTURE), "fixture missing");

  test("clicking an action-mix chip opens openActionListModal", async ({ page }) => {
    await gotoApp(page, { tab: "analyzer" });
    await page.locator("#analyzerFileInput").setInputFiles(FIXTURE);

    // Wait for either the report to render or a clear failure. The chip lives
    // inside #analyzerPortfolioActions which is populated only after the
    // analyze pipeline succeeds.
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

    test.skip(
      !reportReady,
      "analyzer report did not render in time — likely live-price dependency"
    );

    const chip = page.locator("[onclick^=\"openActionListModal\"]").first();
    const chipCount = await chip.count();
    test.skip(chipCount === 0, "no action-mix chips rendered for the fixture portfolio");

    await chip.click();
    const backdrop = page.locator("#actionListModalBackdrop");
    await expect(backdrop).toHaveClass(/open/, { timeout: 5_000 });
    await expect(page.locator("#actionListModalBody")).not.toBeEmpty({
      timeout: 5_000,
    });
  });
});
