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

  test("/api/multibagger/overview returns expected schema", async ({ request }) => {
    const res = await request.get("/api/multibagger/overview");
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.schema_version).toBe("multibagger-overview-v1");
    expect(body).toHaveProperty("snapshot_status");
    expect(body.snapshot_status).toHaveProperty("state");
    expect(body).toHaveProperty("age_h");
    expect(body).toHaveProperty("validation_gate");
    expect(body).toHaveProperty("survivorship_warning");
    expect(body).toHaveProperty("verdicts");
    expect(body.verdicts).toHaveProperty("five_x_count");
    expect(body.verdicts).toHaveProperty("high_conviction_count");
    expect(body).toHaveProperty("top_candidates");
    expect(Array.isArray(body.top_candidates)).toBe(true);
    // Strategy explainer + per-candidate rationale must be present.
    expect(body).toHaveProperty("strategy");
    expect(Array.isArray(body.strategy.pre_mortem)).toBe(true);
    expect(body.strategy.honest_note).toMatch(/cannot guarantee 5x/i);
    if (body.top_candidates.length) {
      expect(body.top_candidates[0]).toHaveProperty("rationale");
    }
  });

  test("tab is visible by default", async ({ page }) => {
    await gotoApp(page);
    const btn = page.locator("#multibaggerLabTabBtn");
    await expect(btn).toBeVisible({ timeout: 5000 });
  });

  test("trajectory section renders from the public signed-in tab", async ({ page }) => {
    if (!fs.existsSync(SCORES_PATH)) test.skip(true, "no scores snapshot");
    await gotoApp(page);

    // Click the tab and wait for content.
    await page.evaluate(() => window.switchTab && window.switchTab("multibaggerLab"));
    const content = page.locator("#multibaggerLabContent");
    await expect(content).toBeVisible({ timeout: 10000 });

    // If the API returned non-404, the trajectory section should render with a "Current value" pill.
    const apiOk = await page.evaluate(async () => {
      const r = await fetch("/api/multibagger/overview");
      return r.ok;
    });
    if (!apiOk) test.skip(true, "multibagger API unavailable in this env");

    // Trajectory pill must be present.
    const trajectoryPill = page.locator("[data-test='multibagger-current-value']");
    await expect(trajectoryPill).toBeVisible({ timeout: 10000 });
    const text = await trajectoryPill.textContent();
    expect(text).toMatch(/₹|—/);

    const statusBanner = page.locator("[data-test='multibagger-status-banner']");
    await expect(statusBanner).toBeVisible({ timeout: 5000 });
    const bannerText = await statusBanner.textContent();
    expect(bannerText).not.toMatch(/\[object Object\]/);
    expect(bannerText).toMatch(/Snapshot (current|status)|Evidence gate/i);
  });

  test("honest footer with backtest-not-validated language is present", async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => window.switchTab && window.switchTab("multibaggerLab"));
    const footer = page.locator("#multibaggerLabBacktestStatus");
    await expect(footer).toBeAttached({ timeout: 5000 });
    // Surrounding language MUST contain the not-validated disclaimer.
    const tabHtml = await page.locator("#multibaggerLabTab").textContent();
    expect(tabHtml).toMatch(/not yet|9mo forward archive|not empirically/i);
    expect(tabHtml).toMatch(/Base rate.*<.*10%|Drawdowns of 40/i);
  });
});
