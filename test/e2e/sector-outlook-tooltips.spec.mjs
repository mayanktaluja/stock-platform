// Sector Outlook — info-icon tooltips on column headers + summary stat cards.
//
// Verifies the platform-canonical tooltip system (#starbhaiTooltip + .info-icon
// + data-term-id) is wired into the Sector Outlook tab:
//   1. Visible ⓘ icons on the summary stat cards and the metric column headers.
//   2. Hovering an ⓘ surfaces the glossary tooltip with the right term.
//   3. Escape closes the tooltip.
//   4. Clicking a HEADER ⓘ does NOT toggle a drill-down row — icons live in
//      <thead>, the row onclick is on <tbody> rows only.
//
// Self-skips when /api/sector-outlook/latest is unavailable (503/404) or when
// no sectors are classified (the matrix headers are absent in that state).

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

const HOVER_SETTLE_MS = 250; // tooltip show animation is 0.18s; pad for CI

async function loadSectorOutlook(page, request) {
  const res = await request.get("/api/sector-outlook/latest");
  if (res.status() === 503 || res.status() === 404) {
    test.skip(true, "sector-outlook outlook-latest.json not generated");
  }
  expect(res.ok()).toBe(true);
  const body = await res.json();
  await gotoApp(page, { tab: "sectorOutlook" });
  await expect(page.locator("h2:has-text('Sector Outlook')")).toBeVisible({ timeout: 15_000 });
  return body;
}

test.describe("Sector Outlook — tooltips", () => {
  test("Summary stat cards render visible ⓘ icons", async ({ page, request }) => {
    await loadSectorOutlook(page, request);
    for (const id of ["sector_tailwind", "sector_headwind", "sector_neutral"]) {
      await expect(page.locator(`#sectorOutlookTab [data-term-id="${id}"]`)).toBeVisible();
    }
  });

  test("Metric column headers render visible ⓘ icons", async ({ page, request }) => {
    const body = await loadSectorOutlook(page, request);
    if (!body.sectors || body.sectors.length === 0) test.skip(true, "no sectors classified — matrix headers absent");
    for (const id of ["sector_trust_score", "sector_composite", "sector_bottom_up", "sector_breadth", "sector_news_90d"]) {
      await expect(page.locator(`#sectorOutlookTab th [data-term-id="${id}"]`)).toBeVisible();
    }
  });

  test("Hovering the Trust ⓘ shows the tooltip with the right term", async ({ page, request }) => {
    const body = await loadSectorOutlook(page, request);
    if (!body.sectors || body.sectors.length === 0) test.skip(true, "no sectors classified");
    const tooltip = page.locator("#starbhaiTooltip");
    await expect(tooltip).toHaveAttribute("aria-hidden", "true");
    await page.locator('#sectorOutlookTab th [data-term-id="sector_trust_score"]').hover();
    await page.waitForTimeout(HOVER_SETTLE_MS);
    await expect(tooltip).toHaveAttribute("aria-hidden", "false");
    await expect(tooltip).toContainText(/Sector Trust Score/i);
  });

  test("Escape closes an open tooltip", async ({ page, request }) => {
    await loadSectorOutlook(page, request);
    await page.locator('#sectorOutlookTab [data-term-id="sector_tailwind"]').hover();
    await page.waitForTimeout(HOVER_SETTLE_MS);
    await expect(page.locator("#starbhaiTooltip")).toHaveAttribute("aria-hidden", "false");
    await page.keyboard.press("Escape");
    await expect(page.locator("#starbhaiTooltip")).toHaveAttribute("aria-hidden", "true");
  });

  test("Clicking a header ⓘ does NOT expand a drill-down row", async ({ page, request }) => {
    const body = await loadSectorOutlook(page, request);
    if (!body.sectors || body.sectors.length === 0) test.skip(true, "no sectors classified");
    const firstSector = body.sectors[0].sector;
    const drillRow = page.locator(`tr[data-drilldown-for="${firstSector}"]`);
    await expect(drillRow).toBeHidden();
    // The header icon sits in <thead> (no row onclick) — clicking it should
    // open the tooltip, never the drill-down.
    await page.locator('#sectorOutlookTab th [data-term-id="sector_trust_score"]').click();
    await page.waitForTimeout(HOVER_SETTLE_MS);
    await expect(drillRow).toBeHidden();
  });
});
