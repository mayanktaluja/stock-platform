import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

const ALL_ITEMS = [
  {
    stable_id: "stub-1",
    provider: "stockinsights",
    source_market: "india",
    source_kind: "corporate_announcement",
    ticker: "RELIANCE",
    company_name: "Reliance Industries",
    category: "Credit Rating",
    sentiment: "negative",
    summary: "Rating action filed with debt-cost implications.",
    source_url: "https://bse.test/reliance",
    published_at: "2026-06-21T02:00:00.000Z",
    provider_lag_minutes: 18,
    age_minutes: 45,
    materiality: "high",
    why_it_matters: "Credit or compliance risk",
    in_portfolio: true,
    in_watchlist: false,
  },
  {
    stable_id: "stub-2",
    provider: "stockinsights",
    source_market: "us",
    source_kind: "sec_filing",
    ticker: "MSFT",
    company_name: "Microsoft",
    category: "8-K",
    sentiment: "neutral",
    summary: "Current report filed with event details.",
    source_url: "https://sec.test/msft",
    published_at: "2026-06-21T01:30:00.000Z",
    provider_lag_minutes: 60,
    age_minutes: 80,
    materiality: "medium",
    why_it_matters: "Fresh exchange filing",
    in_portfolio: false,
    in_watchlist: true,
  },
];

function payloadFor(url) {
  const parsed = new URL(url);
  let items = ALL_ITEMS;
  const sentiment = parsed.searchParams.get("sentiment");
  const ticker = parsed.searchParams.get("ticker");
  const source = parsed.searchParams.get("source");
  if (sentiment) items = items.filter((item) => item.sentiment === sentiment);
  if (ticker) {
    const needle = ticker.toUpperCase();
    items = items.filter((item) => `${item.ticker} ${item.company_name}`.toUpperCase().includes(needle));
  }
  if (source) items = items.filter((item) => item.source_market === source);
  return {
    schema_version: "market-information-v1",
    title: "Market Radar",
    description: "Fast market-moving filings and announcements. Informational evidence only, not a recommendation.",
    generated_at: "2026-06-20T00:00:00.000Z",
    runtime_audit: {
      generated_at: "2026-06-20T00:00:00.000Z",
      age_hours: 30,
      stale: true,
      stale_threshold_hours: 12,
      provider: "stockinsights",
      mode: "manual_cached",
    },
    stats: {
      total: items.length,
      material: items.filter((item) => item.materiality === "high").length,
      negative: items.filter((item) => item.sentiment === "negative").length,
      portfolio_watchlist: items.filter((item) => item.in_portfolio || item.in_watchlist).length,
      us_sec_filings: items.filter((item) => item.source_market === "us").length,
    },
    sections: {
      breaking_filings: items,
      portfolio_watchlist: items.filter((item) => item.in_portfolio || item.in_watchlist),
      negative_or_material: items.filter((item) => item.sentiment === "negative" || item.materiality === "high"),
      results_earnings: [],
      us_sec_filings: items.filter((item) => item.source_market === "us"),
    },
  };
}

test.describe("Market Radar renderer", () => {
  test("renders rows, filters, stale banner, and conservative row wording", async ({ page }) => {
    await page.route("**/api/market-information/latest**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(payloadFor(route.request().url())),
      }),
    );

    await gotoApp(page, { tab: "marketInformation" });
    await expect(page.locator("[data-testid='market-information-card']")).toHaveCount(6, { timeout: 10_000 });
    await expect(page.locator("#marketInformationStatusBanner")).toContainText("stale");
    await expect(page.locator("#marketInformationContainer")).toContainText("RELIANCE");
    await expect(page.locator("#marketInformationContainer")).toContainText("US SEC filings");

    const firstCardText = await page.locator("[data-testid='market-information-card']").first().textContent();
    expect(firstCardText).not.toMatch(/\b(BUY|SELL|TRIM|TOP-UP)\b/i);

    await page.locator("#marketInformationSearch").fill("MSFT");
    await expect(page.locator("[data-testid='market-information-card']").first()).toContainText("MSFT", { timeout: 10_000 });
    await expect(page.locator("#marketInformationContainer")).not.toContainText("RELIANCE");

    await page.locator("#marketInformationSearch").fill("");
    await page.locator("#marketInformationSentiment").selectOption("negative");
    await expect(page.locator("[data-testid='market-information-card']").first()).toContainText("RELIANCE", { timeout: 10_000 });
    await expect(page.locator("#marketInformationContainer")).not.toContainText("MSFT");
  });
});
