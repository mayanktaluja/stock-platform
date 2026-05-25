import { test, expect } from "@playwright/test";
import { gotoApp, switchTab, waitForPicksLoaded } from "./helpers/app.mjs";

async function probeSectionPerformance(request) {
  const res = await request.get("/api/track/section-performance?windows=7d,30d&cohorts=3,5,10,20&bust=1");
  if (!res.ok()) return { ok: false, status: res.status(), data: null };
  const data = await res.json();
  return { ok: true, status: res.status(), data };
}

test.describe("India Market credibility banner and section alpha", () => {
  test("section-performance API returns schema-valid 7d and 30d windows", async ({ request }) => {
    const { ok, status, data } = await probeSectionPerformance(request);
    expect(ok, `section-performance status ${status}`).toBe(true);
    expect(Array.isArray(data.windows)).toBe(true);
    expect(data.cohorts).toEqual([3, 5, 10, 20]);
    expect(data.windows.map((w) => w.window).sort()).toEqual(["30d", "7d"]);

    for (const w of data.windows) {
      expect(["resolved", "latest_available", "insufficient_history"]).toContain(w.sampleStatus);
      if (Array.isArray(w.sections) && w.sections.length > 1) {
        const requestedSizes = new Set(w.sections.map((s) => s.requestedCohortSize).filter(Boolean));
        for (const size of [3, 5, 10, 20]) expect(requestedSizes.has(size)).toBe(true);
        const benchmarkValues = new Set(
          w.sections
            .map((s) => s.benchmarkReturnPct)
            .filter((v) => v !== null && v !== undefined),
        );
        expect(benchmarkValues.size).toBeLessThanOrEqual(1);
        for (const row of w.sections.slice(0, 8)) {
          expect(row.cohortLabel).toMatch(/top \d+/i);
          expect(typeof row.eligibleForBanner).toBe("boolean");
        }
      }
    }

    const legacyRes = await request.get("/api/track/section-performance?windows=7d&bust=1");
    expect(legacyRes.ok()).toBe(true);
    const legacyData = await legacyRes.json();
    expect(legacyData.cohorts).toEqual([10]);
    for (const w of legacyData.windows || []) {
      const requestedSizes = new Set((w.sections || []).map((s) => s.requestedCohortSize).filter(Boolean));
      expect([...requestedSizes]).toEqual(requestedSizes.size ? [10] : []);
    }
  });

  test("India Market renders first-screen credibility banner above filters", async ({ page, request }) => {
    const picks = await request.get("/api/sws-picks");
    test.skip(picks.status() === 404, "no SWS scan committed yet — credibility banner has no sample source");
    const probe = await probeSectionPerformance(request);
    const best = probe.data?.bestOverall;
    const bestWindow = probe.data?.windows?.find((w) => w.window === best?.window);
    const hasPositiveAlpha = Number.isFinite(Number(best?.alphaPct)) && Number(best.alphaPct) > 0 && best.outperformed !== false;

    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    const banner = page.locator("#picksCredibilityBanner");
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await expect(banner).toContainText(/Track Record Spotlight/i);
    await expect(banner).toContainText(/Nifty 500/i);
    await expect(banner).toContainText(/Methodology/i);
    await expect(banner).toContainText(/7d/i);
    await expect(banner).toContainText(/30d/i);
    await expect(banner).not.toContainText(/Latest available track sample \(/i);
    if (hasPositiveAlpha) {
      await expect(banner).toContainText(/top (3|5|10|20|\d+ available)/i);
      await expect(banner.locator('[data-testid="picks-credibility-alpha"]')).toContainText(/[+-]\d/);
      if (bestWindow?.sampleStatus === "latest_available") {
        await expect(banner.locator('[data-testid="picks-credibility-headline"]')).toContainText(/sample shows/i);
        await expect(banner).toContainText(/Closed-window cohorts will replace this as history matures/i);
      }
      if (bestWindow?.sampleStatus === "resolved") {
        await expect(banner.locator('[data-testid="picks-credibility-headline"]')).toContainText(/beat Nifty 500/i);
      }
    } else {
      await expect(banner.locator('[data-testid="picks-credibility-headline"]')).not.toContainText(/beat Nifty 500/i);
    }

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

  test("India Market uses neutral banner copy when no section has positive alpha", async ({ page, request }) => {
    const picks = await request.get("/api/sws-picks");
    test.skip(picks.status() === 404, "no SWS scan committed yet — credibility banner has no sample source");

    await page.route("**/api/track/section-performance?**", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          schema_version: "sws-section-performance-v1",
          mode: "latest_available",
          generatedAt: "2026-05-25T00:00:00.000Z",
          bestOverall: {
            window: "7d",
            sampleStatus: "latest_available",
            label: "SWS - Quality Growth",
            cohortLabel: "top 5",
            requestedCohortSize: 5,
            actualCohortSize: 5,
            eligibleForBanner: false,
            alphaPct: -0.5,
            sectionReturnPct: -1.1,
            benchmarkReturnPct: -0.6,
            outperformed: false,
          },
          windows: [
            {
              window: "7d",
              sampleStatus: "latest_available",
              benchmarkReturnPct: -0.6,
              bestSection: {
                label: "SWS - Quality Growth",
                cohortLabel: "top 5",
                requestedCohortSize: 5,
                actualCohortSize: 5,
                eligibleForBanner: false,
                alphaPct: -0.5,
                sectionReturnPct: -1.1,
                benchmarkReturnPct: -0.6,
                outperformed: false,
              },
              sections: [],
            },
            {
              window: "30d",
              sampleStatus: "insufficient_history",
              benchmarkReturnPct: null,
              bestSection: null,
              sections: [],
            },
          ],
        }),
      });
    });

    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    const banner = page.locator("#picksCredibilityBanner");
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await expect(banner).toContainText(/No eligible section cohort is currently ahead of Nifty 500/i);
    await expect(banner.locator('[data-testid="picks-credibility-headline"]')).not.toContainText(/beat Nifty 500/i);
    await expect(banner.locator('[data-testid="picks-credibility-alpha"]')).toHaveCount(0);
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
    await expect(panel.locator("#trackSectionPerformanceCohortTabs")).toContainText(/Best/i);
    await expect(panel.locator("#trackSectionPerformanceCohortTabs")).toContainText(/Top 3/i);
    await expect(panel.locator("#trackSectionPerformanceCohortTabs")).toContainText(/Top 20/i);

    const rows = panel.locator('[data-testid="track-section-performance-row"]');
    await expect(rows.first()).toBeVisible({ timeout: 20_000 });
    await expect(panel).toContainText(/Best Fundamentals/i);
    await expect(rows.first().locator('[data-testid="track-section-cohort-label"]')).toContainText(/top/i);

    await panel.locator('button[data-window="30d"]').click();
    await expect(panel.locator("#trackSectionPerformanceSummary")).toContainText(/30d|Latest available track sample/i);
    await panel.locator('button[data-cohort="3"]').click();
    await expect(panel.locator("#trackSectionPerformanceSummary")).toContainText(/top 3 cohorts/i);
    await panel.locator('button[data-cohort="20"]').click();
    await expect(panel.locator("#trackSectionPerformanceSummary")).toContainText(/top 20 cohorts/i);
  });
});
