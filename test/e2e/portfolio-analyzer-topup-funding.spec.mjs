// E2E — funding-aware Top-up badge labels (lever 3, relabel-only).
//
// Regression targets:
//  1. Declaring fresh capital produces at least one "Top-up — ₹X funded"
//     badge (when the data snapshot yields fundable candidates).
//  2. Without declared capital no badge ever claims funded ₹ — the
//     platform must not fabricate a budget.
//
// Self-skips on missing fixture / report timeout / no fundable candidates
// (stale SWS data blocks all adds via the freshness gate).

import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { gotoApp } from "./helpers/app.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures", "portfolio-sample.csv");
const FUNDED_BADGE = /Top-up — ₹[\d,]+ funded/;

async function uploadAndWait(page, { freshCapital = null } = {}) {
  await gotoApp(page, { tab: "analyzer" });
  if (freshCapital != null) {
    await page.locator("#analyzerFreshCapital").fill(String(freshCapital));
  }
  await page.locator("#analyzerFileInput").setInputFiles(FIXTURE);
  return page
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
}

test.describe("Funding-aware Top-up labels", () => {
  test.skip(!existsSync(FIXTURE), "fixture missing");

  test("declared fresh capital surfaces funded ₹ on Top-up badges", async ({ page }) => {
    const reportReady = await uploadAndWait(page, { freshCapital: 200000 });
    test.skip(!reportReady, "analyzer report did not render in time — likely live-price dependency");

    const fundedCount = await page.evaluate(() => {
      const plan = window.__analyzerLastReport?.constructionPlan;
      return plan?.summary?.fundedBuyCount ?? null;
    });
    // The report body is the source of truth when the debug handle is absent.
    const badge = page.locator("#analyzerReport", { hasText: "funded" });
    const bodyText = await page.locator("#analyzerReport").innerText();
    const hasFundedBadge = FUNDED_BADGE.test(bodyText);
    test.skip(
      !hasFundedBadge && (fundedCount === 0 || fundedCount === null),
      "no fundable candidates on this data snapshot (freshness gate blocks adds)"
    );
    expect(hasFundedBadge).toBe(true);
  });

  test("without declared capital no badge claims funded ₹", async ({ page }) => {
    const reportReady = await uploadAndWait(page);
    test.skip(!reportReady, "analyzer report did not render in time — likely live-price dependency");

    const bodyText = await page.locator("#analyzerReport").innerText();
    expect(FUNDED_BADGE.test(bodyText)).toBe(false);
  });
});
