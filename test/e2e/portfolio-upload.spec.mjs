// E2E test 0.2 — XLSX upload on Portfolio Analyzer.
//
// Regression target: the analyzer must accept a Groww-shaped XLSX, parse it,
// and reach a "report visible" state without crashing the page. We do NOT
// assert on the analysis content (depends on live Yahoo + SWS); only that
// the upload pipeline didn't reject the file.

import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { gotoApp } from "./helpers/app.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures", "groww-sample.xlsx");

test.describe("Portfolio Analyzer XLSX upload", () => {
  test.skip(!existsSync(FIXTURE), "fixture missing — run node test/e2e/helpers/build-fixture-xlsx.mjs");

  test("upload Groww-shaped XLSX → analyzer accepts file (no error banner)", async ({ page }) => {
    await gotoApp(page, { tab: "analyzer" });

    const input = page.locator("#analyzerFileInput");
    await input.setInputFiles(FIXTURE);

    // Either analyzing-spinner appears, or the report renders, or the upload
    // error block shows. The regression-bearing requirement is that the file
    // is NOT rejected with the upload-error visible.
    await page.waitForFunction(
      () => {
        const analyzing = document.getElementById("analyzerAnalyzing");
        const report = document.getElementById("analyzerReport");
        const error = document.getElementById("analyzerUploadError");
        const analyzingVisible = analyzing && analyzing.style.display !== "none";
        const reportVisible = report && report.style.display !== "none";
        const errorVisible = error && error.style.display !== "none";
        return analyzingVisible || reportVisible || errorVisible;
      },
      null,
      { timeout: 15_000 }
    );

    const errorVisible = await page.evaluate(() => {
      const el = document.getElementById("analyzerUploadError");
      return !!(el && el.style.display !== "none" && el.textContent.trim().length > 0);
    });
    expect(errorVisible, "upload must not surface a parsing error").toBe(false);
  });
});
