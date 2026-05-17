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

  // Regression: a bar segment showing "TOP-UP 22" must open a modal that
  // lists all 22 top-up stocks, not just the rows in one sub-tier. The bug
  // was that openActionListModalForBucket mapped each bucket to a single
  // representative sub-tier action ("Topup" → "Top-up-33%") and the modal
  // exact-key-lookup `holdingsByAction["Top-up-33%"]` returned only that
  // sub-tier's rows. Now the modal aggregates every sub-tier matching the
  // bucket, so the row count matches the segment count.
  test("bar segment row count matches the modal row count", async ({ page }) => {
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

    const segments = page.locator(
      "button.analyzer-actionmix-segment[onclick*=\"openActionListModalForBucket\"]"
    );
    const segCount = await segments.count();
    test.skip(segCount === 0, "no action-mix bar segments rendered");

    // Walk every bar segment, click it, and assert the modal contains the
    // promised number of rows. Closing the modal between iterations keeps
    // the backdrop state clean.
    let exercised = 0;
    for (let i = 0; i < segCount; i++) {
      const seg = segments.nth(i);
      const numTxt = await seg.locator(".tx-num").innerText();
      const expected = Number(numTxt.trim());
      if (!Number.isFinite(expected) || expected === 0) continue;

      await seg.click();
      const backdrop = page.locator("#actionListModalBackdrop");
      await expect(backdrop).toHaveClass(/open/, { timeout: 5_000 });

      const rowCount = await page.locator("[data-action-list-rows] tr").count();
      expect(
        rowCount,
        `bar segment #${i} showed ${expected} but modal listed ${rowCount}`
      ).toBe(expected);
      exercised++;

      // Close before the next iteration via the modal's own close fn.
      await page.evaluate(() => window.closeActionListModal && window.closeActionListModal());
      await expect(backdrop).not.toHaveClass(/open/, { timeout: 5_000 });
    }

    test.skip(exercised === 0, "no non-zero bar segments to validate");
  });
});
