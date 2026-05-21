// 5x Lab — risk dashboard + health section.
//
// Runs LAST (numerical prefix). Verifies the health alerts area renders
// either a clean state or the alert list from
// /api/multibagger/overview → health.alerts.
//
// Self-skips on missing scores snapshot.

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";
import fs from "node:fs";
import path from "node:path";

const SCORES_PATH = path.join(process.cwd(), "data", "strategy", "multibagger-scores-latest.json");

test.describe("5x Lab — risk + health", () => {
  test.beforeAll(() => {
    if (!fs.existsSync(SCORES_PATH)) {
      test.skip(true, "no multibagger scores snapshot");
    }
  });

  test("overview includes health.alerts array (possibly empty)", async ({ request }) => {
    const res = await request.get("/api/multibagger/overview");
    if (res.status() === 404) test.skip(true, "not a personal-use account");
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.health).toBeTruthy();
    expect(Array.isArray(body.health.alerts)).toBe(true);
  });

  test("health section renders either 'clean' or alert list", async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => {
      window.__starbhai_isAdmin = true;
      const btn = document.getElementById("multibaggerLabTabBtn");
      if (btn) btn.hidden = false;
    });
    await page.evaluate(() => window.switchTab && window.switchTab("multibaggerLab"));

    const apiOk = await page.evaluate(async () => (await fetch("/api/multibagger/overview")).ok);
    if (!apiOk) test.skip(true, "API not personal-gated open");

    // Wait for content render
    await page.waitForSelector("#multibaggerLabContent section", { timeout: 10000 });

    // Either a "clean" health pill OR an alerts <ul> must be present.
    const clean = page.locator("[data-test='multibagger-health-clean']");
    const alertList = page.locator("section[data-section='health'] ul");
    const isClean = await clean.isVisible().catch(() => false);
    const hasList = await alertList.isVisible().catch(() => false);
    expect(isClean || hasList).toBeTruthy();
  });

  test("trajectory regime pill shows the macro regime label", async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => {
      window.__starbhai_isAdmin = true;
      const btn = document.getElementById("multibaggerLabTabBtn");
      if (btn) btn.hidden = false;
    });
    await page.evaluate(() => window.switchTab && window.switchTab("multibaggerLab"));

    const apiOk = await page.evaluate(async () => (await fetch("/api/multibagger/overview")).ok);
    if (!apiOk) test.skip(true, "API not personal-gated open");

    const regimePill = page.locator("[data-test='multibagger-macro-regime']");
    await expect(regimePill).toBeVisible({ timeout: 10000 });
    const text = await regimePill.textContent();
    // Must contain an UPPER_SNAKE_CASE regime or "—" placeholder
    expect(text).toMatch(/[A-Z_]+|—/);
  });
});
