import { test, expect } from "@playwright/test";
import { gotoApp, switchTab } from "./helpers/app.mjs";

const json = (route, body) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

const picksSummary = {
  sections: {
    top_ranked_30_v4: [
      {
        ticker: "TST",
        name: "Test Industries",
        sector: "Industrials",
        v4_verdict: "STRONG",
        one_line: "Curated test row",
      },
    ],
  },
  scored_count: 1,
  failed_count: 0,
  currency: "INR",
  scanned_at: "2026-06-02T04:00:00.000Z",
  last_refresh: { finished_at: "2026-06-02T04:00:00.000Z" },
  shard_progress_api: [],
  scan_status_hint: {
    should_poll: false,
    in_progress_hint: false,
    panic_active: false,
  },
};

test.describe("Watchlist decision state", () => {
  test("rows render as research-only and star toggles still call add/remove", async ({ page }) => {
    const requests = [];
    const stocks = [
      {
        symbol: "TST.NS",
        name: "Test Industries",
        sector: "Industrials",
        price: 120,
        change: 1.5,
        changePercent: 1.25,
        addedPrice: 110,
        addedAt: "2026-06-01T09:15:00.000Z",
      },
    ];

    await page.route("**/api/sws-picks-summary", (route) => json(route, picksSummary));
    await page.route("**/api/sws-scan/status", (route) =>
      json(route, { in_progress: false, all_complete: true, shards: [], total_done: 1 }),
    );
    await page.route("**/api/market", (route) => json(route, { marketStatus: "OPEN", indices: [] }));
    await page.route("**/api/watchlist**", async (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname.endsWith("/add")) {
        requests.push({ action: "add", body: route.request().postDataJSON() });
        return json(route, { ok: true, stock: route.request().postDataJSON() });
      }
      if (pathname.endsWith("/remove")) {
        requests.push({ action: "remove", body: route.request().postDataJSON() });
        return json(route, { ok: true });
      }
      return json(route, { stocks });
    });

    await gotoApp(page, { tab: "picks" });
    await switchTab(page, "watchlist");

    const row = page.locator("#watchlistTab [data-watchlist-symbol='TST.NS']").first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    const watchlistTab = page.locator("#watchlistTab");
    await expect(watchlistTab.locator('[data-testid="decision-state"]').first()).toHaveText(
      "Research only",
    );
    await expect(watchlistTab).not.toContainText(/\bBUY\b|\bBUY action\b/i);

    await page.evaluate(() => window.toggleWatchlist("TST.NS", "Test Industries", "Industrials"));
    await expect.poll(() => requests.map((r) => r.action)).toContain("remove");

    await page.evaluate(() => window.toggleWatchlist("NEW.NS", "New Industries", "Industrials"));
    await expect.poll(() => requests.map((r) => r.action)).toContain("add");
  });
});
