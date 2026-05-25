import { test, expect } from "@playwright/test";
import { gotoApp, switchTab, waitForPicksLoaded } from "./helpers/app.mjs";

async function probeSectionPerformance(request) {
  const res = await request.get("/api/track/section-performance?windows=7d,30d&bust=1");
  if (!res.ok()) return { ok: false, status: res.status(), data: null };
  const data = await res.json();
  return { ok: true, status: res.status(), data };
}

test.describe("India Market credibility banner and section alpha", () => {
  test("section-performance API returns schema-valid 7d and 30d windows", async ({ request }) => {
    const { ok, status, data } = await probeSectionPerformance(request);
    expect(ok, `section-performance status ${status}`).toBe(true);
    expect(Array.isArray(data.windows)).toBe(true);
    expect(data.windows.map((w) => w.window).sort()).toEqual(["30d", "7d"]);

    for (const w of data.windows) {
      expect(["resolved", "latest_available", "insufficient_history"]).toContain(w.sampleStatus);
      if (Array.isArray(w.sections) && w.sections.length > 1) {
        const benchmarkValues = new Set(
          w.sections
            .map((s) => s.benchmarkReturnPct)
            .filter((v) => v !== null && v !== undefined),
        );
        expect(benchmarkValues.size).toBeLessThanOrEqual(1);
      }
    }
  });

  test("India Market renders first-screen credibility banner above filters", async ({ page, request }) => {
    const picks = await request.get("/api/sws-picks");
    test.skip(picks.status() === 404, "no SWS scan committed yet — credibility banner has no sample source");

    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    const banner = page.locator("#picksCredibilityBanner");
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await expect(banner).toContainText(/Nifty 500/i);
    await expect(banner).toContainText(/top 10/i);
    await expect(banner.locator('[data-testid="picks-credibility-alpha"]')).toContainText(/[+-]\d/);

    const order = await page.evaluate(() => {
      const status = document.getElementById("picksStatusBanner");
      const banner = document.getElementById("picksCredibilityBanner");
      const filters = document.getElementById("picksFilters");
      const pos = (el) => {
        let i = 0;
        while (el && el.previousElementSibling) {
          i++;
          el = el.previousElementSibling;
        }
        return i;
      };
      return { status: pos(status), banner: pos(banner), filters: pos(filters) };
    });
    expect(order.status).toBeLessThan(order.banner);
    expect(order.banner).toBeLessThan(order.filters);
  });

  test("Track Record shows 7d/30d section alpha leaderboard with Best Fundamentals", async ({ page, request }) => {
    const probe = await probeSectionPerformance(request);
    test.skip(!probe.ok || !probe.data?.windows?.some((w) => Array.isArray(w.sections) && w.sections.length > 0), "no section-performance rows available");

    await gotoApp(page);
    await switchTab(page, "track");

    const panel = page.locator("#trackSectionPerformancePanel");
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await expect(panel).toContainText(/Section Alpha vs Nifty 500/i);
    await expect(panel).toContainText(/shared benchmark/i);

    const rows = panel.locator('[data-testid="track-section-performance-row"]');
    await expect(rows.first()).toBeVisible({ timeout: 20_000 });
    await expect(panel).toContainText(/Best Fundamentals/i);

    await panel.locator('button[data-window="30d"]').click();
    await expect(panel.locator("#trackSectionPerformanceSummary")).toContainText(/30d|Latest available track sample/i);
  });
});
