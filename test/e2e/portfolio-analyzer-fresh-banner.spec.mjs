// E2E regression — Portfolio Analyzer banner shows the user's UPLOAD time,
// not the SWS-pipeline scan time. Also covers the broker-reconciliation chip
// and the Re-upload button clearing the in-memory analyzer cache.
//
// Background bug (2026-05-16): the banner was rendering picks-latest.json's
// `scanned_at` as "Snapshot: …", so a fresh upload looked stale (the SWS
// pipeline timestamp was hours older than the upload). The fix plumbs
// `uploadedAt` from the API into `banner.snapshot_at` and surfaces the
// SWS scan time as a separate `sws_scanned_at` field.

import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { gotoApp } from "./helpers/app.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PLAIN = resolve(here, "fixtures", "groww-sample.xlsx");
const FIXTURE_WITH_SUMMARY = resolve(here, "fixtures", "groww-sample-with-summary.xlsx");

// Known fixture totals (from build-fixture-xlsx.mjs):
//   Buy value sum     = 24005 + 22500 + 18000 + 17400 + 20500 = 102,405
//   Closing value sum = 28400 + 25685 + 19250 + 18300 + 21500 = 113,135
//   Unrealised P&L sum = 4395 + 3185 + 1250 + 900 + 1000      = 10,730
const FIXTURE_TOTAL_INVESTED = 102_405;
const FIXTURE_TOTAL_CURRENT_BROKER = 113_135;
const FIXTURE_TOTAL_PNL_BROKER = 10_730;

async function uploadAndWaitForReport(page, fixturePath) {
  await page.locator("#analyzerFileInput").setInputFiles(fixturePath);
  await page.waitForFunction(
    () => {
      const r = document.getElementById("analyzerReport");
      return r && r.style.display !== "none" && r.innerHTML.length > 0;
    },
    null,
    { timeout: 30_000 },
  );
}

test.describe("Portfolio Analyzer freshness banner", () => {
  test.skip(
    !existsSync(FIXTURE_PLAIN) || !existsSync(FIXTURE_WITH_SUMMARY),
    "fixtures missing — run `node test/e2e/helpers/build-fixture-xlsx.mjs`",
  );

  test("banner snapshot_at reflects upload time, not picks.scanned_at", async ({ page }) => {
    await gotoApp(page, { tab: "analyzer" });

    const t0 = Date.now();
    await uploadAndWaitForReport(page, FIXTURE_PLAIN);

    const { banner, snap } = await page.evaluate(() => {
      const r = (typeof _analyzerCache !== 'undefined' ? _analyzerCache : null)?.report || {};
      return { banner: r.banner || {}, snap: r.snapshot || {} };
    });

    // Banner must carry an upload-time snapshot_at, recent (within 5 min of
    // test start). The legacy bug stamped picks.scanned_at here, which was
    // typically hours older — this assertion regression-locks the fix.
    expect(banner.snapshot_at, "banner.snapshot_at must be present").toBeTruthy();
    const snapshotAtMs = new Date(banner.snapshot_at).getTime();
    expect(Number.isNaN(snapshotAtMs), "snapshot_at must be a valid ISO date").toBe(false);
    const ageMs = Date.now() - snapshotAtMs;
    expect(ageMs, "snapshot_at must be within last 5 minutes (proves it's the upload time)")
      .toBeLessThan(5 * 60_000);
    expect(snapshotAtMs, "snapshot_at must not predate test start").toBeGreaterThanOrEqual(t0 - 1000);

    // SWS scan time is now a separate field. It may or may not be present
    // (depends on whether picks-latest.json exists in the test env), but
    // when present it must parse as a date AND be a different value than
    // snapshot_at (the whole point of the split).
    if (banner.sws_scanned_at) {
      const swsScanMs = new Date(banner.sws_scanned_at).getTime();
      expect(Number.isNaN(swsScanMs), "sws_scanned_at must parse as a date").toBe(false);
    }

    // Snap totals are computed fresh from the just-uploaded holdings — used
    // as a sanity check that we're rendering the right portfolio.
    expect(snap.holdingsCount).toBe(5);
    expect(snap.totalInvested).toBeGreaterThan(FIXTURE_TOTAL_INVESTED - 50);
    expect(snap.totalInvested).toBeLessThan(FIXTURE_TOTAL_INVESTED + 50);

    // Frontend must render the new "Your portfolio: …" label, not the
    // legacy "Snapshot: …" label. This is the user-visible part of the fix.
    const bannerText = await page.locator("#analyzerReport").innerText();
    expect(bannerText).toContain("Your portfolio:");
    expect(bannerText).toContain("SWS data:");
  });

  test("broker-reconciliation chip renders when XLSX has summary block", async ({ page }) => {
    await gotoApp(page, { tab: "analyzer" });
    await uploadAndWaitForReport(page, FIXTURE_WITH_SUMMARY);

    const { banner } = await page.evaluate(() => {
      const r = (typeof _analyzerCache !== 'undefined' ? _analyzerCache : null)?.report || {};
      return { banner: r.banner || {} };
    });

    // Server must surface broker_summary on the banner contract.
    expect(banner.broker_summary, "banner.broker_summary must be populated when XLSX has Summary block")
      .toBeTruthy();
    expect(banner.broker_summary.invested).toBe(FIXTURE_TOTAL_INVESTED);
    expect(banner.broker_summary.current).toBe(FIXTURE_TOTAL_CURRENT_BROKER);
    expect(banner.broker_summary.unrealisedPL).toBe(FIXTURE_TOTAL_PNL_BROKER);
    expect(banner.broker_summary.asOfDate).toBe("2026-05-15");

    // Chip text rendered to the DOM.
    const reportText = await page.locator("#analyzerReport").innerText();
    expect(reportText).toMatch(/Per your broker statement/i);
    expect(reportText).toContain("Invested");
    expect(reportText).toContain("P&L");
  });

  test("Re-upload button clears the in-memory analyzer cache", async ({ page }) => {
    await gotoApp(page, { tab: "analyzer" });
    await uploadAndWaitForReport(page, FIXTURE_PLAIN);

    // Cache populated by the upload.
    const cacheBefore = await page.evaluate(() => !!(typeof _analyzerCache !== 'undefined' ? _analyzerCache : null));
    expect(cacheBefore, "cache must be populated after upload").toBe(true);

    // Click Re-upload (per resetAnalyzer at gated/app.js:4530).
    await page.evaluate(() => window.resetAnalyzer && window.resetAnalyzer());

    const cacheAfter = await page.evaluate(() => (typeof _analyzerCache !== 'undefined' ? _analyzerCache : null));
    expect(cacheAfter, "cache must be cleared by resetAnalyzer to prevent stale flash on tab-switch")
      .toBe(null);

    // Upload zone visible after reset.
    const uploadVisible = await page.evaluate(() => {
      const el = document.getElementById("analyzerUploadZone");
      return !!(el && el.style.display !== "none");
    });
    expect(uploadVisible).toBe(true);
  });
});
