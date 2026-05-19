// 5x Lab tab — trajectory section visibility + API schema.
//
// Self-skips when data/strategy/multibagger-scores-latest.json is missing
// (fresh checkout / before first nightly run).
//
// Numerical prefix in filename ensures this spec runs BEFORE the pipeline
// + risk specs which depend on the candidate cache it primes.

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";
import fs from "node:fs";
import path from "node:path";

const SCORES_PATH = path.join(process.cwd(), "data", "strategy", "multibagger-scores-latest.json");

test.describe("5x Lab — trajectory + overview", () => {
  test.beforeAll(() => {
    if (!fs.existsSync(SCORES_PATH)) {
      test.skip(true, "no multibagger scores snapshot — run scripts/refresh-5x-strategy.mjs first");
    }
  });

  test("/api/multibagger/overview returns expected schema OR 404 for non-personal users", async ({ request }) => {
    const res = await request.get("/api/multibagger/overview");
    if (res.status() === 404) {
      // Non-personal user — expected in CI where session.isPersonal is false.
      test.skip(true, "not a personal-use account (expected in CI)");
    }
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.schema_version).toBe("multibagger-overview-v1");
    expect(body).toHaveProperty("verdicts");
    expect(body.verdicts).toHaveProperty("five_x_count");
    expect(body.verdicts).toHaveProperty("high_conviction_count");
    expect(body).toHaveProperty("top_candidates");
    expect(Array.isArray(body.top_candidates)).toBe(true);
  });

  test("tab is gated behind personal-use flag (button hidden by default)", async ({ page }) => {
    await gotoApp(page);
    const btn = page.locator("#multibaggerLabTabBtn");
    // Default: hidden attribute set on the element.
    await expect(btn).toBeHidden({ timeout: 5000 });
  });

  test("trajectory section renders when forced visible", async ({ page }) => {
    if (!fs.existsSync(SCORES_PATH)) test.skip(true, "no scores snapshot");
    await gotoApp(page);

    // Force the personal-use flag so the tab is reachable.
    await page.evaluate(() => {
      window.__starbhai_isPersonal = true;
      const btn = document.getElementById("multibaggerLabTabBtn");
      if (btn) btn.hidden = false;
    });

    // Click the tab and wait for content.
    await page.evaluate(() => window.switchTab && window.switchTab("multibaggerLab"));
    const content = page.locator("#multibaggerLabContent");
    await expect(content).toBeVisible({ timeout: 10000 });

    // If the API returned non-404, the trajectory section should render with a "Current value" pill.
    const apiOk = await page.evaluate(async () => {
      const r = await fetch("/api/multibagger/overview");
      return r.ok;
    });
    if (!apiOk) test.skip(true, "API not personal-gated open in this env");

    // Trajectory pill must be present.
    const trajectoryPill = page.locator("[data-test='multibagger-current-value']");
    await expect(trajectoryPill).toBeVisible({ timeout: 10000 });
    const text = await trajectoryPill.textContent();
    expect(text).toMatch(/₹|—/);
  });

  test("honest footer with backtest-not-validated language is present", async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => {
      window.__starbhai_isPersonal = true;
      const btn = document.getElementById("multibaggerLabTabBtn");
      if (btn) btn.hidden = false;
    });
    await page.evaluate(() => window.switchTab && window.switchTab("multibaggerLab"));
    const footer = page.locator("#multibaggerLabBacktestStatus");
    await expect(footer).toBeAttached({ timeout: 5000 });
    // Surrounding language MUST contain the not-validated disclaimer.
    const tabHtml = await page.locator("#multibaggerLabTab").textContent();
    expect(tabHtml).toMatch(/not yet|9mo forward archive|not empirically/i);
    expect(tabHtml).toMatch(/Base rate.*<.*10%|Drawdowns of 40/i);
  });
});
