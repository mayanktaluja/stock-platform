// E2E — the dedicated Market Wire tab.
//
// EVERYTHING is scoped to #marketWireTab. The teaser on the Market Intelligence tab
// emits the same `market-wire-card` testid, and tab panels are display:none rather
// than removed — so once both surfaces have been visited, an unscoped selector
// matches twice.
//
// The two contracts worth having a test at all:
//   1. A chip click FILTERS WITHOUT RE-RENDERING. We stamp a sentinel onto a DOM node
//      and open a card's <details>; both must survive. That is what preserves scroll
//      position and open cards, and it is invisible to a screenshot.
//   2. The 2-min poll TEARS DOWN when you leave the tab. TAB_CONFIG has no onLeave
//      hook and the codebase has exactly one clearInterval line, so a leaked timer is
//      the default failure mode, not an exotic one.

import { test, expect } from "@playwright/test";
import { gotoApp, switchTab } from "./helpers/app.mjs";

const nowIso = new Date().toISOString();
const older = new Date(Date.now() - 30 * 60 * 1000).toISOString();

const item = (over) => ({
  id: "x", headline: "Something happened", direction: "neutral", heat_bucket: "low",
  confidence: 0.4, breaking: false, category: "markets", tickers: [], sectors: [],
  why: "because", source_count: 1,
  sources: [{ channel: "FinancialJuice", url: "https://t.me/financialjuice/1", publishedAt: nowIso }],
  first_seen: nowIso, last_seen: nowIso, classifier_provider: "heuristic", rank: 1, ...over,
});

const FEED_A = {
  schema_version: "news-wire-v1", generatedAt: nowIso, window_hours: 6, market_status: "CLOSED",
  counts: { messages: 5, clusters: 3, llm_calls: 1, cache_hits: 0, heuristic: 2, below_floor: 2 },
  items: [
    item({ id: "hi", headline: "Fed cuts rates, markets rally", heat_bucket: "high", breaking: true, direction: "bullish", source_count: 3, rank: 9,
      sources: [{ channel: "FinancialJuice", url: "https://t.me/a/1", publishedAt: nowIso }, { channel: "Walter Bloomberg", url: "https://t.me/b/1", publishedAt: nowIso }, { channel: "Clash Report", url: "https://t.me/c/1", publishedAt: nowIso }] }),
    item({ id: "md", headline: "Reliance jumps on Q1 beat", heat_bucket: "med", direction: "bullish", tickers: ["RELIANCE"], rank: 5, last_seen: older }),
    item({ id: "lo", headline: "Some quiet altcoin note", heat_bucket: "low", rank: 1, last_seen: older }),
  ],
};
// Same three stories plus one genuinely new id.
const FEED_B = { ...FEED_A, generatedAt: new Date().toISOString(), items: [item({ id: "new", headline: "Brand new breaking story", heat_bucket: "high", breaking: true, rank: 10 }), ...FEED_A.items] };

const json = (body) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

