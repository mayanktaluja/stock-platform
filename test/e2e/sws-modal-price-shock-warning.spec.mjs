import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

const FRESH_TS = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const STALE_TS = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();

function swsStockPayload({
  ticker,
  name = "Warning Test Ltd",
  parsedAt = FRESH_TS,
  cardFreshnessAt = parsedAt,
  returnsPct,
  cardReturnsPct = returnsPct,
  auditInputs = {},
  score = 86,
  verdict = "TOP_PICK",
}) {
  const overview = {
    snowflake: {
      valuation: 5,
      future_growth: 5,
      past_performance: 5,
      financial_health: 5,
      dividends: 3,
    },
    snowflake_total: 23,
    current_price_inr: 490,
    fair_value_inr: 720,
    upside_pct: 46.9,
    market_cap_inr: 1200_00_00_000,
    returns_pct: returnsPct,
    multiples: { pe: 24.2 },
    rewards: [],
    risks: [],
  };
  return {
    ticker,
    deep: {
      ticker,
      name,
      sector: "Healthcare",
      parsed_at: parsedAt,
      sws_url: "https://simplywall.st/stocks/in/healthcare/warning",
      overview,
    },
    card: {
      ticker,
      name,
      sector: "Healthcare",
      v4_score_100: score,
      v4_verdict: verdict,
      composite_verdict: verdict,
      current_price_inr: 490,
      fair_value_inr: 720,
      upside_pct: 46.9,
      market_cap_inr: 1200_00_00_000,
      snowflake: overview.snowflake,
      snowflake_total: overview.snowflake_total,
      returns_pct: cardReturnsPct,
      data_freshness_at: cardFreshnessAt,
      audit_trail: { inputs_used: auditInputs },
      v4_breakdown: {
        pts_health: 20,
        pts_future: 18,
        pts_valuation: 17,
        pts_past: 14,
        pts_fv_total: 10,
        pts_mom_1y: 5,
        pts_mom_3m: 2,
        pts_mom_1m: 1,
        pts_overlay: 0,
      },
    },
    surveillance: null,
    file_mtime: parsedAt,
    section_memberships: ["top_ranked_30_v3"],
    fundamentals_fallback: null,
  };
}

async function mockSwsStock(page, payload) {
  await page.route(`**/api/sws-stock/${payload.ticker}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(payload),
    }),
  );
  await page.route(`**/api/track/history?symbol=${payload.ticker}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ trades: [] }),
    }),
  );
}

async function openMockModal(page, payload) {
  await mockSwsStock(page, payload);
  await gotoApp(page, { tab: "picks" });
  await page.evaluate((ticker) => window.openSwsModal(ticker), payload.ticker);
  await expect(page.locator("#swsModalBody .sws-modal-hero")).toBeVisible({ timeout: 10_000 });
}

test.describe("SWS modal price-shock warning", () => {
  test("shows a fresh price-shock warning without changing the v4 score/verdict", async ({ page }) => {
    await openMockModal(page, swsStockPayload({
      ticker: "SHOCKTEST",
      returnsPct: { "1D": -19.96, "7D": -22.52, "1M": -27.07, "3M": 4.4, "1Y": 18.5 },
    }));

    const body = page.locator("#swsModalBody");
    const warning = body.getByTestId("sws-modal-event-warning");
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("Fresh price shock");
    await expect(warning).toContainText("Fundamentals and V4 score are unchanged");
    await expect(warning).toContainText("buying today has elevated price-discovery risk");
    await expect(warning).toContainText("consider waiting for confirmation before adding");

    await expect(body.locator(".sws-modal-score")).toContainText("86.0");
    await expect(body.locator(".sws-modal-score")).toContainText("TOP PICK");
    await expect(body).not.toContainText("Event cap");
  });

  test("does not warn for stale SWS return buckets", async ({ page }) => {
    await openMockModal(page, swsStockPayload({
      ticker: "STALESHOCK",
      parsedAt: STALE_TS,
      returnsPct: { "1D": -19.96, "7D": -22.52, "1M": -27.07, "3M": 4.4, "1Y": 18.5 },
    }));

    await expect(page.locator("#swsModalBody").getByTestId("sws-modal-event-warning")).toHaveCount(0);
  });

  test("does not warn from audit-trail-only return fallbacks", async ({ page }) => {
    await openMockModal(page, swsStockPayload({
      ticker: "AUDITONLY",
      returnsPct: { "1D": -1.1, "7D": -2.2, "1M": -3.3, "3M": 4.4, "1Y": 18.5 },
      auditInputs: { returns_1d: -19.96, returns_7d: -22.52, returns_1m: -27.07 },
    }));

    await expect(page.locator("#swsModalBody").getByTestId("sws-modal-event-warning")).toHaveCount(0);
  });

  test("can warn from fresh card buckets when older deep buckets are calm", async ({ page }) => {
    await openMockModal(page, swsStockPayload({
      ticker: "CARDFRESH",
      parsedAt: STALE_TS,
      cardFreshnessAt: FRESH_TS,
      returnsPct: { "1D": -1.1, "7D": -2.2, "1M": -3.3, "3M": 4.4, "1Y": 18.5 },
      cardReturnsPct: { "1D": -19.96, "7D": -22.52, "1M": -27.07, "3M": 4.4, "1Y": 18.5 },
    }));

    await expect(page.locator("#swsModalBody").getByTestId("sws-modal-event-warning")).toBeVisible();
  });
});
