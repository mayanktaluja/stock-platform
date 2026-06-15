import { test, expect } from "@playwright/test";
import { gotoApp, switchTab, waitForPicksLoaded } from "./helpers/app.mjs";

const SPOTLIGHT_COPY_REGRESSIONS = [
  /current.?cohort/i,
  /latest available .*sample/i,
  /Closed.?window/i,
  /history .*matures/i,
  /current track .*sample/i,
  /latest_available/i,
];

async function probeSectionPerformance(request) {
  const res = await request.get("/api/track/section-performance?windows=7d,30d,3m,1y,3y,5y&cohorts=3,5,10,20&bust=1");
  if (!res.ok()) return { ok: false, status: res.status(), data: null };
  const data = await res.json();
  return { ok: true, status: res.status(), data };
}

async function probePicksCredibilityPerformance(request) {
  const res = await request.get("/api/track/section-performance?windows=7d,30d&cohorts=3,5,10,20&bust=1");
  if (!res.ok()) return { ok: false, status: res.status(), data: null };
  const data = await res.json();
  return { ok: true, status: res.status(), data };
}

test.describe("India Market credibility banner and section alpha", () => {
  test("section-performance API returns schema-valid short and long horizon windows", async ({ request }) => {
    const { ok, status, data } = await probeSectionPerformance(request);
    expect(ok, `section-performance status ${status}`).toBe(true);
    expect(Array.isArray(data.windows)).toBe(true);
    expect(data.cohorts).toEqual([3, 5, 10, 20]);
    expect(data.windows.map((w) => w.window)).toEqual(["7d", "30d", "3m", "1y", "3y", "5y"]);

    for (const w of data.windows) {
      expect(["resolved", "latest_available", "insufficient_history"]).toContain(w.sampleStatus);
      expect(typeof w.enabled).toBe("boolean");
      if (["3y", "5y"].includes(w.window)) {
        expect(w.enabled).toBe(false);
        expect(w.sections || []).toHaveLength(0);
        expect(w.bestSection).toBeFalsy();
        expect(w.disabledReason || "").toMatch(/Waiting for .* years/i);
        continue;
      }
      expect(w).not.toHaveProperty("benchmarkComparisons");
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
          expect(row).not.toHaveProperty("benchmarkComparisons");
        }
      }
    }
    expect(data.spotlightSection == null || ["7d", "30d", "3m", "1y"].includes(data.spotlightSection.window)).toBe(true);

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
    const probe = await probePicksCredibilityPerformance(request);
    const best = Object.prototype.hasOwnProperty.call(probe.data || {}, "spotlightSection")
      ? probe.data?.spotlightSection
      : probe.data?.bestOverall;
    const bestWindow = probe.data?.windows?.find((w) => w.window === best?.window);
    const hasPositiveAlpha = Number.isFinite(Number(best?.alphaPct)) && Number(best.alphaPct) > 0 && best.outperformed !== false;

    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    const banner = page.locator("#picksCredibilityBanner");
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await expect(banner).toContainText(/Track Record Spotlight/i);
    await expect(banner).toContainText(/Nifty 50/i);
    await expect(banner).not.toContainText(/Nifty 500|N500|N50/i);
    await expect(banner).toContainText(/Methodology/i);
    await expect(banner.getByRole("button", { name: /^7d\b/i })).toHaveCount(0);
    await expect(banner.getByRole("button", { name: /^30d\b/i })).toHaveCount(0);
    for (const pattern of SPOTLIGHT_COPY_REGRESSIONS) {
      await expect(banner).not.toContainText(pattern);
    }
    expect(await page.evaluate(() => typeof window.__picksCredibilitySelect)).toBe("undefined");
    if (best?.window) {
      const selected = banner.locator('[data-testid="picks-credibility-selected-window"]');
      await expect(selected).toHaveCount(1);
      await expect(selected).not.toContainText(/\b(3m|1y|3y|5y)\b/i);
      await expect(selected).toContainText(best.window);
      await expect(selected).toContainText(best.cohortLabel || `top ${best.requestedCohortSize || 10}`);
    }
    if (hasPositiveAlpha) {
      await expect(banner).toContainText(/top (3|5|10|20|\d+ available)/i);
      await expect(banner.locator('[data-testid="picks-credibility-alpha"]')).toContainText(/[+-]\d/);
      if (bestWindow?.sampleStatus === "latest_available") {
        await expect(banner.locator('[data-testid="picks-credibility-headline"]')).toContainText(/shows .* alpha vs Nifty 50/i);
        await expect(banner.locator('[data-testid="picks-credibility-headline"]')).not.toContainText(/sample/i);
      }
      if (bestWindow?.sampleStatus === "resolved") {
        await expect(banner.locator('[data-testid="picks-credibility-headline"]')).toContainText(/beat Nifty 50/i);
      }
    } else {
      await expect(banner.locator('[data-testid="picks-credibility-headline"]')).not.toContainText(/beat Nifty 50/i);
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

  test("India Market spotlight requests and renders only short windows", async ({ page, request }) => {
    const picks = await request.get("/api/sws-picks");
    test.skip(picks.status() === 404, "no SWS scan committed yet — credibility banner has no sample source");

    let sawShortWindowRequest = false;
    await page.route("**/api/track/section-performance?**", async (route) => {
      const url = new URL(route.request().url());
      const windows = url.searchParams.get("windows");
      expect(windows).toBe("7d,30d");
      expect(windows).not.toContain("3m");
      expect(windows).not.toContain("1y");
      sawShortWindowRequest = true;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          schema_version: "sws-section-performance-v1",
          mode: "latest_available",
          generatedAt: "2026-05-25T00:00:00.000Z",
          bestOverall: {
            window: "1y",
            sampleStatus: "latest_available",
            label: "SWS - Quality Growth",
            cohortLabel: "top 3",
            requestedCohortSize: 3,
            actualCohortSize: 3,
            eligibleForBanner: true,
            spotlightEligible: false,
            alphaPct: 24,
            sectionReturnPct: 32,
            benchmarkReturnPct: 8,
            outperformed: true,
          },
          spotlightSection: {
            window: "3m",
            sampleStatus: "latest_available",
            label: "SWS - Mid-Term",
            cohortLabel: "top 3",
            requestedCohortSize: 3,
            actualCohortSize: 3,
            eligibleForBanner: true,
            spotlightEligible: true,
            alphaPct: 15,
            sectionReturnPct: 18.1,
            benchmarkReturnPct: 3.1,
            outperformed: true,
          },
          windows: [
            {
              window: "7d",
              sampleStatus: "latest_available",
              benchmarkReturnPct: 3.1,
              bestSection: {
                label: "SWS - Best Stocks to Buy Now",
                cohortLabel: "top 5",
                requestedCohortSize: 5,
                actualCohortSize: 5,
                eligibleForBanner: true,
                spotlightEligible: true,
                alphaPct: 3.7,
                sectionReturnPct: 6.8,
                benchmarkReturnPct: 3.1,
                outperformed: true,
              },
              sections: [],
            },
            {
              window: "30d",
              sampleStatus: "latest_available",
              benchmarkReturnPct: 2.9,
              bestSection: {
                label: "SWS - Best Fundamentals",
                cohortLabel: "top 5",
                requestedCohortSize: 5,
                actualCohortSize: 5,
                eligibleForBanner: true,
                spotlightEligible: true,
                alphaPct: 6.2,
                sectionReturnPct: 9.1,
                benchmarkReturnPct: 2.9,
                outperformed: true,
              },
              sections: [],
            },
            {
              window: "3m",
              label: "3m",
              enabled: true,
              sampleStatus: "latest_available",
              benchmarkReturnPct: 3.1,
              bestSection: {
                label: "SWS - Mid-Term",
                cohortLabel: "top 3",
                requestedCohortSize: 3,
                actualCohortSize: 3,
                eligibleForBanner: true,
                spotlightEligible: true,
                alphaPct: 15,
                sectionReturnPct: 18.1,
                benchmarkReturnPct: 3.1,
                outperformed: true,
              },
              sections: [],
            },
            {
              window: "1y",
              label: "1y",
              enabled: true,
              sampleStatus: "latest_available",
              benchmarkReturnPct: 8,
              bestSection: {
                label: "SWS - Quality Growth",
                cohortLabel: "top 3",
                requestedCohortSize: 3,
                actualCohortSize: 3,
                eligibleForBanner: true,
                spotlightEligible: false,
                alphaPct: 12,
                sectionReturnPct: 20,
                benchmarkReturnPct: 8,
                outperformed: true,
              },
              sections: [],
            },
            {
              window: "3y",
              label: "3y",
              enabled: false,
              sampleStatus: "insufficient_history",
              disabledReason: "Waiting for 3 years of daily section snapshots before this can become a Track Record window.",
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
    expect(sawShortWindowRequest).toBe(true);
    await expect(banner.locator('[data-testid="picks-credibility-headline"]')).toContainText(/Best Fundamentals top 5 shows \+6\.2% alpha vs Nifty 50/i);
    await expect(banner.locator('[data-testid="picks-credibility-evidence"]')).toContainText(/Equal-weight top 5: \+9\.1% vs Nifty 50 \+2\.9%/);
    for (const pattern of SPOTLIGHT_COPY_REGRESSIONS) {
      await expect(banner).not.toContainText(pattern);
    }
    await expect(banner).not.toContainText(/Nifty 500|N500|N50/i);
    await expect(banner.locator('[data-testid="picks-credibility-alpha"]')).toContainText("+6.2%");
    await expect(banner.locator('[data-testid="picks-credibility-selected-window"]')).toHaveText(/30d · Best Fundamentals top 5 \+6\.2%/);
    await expect(banner.locator('[data-testid="picks-credibility-selected-window"]')).not.toContainText(/\b(3m|1y|3y|5y)\b/i);
    await expect(banner).not.toContainText(/Mid-Term|1y|3m/);
    await expect(banner.getByRole("button", { name: /^7d\b/i })).toHaveCount(0);
    await expect(banner.getByRole("button", { name: /^30d\b/i })).toHaveCount(0);
    expect(await page.evaluate(() => typeof window.__picksCredibilitySelect)).toBe("undefined");
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
          spotlightSection: null,
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
    await expect(banner).toContainText(/Track Record is building section-alpha evidence vs Nifty 50/i);
    await expect(banner).toContainText(/Section alpha will appear here once enough eligible cohorts and benchmark data are available/i);
    await expect(banner.locator('[data-testid="picks-credibility-headline"]')).not.toContainText(/beat Nifty 50/i);
    await expect(banner).not.toContainText(/Nifty 500|N500|N50/i);
    await expect(banner.locator('[data-testid="picks-credibility-alpha"]')).toHaveCount(0);
    await expect(banner.locator('[data-testid="picks-credibility-selected-window"]')).toHaveCount(0);
  });

  test("Track Record panel renders Nifty 50 as the sole Section Alpha benchmark", async ({ page }) => {
    let sawPicksShortRequest = false;
    let sawTrackFullRequest = false;
    await page.route("**/api/track/section-performance?**", async (route) => {
      const url = new URL(route.request().url());
      const windows = url.searchParams.get("windows");
      if (windows === "7d,30d") sawPicksShortRequest = true;
      if (windows === "7d,30d,3m,1y,3y,5y") sawTrackFullRequest = true;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          schema_version: "sws-section-performance-v1",
          mode: "latest_available",
          cohorts: [3, 5, 10, 20],
          generatedAt: "2026-05-25T00:00:00.000Z",
          bestOverall: {
            window: "7d",
            sampleStatus: "latest_available",
            label: "SWS - Best Fundamentals",
            cohortLabel: "top 3",
            requestedCohortSize: 3,
            actualCohortSize: 3,
            eligibleForBanner: true,
            alphaPct: 5,
            sectionReturnPct: 8,
            benchmarkReturnPct: 3,
            outperformed: true,
          },
          windows: [
            {
              window: "7d",
              fromDate: "2026-05-18",
              toDate: "2026-05-25",
              benchmarkReturnPct: 3,
              sampleStatus: "latest_available",
              bestSection: {
                label: "SWS - Best Fundamentals",
                cohortLabel: "top 3",
                requestedCohortSize: 3,
                actualCohortSize: 3,
                eligibleForBanner: true,
                alphaPct: 5,
                sectionReturnPct: 8,
                benchmarkReturnPct: 3,
                outperformed: true,
              },
              sections: [
                {
                  type: "sws_best_fundamentals",
                  sectionKey: "best_fundamentals",
                  label: "SWS - Best Fundamentals",
                  side: "LONG",
                  requestedCohortSize: 3,
                  actualCohortSize: 3,
                  cohortLabel: "top 3",
                  eligibleForBanner: true,
                  sampleSize: 3,
                  coveragePct: 100,
                  sectionReturnPct: 8,
                  benchmarkReturnPct: 3,
                  alphaPct: 5,
                  outperformed: true,
                  status: "latest_available",
                  fromDate: "2026-05-18",
                  toDate: "2026-05-25",
                },
              ],
            },
            {
              window: "30d",
              benchmarkReturnPct: null,
              sampleStatus: "insufficient_history",
              bestSection: null,
              sections: [],
            },
            {
              window: "3m",
              fromDate: "2026-02-24",
              toDate: "2026-05-25",
              benchmarkReturnPct: 2,
              sampleStatus: "latest_available",
              bestSection: {
                label: "SWS - Mid-Term",
                cohortLabel: "top 3",
                requestedCohortSize: 3,
                actualCohortSize: 3,
                eligibleForBanner: true,
                alphaPct: 7,
                sectionReturnPct: 9,
                benchmarkReturnPct: 2,
                outperformed: true,
              },
              sections: [
                {
                  type: "sws_midterm",
                  sectionKey: "midterm",
                  label: "SWS - Mid-Term",
                  side: "LONG",
                  requestedCohortSize: 3,
                  actualCohortSize: 3,
                  cohortLabel: "top 3",
                  eligibleForBanner: true,
                  sampleSize: 3,
                  coveragePct: 100,
                  sectionReturnPct: 9,
                  benchmarkReturnPct: 2,
                  alphaPct: 7,
                  outperformed: true,
                  status: "latest_available",
                  fromDate: "2026-02-24",
                  toDate: "2026-05-25",
                },
              ],
            },
            {
              window: "1y",
              benchmarkReturnPct: null,
              sampleStatus: "insufficient_history",
              bestSection: null,
              sections: [],
            },
            {
              window: "3y",
              enabled: false,
              sampleStatus: "insufficient_history",
              disabledReason: "Waiting for 3 years of daily section snapshots before this can become a Track Record window.",
              bestSection: null,
              sections: [],
            },
            {
              window: "5y",
              enabled: false,
              sampleStatus: "insufficient_history",
              disabledReason: "Waiting for 5 years of daily section snapshots before this can become a Track Record window.",
              bestSection: null,
              sections: [],
            },
          ],
        }),
      });
    });

    await gotoApp(page);
    await switchTab(page, "track");

    const panel = page.locator("#trackSectionPerformancePanel");
    expect(sawPicksShortRequest).toBe(true);
    expect(sawTrackFullRequest).toBe(true);
    await expect(panel).toContainText(/Section Alpha vs Nifty 50/i);
    await expect(panel).toContainText(/ranked against Nifty 50 TRI/i);
    await expect(panel.locator("#trackSectionPerformanceSummary")).toContainText(/shared benchmark: Nifty 50 \+3\.0%/);
    await expect(panel.locator('[data-testid="track-section-performance-row"]').first()).toContainText(/Nifty 50 \+3\.0%/);
    await expect(panel.locator("#trackSectionPerformanceWindowTabs")).toContainText(/3m/i);
    await expect(panel.locator("#trackSectionPerformanceWindowTabs")).toContainText(/1y/i);
    await panel.locator('button[data-window="3m"]').click();
    await expect(panel.locator("#trackSectionPerformanceSummary")).toContainText(/3M|3m/i);
    for (const pattern of SPOTLIGHT_COPY_REGRESSIONS) {
      await expect(panel).not.toContainText(pattern);
    }
    await expect(panel).not.toContainText(/Nifty 500|N500|N50|Benchmarks/i);
  });

  test("Track Record shows section alpha leaderboard across enabled and disabled horizons", async ({ page, request }) => {
    const probe = await probeSectionPerformance(request);
    test.skip(!probe.ok || !probe.data?.windows?.some((w) => Array.isArray(w.sections) && w.sections.length > 0), "no section-performance rows available");

    await gotoApp(page);
    await switchTab(page, "track");

    const panel = page.locator("#trackSectionPerformancePanel");
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await expect(panel).toContainText(/Section Alpha vs Nifty 50/i);
    await expect(panel).toContainText(/ranked against Nifty 50 TRI/i);
    await expect(panel).not.toContainText(/Nifty 500|N500|N50|Benchmarks/i);
    await expect(panel.locator("#trackSectionPerformanceCohortTabs")).toContainText(/Best/i);
    await expect(panel.locator("#trackSectionPerformanceCohortTabs")).toContainText(/Top 3/i);
    await expect(panel.locator("#trackSectionPerformanceCohortTabs")).toContainText(/Top 20/i);
    await expect(panel.locator("#trackSectionPerformanceWindowTabs")).toContainText(/3m/i);
    await expect(panel.locator("#trackSectionPerformanceWindowTabs")).toContainText(/1y/i);
    await expect(panel.locator('button[data-window="3y"]')).toBeDisabled();
    await expect(panel.locator('button[data-window="5y"]')).toBeDisabled();
    for (const pattern of SPOTLIGHT_COPY_REGRESSIONS) {
      await expect(panel).not.toContainText(pattern);
    }

    const rows = panel.locator('[data-testid="track-section-performance-row"]');
    await expect(rows.first()).toBeVisible({ timeout: 20_000 });
    await expect(panel).toContainText(/Best Fundamentals/i);
    await expect(rows.first().locator('[data-testid="track-section-cohort-label"]')).toContainText(/top/i);

    await panel.locator('button[data-window="30d"]').click();
    await expect(panel.locator("#trackSectionPerformanceSummary")).toContainText(/30d|1M/i);
    await panel.locator('button[data-window="3m"]').click();
    await expect(panel.locator("#trackSectionPerformanceSummary")).toContainText(/3m|3M/i);
    await panel.locator('button[data-window="1y"]').click();
    await expect(panel.locator("#trackSectionPerformanceSummary")).toContainText(/1y|1Y/i);
    await panel.locator('button[data-cohort="3"]').click();
    await expect(panel.locator("#trackSectionPerformanceSummary")).toContainText(/top 3 cohorts/i);
    await panel.locator('button[data-cohort="20"]').click();
    await expect(panel.locator("#trackSectionPerformanceSummary")).toContainText(/top 20 cohorts/i);
  });

  test("Track Record panel flags hindsight backfills and shows the illustrative-basis disclaimer", async ({ page }) => {
    await page.route("**/api/track/section-performance?**", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          schema_version: "sws-section-performance-v1",
          mode: "latest_available",
          basis: "current_cohort_trailing",
          isHypothetical: true,
          cohorts: [3, 5, 10, 20],
          generatedAt: "2026-06-10T00:00:00.000Z",
          bestOverall: {
            window: "30d", sampleStatus: "latest_available", label: "SWS - Best Stocks to Buy Now",
            cohortLabel: "top 3", requestedCohortSize: 3, actualCohortSize: 3,
            eligibleForBanner: true, hindsight: false, alphaPct: 6.8, sectionReturnPct: 3.1,
            benchmarkReturnPct: -3.7, outperformed: true,
          },
          windows: [
            { window: "7d", sampleStatus: "latest_available", benchmarkReturnPct: -1, bestSection: null, sections: [] },
            { window: "30d", sampleStatus: "latest_available", benchmarkReturnPct: -3.7, bestSection: null, sections: [] },
            {
              window: "3m", label: "3m", enabled: true, sampleStatus: "latest_available",
              benchmarkReturnPct: -4, fromDate: "2026-03-11", toDate: "2026-06-10",
              bestSection: {
                label: "SWS - Best Stocks to Buy Now", cohortLabel: "top 3", requestedCohortSize: 3, actualCohortSize: 3,
                eligibleForBanner: false, hindsight: true, alphaPct: 28, sectionReturnPct: 24,
                benchmarkReturnPct: -4, outperformed: false, status: "latest_available",
              },
              sections: [{
                type: "sws_best_buynow", sectionKey: "best_to_buy_now", label: "SWS - Best Stocks to Buy Now",
                side: "LONG", requestedCohortSize: 3, actualCohortSize: 3, cohortLabel: "top 3",
                eligibleForBanner: false, hindsight: true, sampleSize: 3, coveragePct: 100,
                sectionReturnPct: 24, benchmarkReturnPct: -4, alphaPct: 28, outperformed: false,
                status: "latest_available", qualityFlags: ["hindsight_backfill"],
                fromDate: "2026-03-11", toDate: "2026-06-10",
              }],
            },
            { window: "1y", enabled: true, sampleStatus: "latest_available", benchmarkReturnPct: -6, bestSection: null, sections: [] },
            { window: "3y", enabled: false, sampleStatus: "insufficient_history", disabledReason: "Waiting for 3 years of daily section snapshots before this can become a Track Record window.", bestSection: null, sections: [] },
            { window: "5y", enabled: false, sampleStatus: "insufficient_history", disabledReason: "Waiting for 5 years of daily section snapshots before this can become a Track Record window.", bestSection: null, sections: [] },
          ],
        }),
      });
    });

    await gotoApp(page);
    await switchTab(page, "track");
    const panel = page.locator("#trackSectionPerformancePanel");
    await expect(panel).toBeVisible({ timeout: 10_000 });

    // The illustrative-basis disclaimer is present whenever the panel is hypothetical.
    const disclaimer = panel.locator('[data-testid="track-section-performance-disclaimer"]');
    await expect(disclaimer).toBeVisible();
    await expect(disclaimer).toContainText(/Illustrative — not a realized track record/i);
    await expect(disclaimer).toContainText(/trailing returns of today's top-ranked picks/i);

    // Selecting the 3m (hindsight) window flags the backfill explicitly.
    await panel.locator('button[data-window="3m"]').click();
    const row = panel.locator('[data-testid="track-section-performance-row"]').first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row.locator('[data-testid="track-section-hindsight-badge"]')).toContainText(/HINDSIGHT/);
    await expect(row).toContainText(/trailing, not held/i);
  });

  test("public Track Record APIs and UI exclude non-buy SWS buckets", async ({ page, request }) => {
    const retiredTypes = ["sws_upcoming_earnings", "sws_avoid"];
    const retiredLabels = /Upcoming Earnings|SWS - Avoid|SWS — Avoid|Avoid \(sell signal\)/;

    const sectionPerf = await probeSectionPerformance(request);
    expect(sectionPerf.ok, `section-performance status ${sectionPerf.status}`).toBe(true);
    for (const w of sectionPerf.data?.windows || []) {
      expect((w.sections || []).map((s) => s.type)).not.toEqual(expect.arrayContaining(retiredTypes));
      expect(w.bestSection?.type || "").not.toMatch(/sws_(upcoming_earnings|avoid)/);
    }
    expect(sectionPerf.data?.bestOverall?.type || "").not.toMatch(/sws_(upcoming_earnings|avoid)/);

    const sectionsRes = await request.get("/api/track/sections?bust=1");
    expect(sectionsRes.ok()).toBe(true);
    const sections = await sectionsRes.json();
    expect((sections.sections || []).map((s) => s.type)).not.toEqual(expect.arrayContaining(retiredTypes));
    expect((sections.sections || []).map((s) => s.type)).toContain("sws_growing_sector_value");
    expect(JSON.stringify(sections)).not.toMatch(retiredLabels);

    const statsRes = await request.get("/api/track/stats?bust=1");
    expect(statsRes.ok()).toBe(true);
    const stats = await statsRes.json();
    expect(Object.keys(stats.byType || {})).not.toEqual(expect.arrayContaining(retiredTypes));

    const historyRes = await request.get("/api/track/history?bust=1");
    expect(historyRes.ok()).toBe(true);
    const history = await historyRes.json();
    expect((history.trades || []).map((t) => t.type)).not.toEqual(expect.arrayContaining(retiredTypes));
    expect(Object.keys(history.byType || {})).not.toEqual(expect.arrayContaining(retiredTypes));

    const csvRes = await request.get("/api/track/export.csv");
    expect(csvRes.ok()).toBe(true);
    const csv = await csvRes.text();
    expect(csv).not.toContain("sws_upcoming_earnings");
    expect(csv).not.toContain("sws_avoid");

    await gotoApp(page);
    await switchTab(page, "track");
    await expect(page.locator("#trackFilter")).toContainText(/Growing Sector Value/i);
    await expect(page.locator("#trackFilter")).not.toContainText(/Upcoming Earnings|Avoid \(sell signal\)/i);
    await expect(page.locator("#trackSectionPerformancePanel")).not.toContainText(retiredLabels);
    await expect(page.locator("#trackSectionGrid")).not.toContainText(retiredLabels);
    await expect(page.locator("#trackHistoryTable")).not.toContainText(/SWS · Upcoming Earnings|SWS · Avoid/i);
  });
});
