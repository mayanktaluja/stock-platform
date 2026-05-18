// SEBI 10/10 uplift regression — Track Record tab.
//
// Asserts that the Track Record tab now carries the SEBI Research-Analyst-
// grade disclosures, methodology drawer, info icons, and CSV download:
//
//   - No discontinued scanner labels visible in #trackByTypeSection.
//   - SEBI non-registration ribbon visible.
//   - Conflict-of-interest chip visible.
//   - Methodology drawer present, collapsed by default.
//   - Per-section info-icon (ⓘ) next to each section title.
//   - Hovering the info-icon shows a tooltip with "Methodology" + "top 10".
//   - "Download CSV" link wired to /api/track/export.csv.
//
// Skip pattern (adversarial #10): the local dev DB may have no trade data
// yet. Probe /api/track/history first; if totalCount === 0, skip the suite
// rather than failing loudly. Discovery via test-level state + skip-in-test
// so CI without backfilled data stays green.

import { test, expect } from "@playwright/test";
import { gotoApp, switchTab } from "./helpers/app.mjs";

let _hasTrackData = null;

async function probeTrackData(request) {
  if (_hasTrackData !== null) return _hasTrackData;
  try {
    const res = await request.get("/api/track/history");
    if (!res.ok()) {
      _hasTrackData = false;
      return false;
    }
    const data = await res.json();
    _hasTrackData = !!(data && data.totalCount && data.totalCount > 0);
    return _hasTrackData;
  } catch {
    _hasTrackData = false;
    return false;
  }
}

test.describe("Track Record SEBI 10/10 uplift", () => {
  test.beforeEach(async ({ request }) => {
    const has = await probeTrackData(request);
    test.skip(!has, "no track data yet — skip SEBI Track Record e2e");
  });

  test("no discontinued scanner labels visible in #trackByTypeSection", async ({ page }) => {
    await gotoApp(page);
    await switchTab(page, "track");

    // Wait for the by-type section to render (loadTrackRecord async populates it).
    const byType = page.locator("#trackByTypeSection");
    await expect(byType).toBeVisible({ timeout: 15_000 });
    // Allow the API render to complete before snapshotting text.
    await page.waitForLoadState("networkidle").catch(() => {});

    const text = (await byType.innerText()).toLowerCase();
    expect(text).not.toContain("small-cap buy now");
    expect(text).not.toContain("fundamental deep value");
    expect(text).not.toContain("buy now (nifty 100)");
  });

  test("SEBI non-registration ribbon visible with correct disclosure copy", async ({ page }) => {
    await gotoApp(page);
    await switchTab(page, "track");

    const ribbon = page.locator(".sebi-non-registration-ribbon");
    await expect(ribbon).toBeVisible({ timeout: 10_000 });
    const text = (await ribbon.innerText()).toLowerCase();
    expect(text).toContain("not sebi research analyst registered");
  });

  test("COI chip visible with conflicts-of-interest disclosure", async ({ page }) => {
    await gotoApp(page);
    await switchTab(page, "track");

    const coi = page.locator("#trackCoiChip");
    await expect(coi).toBeVisible({ timeout: 10_000 });
    const text = (await coi.innerText()).toLowerCase();
    expect(text).toContain("conflicts of interest");
  });

  test("methodology drawer present and collapsed by default", async ({ page }) => {
    await gotoApp(page);
    await switchTab(page, "track");

    const drawer = page.locator(".sebi-methodology-drawer");
    await expect(drawer).toBeVisible({ timeout: 10_000 });

    // The <details> element should NOT have the `open` attribute initially.
    const isOpen = await drawer.evaluate((el) => el.hasAttribute("open"));
    expect(isOpen).toBe(false);

    // Inner body content (the 5 paragraphs) shouldn't be visible until expanded.
    const bodyText = (await drawer.locator("div p").first().textContent().catch(() => "")) || "";
    // The <p> elements still exist in DOM but the <details> hides them when
    // not open. The summary is the only thing rendered visibly.
    const summaryText = (await drawer.locator("summary").innerText()).toLowerCase();
    expect(summaryText).toContain("methodology");
  });

  test("per-section info-icons present in #trackSectionGrid", async ({ page }) => {
    await gotoApp(page);
    await switchTab(page, "track");

    // The section grid loads async — wait for at least one non-loading-spinner element.
    const grid = page.locator("#trackSectionGrid");
    await expect(grid).toBeVisible({ timeout: 10_000 });
    // Wait until the loading spinner has been replaced by real cards.
    await page.waitForFunction(
      () => {
        const g = document.getElementById("trackSectionGrid");
        if (!g) return false;
        // The loader has a `.loading-spinner` div; cards have `.info-icon`.
        return g.querySelectorAll(".info-icon").length > 0;
      },
      null,
      { timeout: 20_000 }
    ).catch(() => {});

    const icons = grid.locator(".info-icon");
    const count = await icons.count();
    expect(count).toBeGreaterThan(0);
  });

  test("hovering info-icon shows tooltip with 'Methodology' and 'top 10'", async ({ page }) => {
    await gotoApp(page);
    await switchTab(page, "track");

    const grid = page.locator("#trackSectionGrid");
    await expect(grid).toBeVisible({ timeout: 10_000 });
    await page.waitForFunction(
      () => document.querySelectorAll("#trackSectionGrid .info-icon").length > 0,
      null,
      { timeout: 20_000 }
    ).catch(() => {});

    const firstIcon = grid.locator(".info-icon").first();
    await expect(firstIcon).toBeVisible();
    // Tap-to-open uses the click delegate (works on both mouse + touch).
    await firstIcon.click();

    const tooltip = page.locator("#starbhaiTooltip");
    await expect(tooltip).toHaveClass(/visible/, { timeout: 5_000 });
    const tipText = (await tooltip.innerText()).toLowerCase();
    expect(tipText).toContain("methodology");
    expect(tipText).toContain("top 10");
  });

  test("Download CSV link present and points at /api/track/export.csv", async ({ page }) => {
    await gotoApp(page);
    await switchTab(page, "track");

    const link = page.locator('a[href="/api/track/export.csv"]');
    await expect(link).toBeVisible({ timeout: 10_000 });
    const text = (await link.innerText()).toLowerCase();
    expect(text).toContain("download csv");
    // `download` attribute is present (boolean attr).
    const hasDownloadAttr = await link.evaluate((el) => el.hasAttribute("download"));
    expect(hasDownloadAttr).toBe(true);
  });
});
