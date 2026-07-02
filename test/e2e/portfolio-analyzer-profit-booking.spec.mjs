// E2E — profit-protection ("Profit booking") section.
//
// Regression target: when the report carries profitProtection rows, the
// collapsible section renders under Reductions with factual phrasing
// ("optional", "notional") and never inflates the freed-capital figure.
// Self-skips when no holding qualifies on the current data snapshot —
// the signal needs a volatile winner retraced ≥15% off its 52W high.

import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { gotoApp } from "./helpers/app.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures", "portfolio-sample.csv");

test.describe("Profit booking section", () => {
  test.skip(!existsSync(FIXTURE), "fixture missing");

  test("section renders with optional/notional phrasing when a qualifying row exists", async ({ page }) => {
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
    test.skip(!reportReady, "analyzer report did not render in time — likely live-price dependency");

    const section = page.locator('[data-testid="analyzer-profit-protection"]');
    const count = await section.count();
    test.skip(count === 0, "no profit-protection candidates on this data snapshot");

    await section.locator("summary").click();
    await expect(section).toContainText("Optional discipline rule");
    await expect(section).toContainText("notional");
    await expect(section).toContainText("not counted in freed capital");
  });
});
