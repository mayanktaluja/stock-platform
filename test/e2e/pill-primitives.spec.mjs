// Shared UI primitives — tonePill() + freshnessChip().
//
// The audit found six verdict colour systems and per-tab bespoke freshness
// display. PR4 introduces one tone vocabulary (reusing the .badge system) and
// one freshness chip, exposed on window so every surface can share them. This
// spec pins the primitives' contract directly (data-independent) plus the first
// adopter (the watchlist verdict pill).

import { test, expect } from "@playwright/test";
import { gotoApp, switchTab } from "./helpers/app.mjs";

test.describe("shared UI primitives", () => {
  test("tonePill maps verdicts to a single tone vocabulary", async ({ page }) => {
    await page.goto("/index.html", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof window.tonePill === "function");

    const out = await page.evaluate(() => {
      const html = (v) => window.tonePill(v.replace(/_/g, " "), {
        TOP_PICK: "gold", STRONG: "success", ACCEPTABLE: "info",
        WATCH: "neutral", AVOID: "danger",
      }[v] || "neutral");
      const cls = (s) => {
        const d = document.createElement("div"); d.innerHTML = s;
        return d.firstElementChild.className;
      };
      return {
        top: cls(html("TOP_PICK")),
        strong: cls(html("STRONG")),
        avoid: cls(html("AVOID")),
        // unknown tone falls back to neutral, never throws
        junk: cls(window.tonePill("X", "not-a-tone")),
        // label text preserved verbatim
        label: (() => { const d = document.createElement("div"); d.innerHTML = html("TOP_PICK"); return d.textContent; })(),
      };
    });

    expect(out.top).toContain("badge--gold");
    expect(out.strong).toContain("badge--success");
    expect(out.avoid).toContain("badge--danger");
    expect(out.junk).toContain("badge--neutral");
    expect(out.label).toBe("TOP PICK");
  });

  test("freshnessChip ages, flips to warn past the budget, and handles missing time", async ({ page }) => {
    await page.goto("/index.html", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof window.freshnessChip === "function");

    const out = await page.evaluate(() => {
      const parse = (s) => { const d = document.createElement("div"); d.innerHTML = s; return d.firstElementChild; };
      const now = new Date().toISOString();
      const old = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString(); // 5d
      const fresh = parse(window.freshnessChip(now, { staleHours: 48 }));
      const stale = parse(window.freshnessChip(old, { staleHours: 48 }));
      const missing = parse(window.freshnessChip(null));
      return {
        freshClass: fresh.className, freshAge: fresh.getAttribute("data-age-hours"),
        staleClass: stale.className, staleText: stale.textContent,
        missingClass: missing.className, missingText: missing.textContent,
      };
    });

    expect(out.freshClass).toContain("badge--success");
    expect(Number(out.freshAge)).toBeGreaterThanOrEqual(0);
    expect(out.staleClass).toContain("badge--warn");
    expect(out.staleText).toBe("5d");
    expect(out.missingClass).toContain("badge--neutral");
    expect(out.missingText).toBe("n/a");
  });

  test("the watchlist verdict pill uses the shared tone class", async ({ page }) => {
    const json = (route, body) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    const picksSummary = {
      sections: {
        top_ranked_30_v4: [
          { ticker: "TST", name: "Test Industries", sector: "Industrials", v4_verdict: "TOP_PICK", one_line: "Curated test row" },
        ],
      },
      scored_count: 1, failed_count: 0, currency: "INR",
      scanned_at: "2026-06-02T04:00:00.000Z",
      last_refresh: { finished_at: "2026-06-02T04:00:00.000Z" },
      shard_progress_api: [],
      scan_status_hint: { should_poll: false, in_progress_hint: false, panic_active: false },
    };
    const stocks = [{ symbol: "TST.NS", name: "Test Industries", sector: "Industrials", price: 120, change: 1.5, changePercent: 1.25, addedPrice: 110, addedAt: "2026-06-01T09:15:00.000Z" }];

    await page.route("**/api/sws-picks-summary", (route) => json(route, picksSummary));
    await page.route("**/api/sws-scan/status", (route) => json(route, { in_progress: false, all_complete: true, shards: [], total_done: 1 }));
    await page.route("**/api/market", (route) => json(route, { marketStatus: "OPEN", indices: [] }));
    await page.route("**/api/watchlist**", (route) => json(route, { stocks }));

    await gotoApp(page, { tab: "picks" });
    await switchTab(page, "watchlist");

    const star = page.locator("#watchlistTab [data-watchlist-symbol='TST.NS']").first();
    await expect(star).toBeVisible({ timeout: 10_000 });

    // The TOP_PICK verdict resolves to the shared gold tone (.badge--gold) with
    // its label preserved — same vocabulary any other surface would use.
    const pill = page.locator("#watchlistTab .wl-col-verdict .badge--gold").first();
    await expect(pill).toBeVisible();
    await expect(pill).toHaveText(/TOP PICK/i);
  });
});
