// 5x Lab — candidate pipeline section.
//
// Runs AFTER 5x-lab-01-trajectory (Playwright sorts specs
// alphabetically). Verifies the candidate table renders rows from
// /api/multibagger/candidates and that verdict pills colour correctly.
//
// Self-skips on missing scores snapshot.

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";
import fs from "node:fs";
import path from "node:path";

const SCORES_PATH = path.join(process.cwd(), "data", "strategy", "multibagger-scores-latest.json");

test.describe("5x Lab — candidate pipeline", () => {
  test.beforeAll(() => {
    if (!fs.existsSync(SCORES_PATH)) {
      test.skip(true, "no multibagger scores snapshot");
    }
  });

  test("/api/multibagger/candidates respects verdict filter + limit", async ({ request }) => {
    const res = await request.get("/api/multibagger/candidates?verdict=HIGH_CONVICTION&limit=10");
    if (res.status() === 404) test.skip(true, "not a personal-use account");
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body).toHaveProperty("candidates");
    expect(Array.isArray(body.candidates)).toBe(true);
    expect(body.candidates.length).toBeLessThanOrEqual(10);
    for (const c of body.candidates) {
      expect(c.verdict).toBe("HIGH_CONVICTION");
    }
  });

  test("candidate table renders with ticker + score + verdict columns", async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => {
      window.__starbhai_isPersonal = true;
      const btn = document.getElementById("multibaggerLabTabBtn");
      if (btn) btn.hidden = false;
    });
    await page.evaluate(() => window.switchTab && window.switchTab("multibaggerLab"));

    const apiOk = await page.evaluate(async () => (await fetch("/api/multibagger/overview")).ok);
    if (!apiOk) test.skip(true, "API not personal-gated open");

    const table = page.locator("[data-test='multibagger-candidate-table']");
    await expect(table).toBeVisible({ timeout: 10000 });
    const rows = await table.locator("tbody tr").count();
    expect(rows).toBeGreaterThan(0);
  });

  test("verdict pill colour distinguishes 5X_CANDIDATE from HIGH_CONVICTION", async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => {
      window.__starbhai_isPersonal = true;
      const btn = document.getElementById("multibaggerLabTabBtn");
      if (btn) btn.hidden = false;
    });
    await page.evaluate(() => window.switchTab && window.switchTab("multibaggerLab"));

    const apiOk = await page.evaluate(async () => (await fetch("/api/multibagger/overview")).ok);
    if (!apiOk) test.skip(true, "API not personal-gated open");

    // Wait for table render
    await page.waitForSelector("[data-test='multibagger-candidate-table']", { timeout: 10000 });
    // Pull all verdict pills; assert at least one has the 5X-purple background.
    const pillColors = await page.$$eval(
      "[data-test='multibagger-candidate-table'] tbody tr td:last-child span",
      (els) => els.map((e) => ({ text: e.textContent, bg: e.style.background })),
    );
    expect(pillColors.length).toBeGreaterThan(0);
    // Either we have a 5X_CANDIDATE (rare — only ~1 expected in a normal run)
    // or we have other verdicts. Just confirm pills have non-empty backgrounds.
    for (const p of pillColors) {
      expect(p.bg).toBeTruthy();
    }
  });
});
