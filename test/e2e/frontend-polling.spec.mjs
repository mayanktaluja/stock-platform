import { test, expect } from "@playwright/test";
import { gotoApp, switchTab } from "./helpers/app.mjs";

const json = (route, body) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

const emptyPicks = (currency = "INR") => ({
  sections: {},
  scored_count: 0,
  failed_count: 0,
  currency,
  scanned_at: "2026-06-02T04:00:00.000Z",
  last_refresh: { finished_at: "2026-06-02T04:00:00.000Z" },
  shard_progress_api: [],
  scan_status_hint: { should_poll: false, in_progress_hint: false, panic_active: false },
  universeFilters: { available: ["nifty500"] },
});

const activeScanPicks = (currency = "INR") => ({
  ...emptyPicks(currency),
  scan_status_hint: { should_poll: true, in_progress_hint: true, panic_active: false },
});

async function installVisibilityShim(page) {
  await page.addInitScript(() => {
    let visibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => visibilityState === "hidden",
    });
    window.__setE2EVisibility = (next) => {
      visibilityState = next;
      document.dispatchEvent(new Event("visibilitychange"));
    };
  });
}

async function tickClock(page, ms) {
  await page.clock.fastForward(ms);
}

test.describe("frontend polling cadence", () => {
  test("default India boot avoids optional CPU-heavy requests", async ({ page }) => {
    await page.clock.install({ time: new Date("2026-06-02T04:00:00.000Z") });
    await installVisibilityShim(page);
    await page.addInitScript(() => {
      window.STARBHAI_CLIENT_TELEMETRY_ENABLED = false;
    });

    const hits = {
      telemetry: 0,
      watchlist: 0,
      sectionPerformance: 0,
      scanStatus: 0,
      summary: 0,
      fullPicks: 0,
    };

    await page.route("**/api/market", (route) => json(route, { marketStatus: "OPEN", indices: [] }));
    await page.route("**/api/sws-picks-summary", (route) => {
      hits.summary += 1;
      return json(route, emptyPicks());
    });
    await page.route("**/api/sws-picks", (route) => {
      hits.fullPicks += 1;
      return json(route, emptyPicks());
    });
    await page.route("**/api/telemetry", (route) => {
      hits.telemetry += 1;
      return route.fulfill({ status: 204, body: "" });
    });
    await page.route("**/api/watchlist**", (route) => {
      hits.watchlist += 1;
      return json(route, { stocks: [] });
    });
    await page.route("**/api/track/section-performance**", (route) => {
      hits.sectionPerformance += 1;
      return json(route, { windows: [], cohorts: [] });
    });
    await page.route("**/api/sws-scan/status", (route) => {
      hits.scanStatus += 1;
      return json(route, { in_progress: false, all_complete: true, shards: [], total_done: 0 });
    });

    await gotoApp(page);
    await tickClock(page, 100);
    await expect.poll(() => hits.summary).toBe(1);
    expect(hits.fullPicks).toBe(0);
    expect(hits.telemetry).toBe(0);
    expect(hits.watchlist).toBe(0);
    expect(hits.sectionPerformance).toBe(0);
    expect(hits.scanStatus).toBe(0);
  });

  test("market data polls on visible boot, pauses while hidden, and backs off when closed", async ({ page }) => {
    await page.clock.install({ time: new Date("2026-06-02T04:00:00.000Z") });
    await installVisibilityShim(page);

    let marketRequests = 0;
    const marketStates = ["OPEN", "OPEN", "CLOSED", "CLOSED"];

    await page.route("**/api/market", (route) => {
      const marketStatus = marketStates[Math.min(marketRequests, marketStates.length - 1)];
      marketRequests += 1;
      return json(route, { marketStatus, indices: [] });
    });
    await page.route("**/api/sws-picks-summary", (route) => json(route, emptyPicks()));
    await page.route("**/api/sws-scan/status", (route) =>
      json(route, { in_progress: false, all_complete: true, shards: [], total_done: 0 }),
    );

    await gotoApp(page);
    await tickClock(page, 1);
    await expect.poll(() => marketRequests).toBe(1);

    await tickClock(page, 4 * 60 * 1000 + 59 * 1000);
    expect(marketRequests).toBe(1);
    await tickClock(page, 1000);
    await expect.poll(() => marketRequests).toBe(2);

    await page.evaluate(() => window.__setE2EVisibility("hidden"));
    await tickClock(page, 2 * 60 * 1000);
    expect(marketRequests).toBe(2);

    await page.evaluate(() => window.__setE2EVisibility("visible"));
    await tickClock(page, 1);
    await expect.poll(() => marketRequests).toBe(3);

    await tickClock(page, 5 * 60 * 1000);
    expect(marketRequests).toBe(3);
    await tickClock(page, 25 * 60 * 1000);
    await expect.poll(() => marketRequests).toBe(4);
  });

  test("India scan status fast-polls only when active and slows to a visible heartbeat when idle", async ({ page }) => {
    await page.clock.install({ time: new Date("2026-06-02T04:00:00.000Z") });
    await installVisibilityShim(page);

    let swsStatusRequests = 0;
    let scanInProgress = true;

    await page.route("**/api/market", (route) => json(route, { marketStatus: "OPEN", indices: [] }));
    await page.route("**/api/sws-picks-summary", (route) => json(route, activeScanPicks()));
    await page.route("**/api/sws-scan/status", (route) => {
      swsStatusRequests += 1;
      return json(route, {
        in_progress: scanInProgress,
        all_complete: !scanInProgress,
        shards: scanInProgress ? [{ id: 1, done_count: 12, last_run_at: "2026-06-02T04:00:00.000Z" }] : [],
        total_done: scanInProgress ? 12 : 0,
      });
    });
    await page.route("**/api/watchlist**", (route) => json(route, { stocks: [] }));
    await page.route("**/api/sws-picks/by-ticker**", (route) => json(route, { byTicker: {} }));

    await gotoApp(page);
    await tickClock(page, 1);
    await expect.poll(() => swsStatusRequests).toBe(1);

    await tickClock(page, 29 * 1000);
    expect(swsStatusRequests).toBe(1);
    await tickClock(page, 1000);
    await expect.poll(() => swsStatusRequests).toBe(2);

    await page.evaluate(() => window.__setE2EVisibility("hidden"));
    await tickClock(page, 2 * 60 * 1000);
    expect(swsStatusRequests).toBe(2);

    await page.evaluate(() => window.__setE2EVisibility("visible"));
    await tickClock(page, 1);
    await expect.poll(() => swsStatusRequests).toBe(3);

    await switchTab(page, "watchlist");
    await tickClock(page, 30 * 1000);
    expect(swsStatusRequests).toBe(3);

    scanInProgress = false;
    await switchTab(page, "picks");
    await tickClock(page, 1);
    await expect.poll(() => swsStatusRequests).toBe(4);

    await tickClock(page, 30 * 1000);
    expect(swsStatusRequests).toBe(4);
    await tickClock(page, 4 * 60 * 1000 + 30 * 1000);
    await expect.poll(() => swsStatusRequests).toBe(5);
  });

  test("US scan poller is scoped to its active visible tab", async ({ page }) => {
    await page.clock.install({ time: new Date("2026-06-02T04:00:00.000Z") });
    await installVisibilityShim(page);

    const statusRequests = { us: 0 };
    const statusBody = { in_progress: true, shards: [], total_done: 0 };

    await page.route("**/api/market", (route) => json(route, { marketStatus: "OPEN", indices: [] }));
    await page.route("**/api/sws-picks-summary", (route) => json(route, emptyPicks()));
    await page.route("**/api/sws-scan/status", (route) =>
      json(route, { in_progress: false, all_complete: true, shards: [], total_done: 0 }),
    );
    await page.route("**/api/us-picks", (route) => json(route, activeScanPicks("USD")));
    await page.route("**/api/us-scan/status", (route) => {
      statusRequests.us += 1;
      return json(route, statusBody);
    });

    await gotoApp(page);
    await tickClock(page, 1);

    await switchTab(page, "usPicks");
    await tickClock(page, 1);
    await expect.poll(() => statusRequests.us).toBe(1);
    expect(statusRequests.kr).toBe(0);
    expect(statusRequests.tw).toBe(0);

    await tickClock(page, 30 * 1000);
    await expect.poll(() => statusRequests.us).toBe(2);

    await page.evaluate(() => window.__setE2EVisibility("hidden"));
    await tickClock(page, 30 * 1000);
    expect(statusRequests).toEqual({ us: 2 });
  });
});