test.describe("Market Wire tab", () => {
  test("renders the full feed, defaults to High+Med, and hides low-heat cards", async ({ page }) => {
    await page.route("**/api/news/wire", (r) => r.fulfill(json(FEED_A)));
    await gotoApp(page);
    await switchTab(page, "marketWire");

    const panel = page.locator("#marketWireTab");
    await expect(panel.getByTestId("market-wire-full")).toBeVisible();
    // All three cards are in the DOM — CSS hides the low one, it is not sliced away.
    await expect(panel.getByTestId("market-wire-card")).toHaveCount(3);
    await expect(panel.locator('[data-wire-id="hi"]')).toBeVisible();
    await expect(panel.locator('[data-wire-id="md"]')).toBeVisible();
    await expect(panel.locator('[data-wire-id="lo"]')).not.toBeVisible();

    // Honesty (D3): bucketed heat only, never a raw 0-10 numeral.
    await expect(panel).not.toContainText(/impact\s*[:=]\s*\d/i);
    await expect(panel.locator('[data-wire-id="hi"]').getByTestId("market-wire-source-chip")).toContainText("3 sources");
  });

  test("[contract] chips filter with pure CSS — no re-render, scroll and open cards survive", async ({ page }) => {
    await page.route("**/api/news/wire", (r) => r.fulfill(json(FEED_A)));
    await gotoApp(page);
    await switchTab(page, "marketWire");
    const panel = page.locator("#marketWireTab");

    const hi = panel.locator('[data-wire-id="hi"]');
    await hi.getByTestId("market-wire-why").locator("> summary").click();
    await hi.evaluate((el) => { el.dataset.sentinel = "kept"; });

    await panel.locator('[data-wire-chip="high"]').click();
    await expect(panel.locator('[data-wire-id="md"]')).not.toBeVisible();
    // If the chip had re-rendered the list, both of these would be gone.
    await expect(hi).toHaveAttribute("data-sentinel", "kept");
    expect(await hi.getByTestId("market-wire-why").evaluate((el) => el.open)).toBe(true);

    await panel.locator('[data-wire-chip="all"]').click();
    await expect(panel.locator('[data-wire-id="lo"]')).toBeVisible();

    // Breaking-only is AND-ed with the heat filter.
    await panel.locator('[data-wire-toggle="breaking"]').click();
    await expect(panel.locator('[data-wire-id="hi"]')).toBeVisible();
    await expect(panel.locator('[data-wire-id="md"]')).not.toBeVisible();
  });

  test("empty filter combination shows an explicit empty state, not a blank box", async ({ page }) => {
    await page.route("**/api/news/wire", (r) => r.fulfill(json(FEED_A)));
    await gotoApp(page);
    await switchTab(page, "marketWire");
    const panel = page.locator("#marketWireTab");
    // Watchlist-only with no watchlisted tickers → zero matches.
    await panel.locator('[data-wire-toggle="watchlist"]').click();
    await expect(panel.locator(".wire-empty")).toBeVisible();
    await expect(panel.locator(".wire-empty")).toContainText(/No stories match/i);
  });

  test("empty feed renders an empty state rather than a blank tab", async ({ page }) => {
    await page.route("**/api/news/wire", (r) => r.fulfill(json({ schema_version: "news-wire-v1", generatedAt: null, items: [] })));
    await gotoApp(page);
    await switchTab(page, "marketWire");
    await expect(page.locator("#marketWireTab .empty-state")).toContainText(/No wire items/i);
  });

  test("[D4] a silent poll surfaces the pill and does NOT reorder the list until clicked", async ({ page }) => {
    await page.clock.install();
    let hits = 0;
    await page.route("**/api/news/wire", (r) => { hits += 1; return r.fulfill(json(hits === 1 ? FEED_A : FEED_B)); });

    await gotoApp(page);
    await switchTab(page, "marketWire");
    const panel = page.locator("#marketWireTab");
    await expect(panel.getByTestId("market-wire-card")).toHaveCount(3);
    await expect(panel.getByTestId("market-wire-new-pill")).toBeHidden();

    // Fire the 120s poll.
    await page.clock.fastForward("02:10");
    await expect.poll(() => hits).toBeGreaterThan(1);

    // The pill appears; the list has NOT changed under the reader.
    const pill = panel.getByTestId("market-wire-new-pill");
    await expect(pill).toBeVisible();
    await expect(pill).toContainText(/1 new story/);
    await expect(panel.getByTestId("market-wire-card")).toHaveCount(3);
    await expect(panel.locator('[data-wire-id="new"]')).toHaveCount(0);

    await pill.click();
    await expect(panel.locator('[data-wire-id="new"]')).toBeVisible();
    await expect(panel.getByTestId("market-wire-card")).toHaveCount(4);
    await expect(pill).toBeHidden();
  });

  test("[leak guard] the poll stops when you leave the tab", async ({ page }) => {
    await page.clock.install();
    let hits = 0;
    await page.route("**/api/news/wire", (r) => { hits += 1; return r.fulfill(json(FEED_A)); });

    await gotoApp(page);
    await switchTab(page, "marketWire");
    await expect(page.locator("#marketWireTab").getByTestId("market-wire-full")).toBeVisible();
    const afterEnter = hits;

    await switchTab(page, "track");
    // TAB_CONFIG has no onLeave hook; switchTab must clear the timer explicitly.
    await page.clock.fastForward("10:00");
    expect(hits, "no /api/news/wire requests may fire after leaving the tab").toBe(afterEnter);
  });

  test("deep-link #tab=marketWire lands directly on the tab", async ({ page }) => {
    await page.route("**/api/news/wire", (r) => r.fulfill(json(FEED_A)));
    await page.goto("/index.html#tab=marketWire", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof window.switchTab === "function", null, { timeout: 10_000 });
    await expect(page.locator("#marketWireTab")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#marketWireTabBtn")).toHaveAttribute("aria-selected", "true");
  });

  test("a ticker chip opens the stock modal", async ({ page }) => {
    await page.route("**/api/news/wire", (r) => r.fulfill(json(FEED_A)));
    await page.route("**/api/sws-stock/RELIANCE", (r) => r.fulfill(json({
      ticker: "RELIANCE",
      card: { ticker: "RELIANCE", name: "Reliance Industries", sector: "Oil & Gas", current_price_inr: 1400 },
      deep: { overview: { name: "Reliance Industries", sector: "Oil & Gas" } },
      returns_pct: {}, in_sections: [], currency: "INR",
    })));
    await gotoApp(page);
    await switchTab(page, "marketWire");
    await page.locator('#marketWireTab [data-wire-id="md"] .wire-tag--ticker').click();
    await expect(page.locator("#swsModalBackdrop.open")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#swsModalBackdrop")).toContainText("RELIANCE");
  });
});
