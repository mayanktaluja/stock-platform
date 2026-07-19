// PR #12: axe-core a11y scan per non-admin tab. Asserts zero CRITICAL
// WCAG 2.1 AA violations on each tab's first render. Serious + moderate
// + minor are LOGGED but don't fail — the pre-PR platform has multiple
// long-standing serious violations (scrollable-region-focusable on the
// dashboard scrollers, etc.) that aren't regressions introduced by this
// uplift. A future a11y-sweep PR can ratchet the gate down to serious
// once the existing violations are addressed.
//
// F1 update: parametrized over BOTH themes — the light palette (A1) must be
// as critical-clean as dark. Per-test timeout is 90s because the track tab's
// /api/track/history takes ~13s on a cold cache in the test env; the old 30s
// budget expired mid-axe-scan and masqueraded as an a11y failure.

import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { gotoApp, switchTab } from "./helpers/app.mjs";

const TABS = ["picks", "news", "track", "analyzer", "watchlist"];
const THEMES = ["dark", "light"];

async function mockBoundedTrackRecord(page) {
  await page.route("**/api/track/history**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        performance: {
          total: 1,
          winRate: 100,
          avgReturn: 4.2,
          avgAlpha: 1.2,
          beatsNiftyRate: 100,
          benchmarkSampleSize: 1,
        },
        totalCount: 1,
        firstLivePickAt: "2026-05-20T00:00:00.000Z",
        trades: [{
          id: "axe-track-1",
          type: "sws_top30_v3",
          symbol: "TEST.NS",
          name: "Test Ltd",
          sector: "Financials",
          snapshotAt: "2026-05-20T00:00:00.000Z",
          priceAtSnapshot: 100,
          regimeAtSnapshot: "CALM",
          returns: {
            currentPrice: 104.2,
            returnPct: 4.2,
            alpha: 1.2,
            beatsNifty: true,
            daysHeld: 7,
          },
        }],
        byType: {},
        byRegime: {},
        bySector: {},
        bySectionScorecard: {},
        lastComputedAt: "2026-05-27T00:00:00.000Z",
      }),
    });
  });
  await page.route("**/api/track/sections**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ sections: [], lastComputedAt: "2026-05-27T00:00:00.000Z" }),
    });
  });
  await page.route("**/api/track/section-performance**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schema_version: "sws-section-performance-v1",
        mode: "axe_fixture",
        generatedAt: "2026-05-27T00:00:00.000Z",
        bestOverall: null,
        spotlightSection: null,
        windows: [],
      }),
    });
  });
  await page.route("**/api/track/calibration**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ total: 0, resolved: 0, buckets: [] }),
    });
  });
}

test.describe("PR #12 axe-core a11y scan (critical only)", () => {
  for (const theme of THEMES) {
    for (const tab of TABS) {
      test(`${tab} tab (${theme}) has no CRITICAL WCAG 2.1 AA violations`, async ({
        page,
      }) => {
        test.setTimeout(90_000);
        if (tab === "track") await mockBoundedTrackRecord(page);
        await gotoApp(page);
        // Set theme AFTER gotoApp (its first-nav storage-clear would wipe it),
        // then reload so the boot script re-resolves from localStorage.
        await page.evaluate((t) => localStorage.setItem("theme", t), theme);
        await page.reload();
        await page.waitForFunction(
          (t) => document.documentElement.getAttribute("data-theme") === t,
          theme,
        );
        if (tab !== "picks") await switchTab(page, tab);
        await page.waitForTimeout(500);
        // Let slow tabs (track: ~13s cold /api/track/history) settle so axe
        // doesn't race a mid-render DOM.
        await page
          .waitForLoadState("networkidle", { timeout: 30_000 })
          .catch(() => {});
        const results = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze();
        const critical = results.violations.filter(
          (v) => v.impact === "critical",
        );
        const serious = results.violations.filter(
          (v) => v.impact === "serious",
        );
        if (serious.length > 0) {
          // eslint-disable-next-line no-console
          console.log(
            `[a11y-backlog] ${tab}/${theme} — ${serious.length} serious violations (not gating):`,
            serious.map((v) => `${v.id} (${v.nodes.length} nodes)`).join(", "),
          );
        }
        expect(
          critical,
          `${tab} tab (${theme}) has ${critical.length} CRITICAL WCAG violations: ` +
            critical.map((v) => `${v.id}`).join(", "),
        ).toEqual([]);
      });
    }
  }
});
