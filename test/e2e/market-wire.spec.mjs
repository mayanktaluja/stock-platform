// E2E — Live Market Wire section on the Market Intelligence tab.
//
// The wire is the ranked, clustered, impact-tagged view of the Telegram newswire
// firehose (services/newsWire, served by /api/news/wire). It sits below the macro
// regime card and above the deterministic Market Digest, and self-hides when the
// feed is empty. All sibling endpoints are mocked so the tab renders
// deterministically; the wire fixture is the surface under test.

import { test, expect } from "@playwright/test";
import { gotoApp, switchTab } from "./helpers/app.mjs";

const nowIso = new Date().toISOString();
const j = (body) => (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

// Minimal deterministic mocks for the sibling sections so the tab renders without
// upstream flake. The wire route is set per-test.
async function mockSiblings(page) {
  await page.route("**/api/news/market", j({ lastUpdated: nowIso, digest: { marketMood: "mixed", moodSummary: "", keyTakeaways: [], bullishDrivers: [], bearishRisks: [], sectorsToWatch: [] } }));
  await page.route("**/api/macro/regime", j({ regime: "CALM", regimeLabel: "Calm", severity: 1, confidence: 0.8, classifierProvider: "groq", generatedAt: nowIso, reasoning: "", keyEvents: [], sectorImpacts: [] }));
  await page.route("**/api/catalysts/today", j({ schemaVersion: "catalysts-v1", fetchedAt: nowIso, stats: {}, sections: { inBook: [], inPicks: [], broader: [], macro: [] } }));
  await page.route("**/api/sector-heatmap", j({ sectors: [], marketBreadth: { totalStocks: 0, advancing: 0, declining: 0, unchanged: 0 }, lastUpdated: nowIso }));
  await page.route("**/api/index-intraday", j({ indices: [], lastUpdated: nowIso }));
  await page.route("**/api/sws-discovery-feed", j({ schema_version: "sws-discovery-feed-v1", generated_at: nowIso, stale: false, age_hours: 0.5, available: true, lanes: [], counts: { universe: 0, items: 0 }, items: [], sections: {} }));
}

const WIRE_FIXTURE = {
  schema_version: "news-wire-v1",
  generatedAt: nowIso,
  window_hours: 6,
  market_status: "CLOSED",
  counts: { messages: 5, clusters: 2, llm_calls: 1, cache_hits: 0, heuristic: 1, below_floor: 0 },
  items: [
    {
      id: "a", headline: "Fed cuts rates, markets rally on dovish Powell signal",
      direction: "bullish", heat_bucket: "high", confidence: 0.7, breaking: true, category: "markets",
      tickers: [], sectors: [{ sector: "Banking", impact: 2 }],
      why: "Corroborated across three wires; risk-on for equities.",
      source_count: 3,
      sources: [
        { channel: "FinancialJuice", url: "https://t.me/financialjuice/1", publishedAt: nowIso },
        { channel: "Walter Bloomberg", url: "https://t.me/WalterBloomberg/1", publishedAt: nowIso },
        { channel: "Insider Paper", url: "https://t.me/insiderpaper/1", publishedAt: nowIso },
      ],
      first_seen: nowIso, last_seen: nowIso, classifier_provider: "gemini", rank: 9.2,
    },
    {
      id: "b", headline: "Reliance jumps 4% on strong Q1 profit beat",
      direction: "bullish", heat_bucket: "med", confidence: 0.6, breaking: false, category: "india",
      tickers: ["RELIANCE"], sectors: [],
      why: "Single-source earnings beat.",
      source_count: 1,
      sources: [{ channel: "Moneycontrol", url: "https://t.me/moneycontrolcom/1", publishedAt: nowIso }],
      first_seen: nowIso, last_seen: nowIso, classifier_provider: "heuristic", rank: 4.1,
    },
  ],
};

test.describe("Live Market Wire", () => {
  test("teaser is collapsed by default and summarises the feed", async ({ page }) => {
    await mockSiblings(page);
    await page.route("**/api/news/wire", j(WIRE_FIXTURE));
    await gotoApp(page);
    await switchTab(page, "news");

    // `market-wire-section` is the OUTER wrapper, so it stays visible while the
    // <details> body is collapsed. The cards are in the DOM but not rendered.
    const section = page.getByTestId("market-wire-section");
    await expect(section).toBeVisible({ timeout: 10_000 });
    const details = page.getByTestId("market-wire-details");
    expect(await details.evaluate((el) => el.open)).toBe(false);
    await expect(details.locator("> summary")).toContainText(/1 high/);
    await expect(details.locator("> summary")).toContainText(/1 med/);
    await expect(details.locator("> summary")).toContainText(/1 breaking/);
    // Cards exist in the DOM even collapsed (that is what lets CSS filter them).
    await expect(page.getByTestId("market-wire-card")).toHaveCount(2);
    await expect(page.getByTestId("market-wire-card").first()).not.toBeVisible();
  });

  test("expanded: bucketed heat, source count, breaking + expandable why", async ({ page }) => {
    await mockSiblings(page);
    await page.route("**/api/news/wire", j(WIRE_FIXTURE));
    await gotoApp(page);
    await switchTab(page, "news");

    const section = page.getByTestId("market-wire-section");
    await expect(section).toBeVisible({ timeout: 10_000 });
    // A card inside a closed <details> has no bounding box, so every toBeVisible()
    // and .click() below requires the wrapper to be open first.
    await page.getByTestId("market-wire-details").locator("> summary").click();

    await expect(page.getByTestId("market-wire-card")).toHaveCount(2);

    const first = page.getByTestId("market-wire-card").first();
    await expect(first.getByTestId("market-wire-heat")).toContainText(/High/i);
    await expect(first.getByTestId("market-wire-source-chip")).toContainText("3 sources");
    await expect(first.getByTestId("market-wire-breaking")).toBeVisible();
    await expect(first).toContainText("FinancialJuice");
    await expect(first).toContainText("Fed cuts rates");

    // Honesty (D3): a bucketed heat label, never a raw 0-10 numeral anywhere.
    await expect(section).not.toContainText(/impact\s*[:=]\s*\d/i);

    const second = page.getByTestId("market-wire-card").nth(1);
    await expect(second.getByTestId("market-wire-heat")).toContainText(/Med/i);
    await expect(second.getByTestId("market-wire-source-chip")).toContainText("1 source");
    await expect(second).toContainText("RELIANCE");

    const why = first.getByTestId("market-wire-why");
    expect(await why.evaluate((el) => el.open)).toBe(false);
    await why.locator("summary").click();
    await expect(why).toContainText("Corroborated across three wires");
  });

  test("heat chips filter with pure CSS — no re-render, open cards survive", async ({ page }) => {
    await mockSiblings(page);
    await page.route("**/api/news/wire", j(WIRE_FIXTURE));
    await gotoApp(page);
    await switchTab(page, "news");
    await page.getByTestId("market-wire-details").locator("> summary").click();

    const cards = page.getByTestId("market-wire-card");
    // Default filter is High+Med, and the fixture is one of each: both show.
    await expect(cards.first()).toBeVisible();
    await expect(cards.nth(1)).toBeVisible();

    // Open a card's <details> and stamp a sentinel on the DOM node. If a chip click
    // re-rendered the list, both would be lost. That is the real contract.
    await cards.first().getByTestId("market-wire-why").locator("summary").click();
    await cards.first().evaluate((el) => { el.dataset.sentinel = "kept"; });

    await page.locator('[data-wire-chip="high"]').click();
    await expect(cards.first()).toBeVisible();
    await expect(cards.nth(1)).not.toBeVisible();          // the Med card is filtered out
    await expect(cards.first()).toHaveAttribute("data-sentinel", "kept");
    expect(await cards.first().getByTestId("market-wire-why").evaluate((el) => el.open)).toBe(true);

    await page.locator('[data-wire-chip="all"]').click();
    await expect(cards.nth(1)).toBeVisible();
  });

  test("wire sits BELOW the market digest", async ({ page }) => {
    await mockSiblings(page);
    await page.route("**/api/news/wire", j(WIRE_FIXTURE));
    await gotoApp(page);
    await switchTab(page, "news");
    await expect(page.getByTestId("market-wire-section")).toBeVisible({ timeout: 10_000 });

    const tops = await page.evaluate(() => {
      const top = (sel) => { const el = document.querySelector(sel); return el ? el.getBoundingClientRect().top : Number.NaN; };
      return {
        macro: top('[data-testid="market-macro-regime-card"]'),
        digest: top('[data-testid="market-digest-card"]'),
        wire: top('[data-testid="market-wire-section"]'),
      };
    });
    expect(tops.macro).toBeLessThan(tops.digest);
    expect(tops.digest).toBeLessThan(tops.wire);
  });

  test("self-hides the wire section when the feed is empty", async ({ page }) => {
    await mockSiblings(page);
    await page.route("**/api/news/wire", j({ schema_version: "news-wire-v1", generatedAt: null, items: [] }));

    await gotoApp(page);
    await switchTab(page, "news");

    // The tab still renders its other sections, but the wire section is absent.
    await expect(page.getByTestId("market-digest-card")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("market-wire-section")).toHaveCount(0);
  });
});
