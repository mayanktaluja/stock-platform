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
  test("renders ranked wire cards with bucketed heat, source count, breaking + expandable why", async ({ page }) => {
    await mockSiblings(page);
    await page.route("**/api/news/wire", j(WIRE_FIXTURE));

    await gotoApp(page);
    await switchTab(page, "news");

    const section = page.getByTestId("market-wire-section");
    await expect(section).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("market-wire-card")).toHaveCount(2);

    // First card: high heat, breaking, 3 sources, channel names shown.
    const first = page.getByTestId("market-wire-card").first();
    await expect(first.getByTestId("market-wire-heat")).toContainText(/High/i);
    await expect(first.getByTestId("market-wire-source-chip")).toContainText("3 sources");
    await expect(first.getByTestId("market-wire-breaking")).toBeVisible();
    await expect(first).toContainText("FinancialJuice");
    await expect(first).toContainText("Fed cuts rates");

    // Honesty (D3): a bucketed heat label, never a raw 0-10 numeral on the card.
    await expect(section).not.toContainText(/impact\s*[:=]\s*\d/i);

    // Second card: medium heat, single source, ticker tag.
    const second = page.getByTestId("market-wire-card").nth(1);
    await expect(second.getByTestId("market-wire-heat")).toContainText(/Med/i);
    await expect(second.getByTestId("market-wire-source-chip")).toContainText("1 source");
    await expect(second).toContainText("RELIANCE");

    // Expand the first card's "Why & sources".
    const why = first.getByTestId("market-wire-why");
    expect(await why.evaluate((el) => el.open)).toBe(false);
    await why.locator("summary").click();
    await expect(why).toContainText("Corroborated across three wires");

    // Position: wire sits below the macro regime card and above the digest.
    const tops = await page.evaluate(() => {
      const top = (sel) => { const el = document.querySelector(sel); return el ? el.getBoundingClientRect().top : Number.NaN; };
      return {
        macro: top('[data-testid="market-macro-regime-card"]'),
        wire: top('[data-testid="market-wire-section"]'),
        digest: top('[data-testid="market-digest-card"]'),
      };
    });
    expect(tops.macro).toBeLessThan(tops.wire);
    expect(tops.wire).toBeLessThan(tops.digest);
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
