// Watchlist mobile ergonomics.
//
// The watchlist is a 7-column table with a 780px min-width — on a phone that
// would force horizontal scroll. The ≤480px collapse keeps Stock + Verdict +
// Day Change and drops Price / Since Added (their values stay reachable in the
// per-row detail drawer). This spec locks that: at 375px the page must not
// scroll sideways, and the identity column stays readable.

import { test, expect } from "@playwright/test";
import { gotoApp, switchTab } from "./helpers/app.mjs";

const json = (route, body) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

const picksSummary = {
  sections: { top_ranked_30_v4: [{ ticker: "TST", name: "Test Industries", sector: "Industrials", v4_verdict: "STRONG", one_line: "row" }] },
  scored_count: 1, failed_count: 0, currency: "INR", scanned_at: "2026-06-02T04:00:00.000Z",
  last_refresh: { finished_at: "2026-06-02T04:00:00.000Z" }, shard_progress_api: [],
  scan_status_hint: { should_poll: false, in_progress_hint: false, panic_active: false },
};
const stocks = [{ symbol: "TST.NS", name: "Test Industries Limited", sector: "Industrials", price: 120, change: 1.5, changePercent: 1.25, addedPrice: 110, addedAt: "2026-06-01T09:15:00.000Z" }];

test.describe("watchlist mobile", () => {
  test("no horizontal page overflow at 375px; identity column stays visible", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const page = await ctx.newPage();

    await page.route("**/api/sws-picks-summary", (route) => json(route, picksSummary));
    await page.route("**/api/sws-scan/status", (route) => json(route, { in_progress: false, all_complete: true, shards: [], total_done: 1 }));
    await page.route("**/api/market", (route) => json(route, { marketStatus: "OPEN", indices: [] }));
    await page.route("**/api/watchlist**", (route) => json(route, { stocks }));

    await gotoApp(page, { tab: "picks" });
    await switchTab(page, "watchlist");

    const stock = page.locator("#watchlistTab .wl-col-stock").first();
    await expect(stock).toBeVisible({ timeout: 10_000 });
    await expect(stock).toContainText("TST");

    // Price / Since columns collapse on a phone (values live in the drawer).
    await expect(page.locator("#watchlistTab .wl-col-price").first()).toBeHidden();
    await expect(page.locator("#watchlistTab .wl-col-since").first()).toBeHidden();

    // The document must not scroll sideways (allow 1px rounding slack).
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    await ctx.close();
  });
});
