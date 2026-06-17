// E2E test 0.5 — Stock detail modal opens AND renders real ticker data.
//
// Pre-2026-05-16: this spec only asserted that the modal backdrop got the
// `.open` class and that #swsModalTitle had non-empty text. A modal that
// opened with the title-bar populated but a silently-empty body (e.g.
// renderSwsModal returning early because the SWS payload was malformed,
// or the .sws-modal-score / .sws-modal-section blocks failing to render)
// would pass that gate. The 2026-05-16 audit flagged this as a High-tier
// silent-failure risk: the stock-detail modal is the most-used interactive
// surface in the SPA, opened from 15+ entry points.
//
// This hardened spec adds two structural assertions on top of the original
// open/close lifecycle test:
//   - .sws-modal-hero must render (the SWS payload reached the renderer)
//   - At least one .sws-modal-section must render (the body is populated,
//     not just the hero stub)
// The .sws-modal-score check is best-effort — score is hidden for
// limited-data live-only fallbacks (renderSwsModal v2 path) so its
// absence is not a regression.

import { test, expect } from "@playwright/test";
import { gotoApp, waitForPicksLoaded } from "./helpers/app.mjs";

async function mockThinSwsStock(page, dataQuality, overrides = {}) {
  const ticker = overrides.ticker || "THINTEST";
  const name = overrides.name || "Thin Test Ltd";
  const sector = overrides.sector || "Test";
  const overview = {
    snowflake: { valuation: 4, future_growth: 0, future: 0, past_performance: 3, past: 3, financial_health: 5, dividends: 2 },
    snowflake_total: 14,
    current_price_inr: 100,
    fair_value_inr: 125,
    upside_pct: 25,
    market_cap_inr: 1000_00_00_000,
    returns_pct: { "1D": 1.1, "7D": 2.2, "1M": 3.3, "3M": 4.4, "1Y": 5.5 },
    multiples: { pe: 22 },
    rewards: [],
    risks: [],
  };
  Object.assign(overview, overrides.overview || {});
  if (dataQuality !== undefined) overview.snowflake_data_quality = dataQuality;
  await page.route(`**/api/sws-stock/${ticker}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ticker,
        deep: {
          ticker,
          name,
          sector,
          parsed_at: "2026-05-26T00:00:00.000Z",
          sws_url: "https://simplywall.st/stocks/in/test/thintest",
          overview,
        },
        card: {
          ticker,
          name,
          sector,
          v4_score_100: 41,
          v4_verdict: "ACCEPTABLE",
          composite_verdict: "ACCEPTABLE",
          current_price_inr: 100,
          fair_value_inr: 125,
          upside_pct: 25,
          market_cap_inr: 1000_00_00_000,
          snowflake: overview.snowflake,
          snowflake_total: overview.snowflake_total,
          v4_breakdown: {
            pts_health: 18,
            pts_future: 0,
            pts_valuation: 12,
            pts_past: 8,
            pts_fv_total: 8,
            pts_mom_1y: 3.5,
            pts_mom_3m: 1.5,
            pts_mom_1m: 1,
            pts_overlay: 0,
            fv_imputed: false,
            momentum_imputed: true,
          },
          ...(overrides.card || {}),
        },
        surveillance: null,
        file_mtime: "2026-05-26T00:00:00.000Z",
        section_memberships: overrides.section_memberships || ["top_ranked_30_v3"],
        fundamentals_fallback: null,
        experimental_forecast_overlay: overrides.experimental_forecast_overlay || null,
      }),
    }),
  );
}

test.describe("Stock detail modal (SWS)", () => {
  test("/api/sws-picks cards do not carry per-stock Snowflake data-quality metadata", async ({ request }) => {
    const res = await request.get("/api/sws-picks?limit=1");
    test.skip(!res.ok(), "/api/sws-picks unavailable in this fixture");
    const body = await res.json();
    const buckets = Object.values(body?.sections || {}).filter(Array.isArray);
    test.skip(buckets.length === 0, "no SWS picks sections available in this fixture");
    for (const bucket of buckets) {
      for (const card of bucket) {
        expect(card).not.toHaveProperty("snowflake_data_quality");
        expect(card).not.toHaveProperty("snowflake_check_matrix");
        expect(card?.overview).toBeUndefined();
        expect(card?.audit_trail?.inputs_used?.snowflake_data_quality).toBeUndefined();
        expect(card?.audit_trail?.inputs_used?.snowflake_check_matrix).toBeUndefined();
      }
    }
  });

  test("clicking a pick card opens, populates body sections, and Escape closes", async ({ page }) => {
    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    const firstCard = page.locator(".sws-pick-card").first();
    await firstCard.click();

    const backdrop = page.locator("#swsModalBackdrop");
    await expect(backdrop).toHaveClass(/open/, { timeout: 5_000 });

    // Title appears once the per-stock fetch resolves and renderSwsModal
    // has stamped the hero. Original guard.
    const title = page.locator("#swsModalTitle");
    await expect(title).toBeVisible({ timeout: 15_000 });
    const titleText = (await title.innerText()).trim();
    expect(titleText.length, "#swsModalTitle must render ticker text").toBeGreaterThan(0);
    const summary = page.getByTestId("sws-modal-decision-summary");
    await expect(summary).toBeVisible({ timeout: 10_000 });
    await expect(summary).toContainText(/Decision context/i);
    await expect(summary).toContainText(/What must be true/i);
    await expect(summary).toContainText(/What can break it/i);
    await expect(summary).toContainText(/risk backdrop/i);
    await expect(summary).toContainText(/sector context/i);
    await expect(summary).toContainText(/your exposure context/i);
    await expect(summary).not.toContainText(/confirmed by/i);

    // Hero section structural anchor — present whether the renderer took
    // the rich SWS path or the limited-data live-only fallback.
    const hero = page.locator("#swsModalBody .sws-modal-hero");
    await expect(hero, "#swsModalBody must contain .sws-modal-hero").toBeVisible({ timeout: 5_000 });

    // Body must have at least one .sws-modal-section. The rich-data render
    // produces 5+ sections (snowflake, rewards, risks, news, valuation);
    // the limited-data fallback still emits at least the live-quote
    // section. A modal with hero-only and no body sections is a silent
    // render bug — exactly what this hardening guards against.
    const sectionCount = await page.locator("#swsModalBody .sws-modal-section").count();
    expect(
      sectionCount,
      "#swsModalBody must render at least one .sws-modal-section (zero = silent renderer failure)"
    ).toBeGreaterThan(0);

    // Escape closes — original guard.
    await page.keyboard.press("Escape");
    await expect(backdrop).not.toHaveClass(/open/, { timeout: 5_000 });
  });

  test("renders Snowflake insufficient-data warning only when metadata explicitly flags it", async ({ page }) => {
    await mockThinSwsStock(page, {
      insufficient: true,
      insufficient_count: 2,
      checked_count: 30,
      affected_pillars: ["Future", "Value"],
      by_pillar: {
        Future: { checked: 6, insufficient: 1 },
        Value: { checked: 6, insufficient: 1 },
      },
      samples: [
        { pillar: "Future", title: "Revenue vs Market", reason_code: "OUTCOME_NULL" },
        { pillar: "Value", title: "PEG Ratio", reason_code: "OUTCOME_NULL" },
      ],
    });
    await gotoApp(page, { tab: "picks" });
    await page.evaluate(() => window.openSwsModal("THINTEST"));

    const body = page.locator("#swsModalBody");
    await expect(body.locator(".sws-modal-hero")).toBeVisible({ timeout: 10_000 });
    const warning = body.locator('[data-testid="sws-snowflake-data-warning"]');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("SWS data warning");
    await expect(warning).toContainText("2 of 30 SWS checks");
    await expect(warning).toContainText("Future, Value");
    await expect(warning).toContainText("Unavailable by section: Future 1 unavailable source check · Value 1 unavailable source check");
    await expect(warning).toContainText("Snowflake score below is separate from source-data availability");
    await expect(warning).toContainText("Examples: Future: Revenue vs Market");
    await expect(warning).toContainText("Revenue vs Market");
  });

  test("renders experimental forecast overlay without changing the V4 score", async ({ page }) => {
    await mockThinSwsStock(page, undefined, {
      ticker: "CHRONOSTEST",
      experimental_forecast_overlay: {
        ticker: "CHRONOSTEST",
        yahoo_symbol: "CHRONOSTEST.NS",
        generated_at: "2026-06-06T01:30:00.000Z",
        selected_model_id: "amazon/chronos-2",
        input: { bar_count: 600, last_close: 100, frequency: "1d_trading_sessions" },
        horizons: {
          "1D": { trading_sessions: 1, median_price: 101, q10_price: 95, q90_price: 104, median_return_pct: 1, q10_return_pct: -5, q90_return_pct: 4 },
          "7D": { trading_sessions: 5, median_price: 102, q10_price: 92, q90_price: 108, median_return_pct: 2, q10_return_pct: -8, q90_return_pct: 8 },
          "30D": { trading_sessions: 21, median_price: 103, q10_price: 88, q90_price: 116, median_return_pct: 3, q10_return_pct: -12, q90_return_pct: 16 },
          "3M": { trading_sessions: 63, median_price: 105, q10_price: 80, q90_price: 130, median_return_pct: 5, q10_return_pct: -20, q90_return_pct: 30 },
          "1Y": { trading_sessions: 252, median_price: 118, q10_price: 55, q90_price: 210, median_return_pct: 18, q10_return_pct: -45, q90_return_pct: 110 },
          "3Y": { trading_sessions: 756, median_price: 120, q10_price: 20, q90_price: 310, median_return_pct: 20, q10_return_pct: -80, q90_return_pct: 210 },
        },
        interpretation: {
          label: "Long-term positive skew / very high uncertainty",
          read: "Use tranche entry; do not chase.",
          signal_strength: "LOW",
        },
      },
    });
    await gotoApp(page, { tab: "picks" });
    await page.evaluate(() => window.openSwsModal("CHRONOSTEST"));

    const body = page.locator("#swsModalBody");
    await expect(body.locator(".sws-modal-hero")).toBeVisible({ timeout: 10_000 });
    await expect(body.locator(".sws-modal-score .score-value")).toHaveText("41.0");
    const overlay = body.locator('[data-testid="sws-modal-forecast-overlay"]');
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText("Experimental forecast context");
    await expect(overlay).toContainText("Long-term positive skew");
    await expect(overlay).toContainText("Does not change Starbhai score or analyzer action");
    await expect(overlay.locator('[data-horizon-days="1"]')).toHaveCount(0);
    await expect(overlay.locator('[data-horizon-days="5"]')).toContainText("+2.0%");
    await expect(overlay.locator('[data-horizon-days="21"]')).toContainText("+3.0%");
    await expect(overlay.locator('[data-horizon-days="63"]')).toContainText("+5.0%");
    await expect(overlay.locator('[data-horizon-days="252"]')).toContainText("+18.0%");
    await expect(overlay.locator('[data-horizon-days="756"]')).toHaveCount(0);
  });

  test("does not render experimental forecast overlay when API omits it", async ({ page }) => {
    await mockThinSwsStock(page, undefined, { ticker: "NOFORECAST" });
    await gotoApp(page, { tab: "picks" });
    await page.evaluate(() => window.openSwsModal("NOFORECAST"));
    const body = page.locator("#swsModalBody");
    await expect(body.locator(".sws-modal-hero")).toBeVisible({ timeout: 10_000 });
    await expect(body.locator('[data-testid="sws-modal-forecast-overlay"]')).toHaveCount(0);
  });

  test("groups complete Snowflake missing-check names when matrix metadata is present", async ({ page }) => {
    await mockThinSwsStock(page, {
      insufficient: true,
      insufficient_count: 3,
      checked_count: 30,
      affected_pillars: ["Future", "Value"],
      by_pillar: {
        Future: { checked: 6, insufficient: 2 },
        Value: { checked: 6, insufficient: 1 },
      },
      samples: [
        { pillar: "Future", title: "Revenue vs Market", reason_code: "OUTCOME_NULL" },
      ],
    }, {
      ticker: "MATRIXTEST",
      overview: {
        snowflake_check_matrix: {
          version: "sws-visible-snowflake-checks-v1",
          checked_count: 30,
          checks: [
            { pillar: "Future", title: "Revenue vs Market", insufficient: true },
            { pillar: "Future", title: "Earnings vs Market", insufficient: true },
            { pillar: "Value", title: "PEG Ratio", insufficient: true },
            { pillar: "Past", title: "Past Earnings Growth", insufficient: false },
          ],
        },
      },
    });
    await gotoApp(page, { tab: "picks" });
    await page.evaluate(() => window.openSwsModal("MATRIXTEST"));

    const warning = page.locator("#swsModalBody").locator('[data-testid="sws-snowflake-data-warning"]');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("Unavailable by section: Future 2 unavailable source checks · Value 1 unavailable source check");
    await expect(warning).toContainText("Missing checks: Future: Revenue vs Market, Earnings vs Market · Value: PEG Ratio");
    await expect(warning).not.toContainText("Examples:");
  });

  test("renders Snowflake Gap Lab comparison as subordinate to canonical V4", async ({ page }) => {
    await mockThinSwsStock(page, undefined, {
      section_memberships: ["snowflake_gap_lab"],
      card: {
        snowflake_gap_lab: {
          label: "Experimental shadow V4",
          caveat: "For review, not a recommendation. Canonical V4 remains the source of record.",
          canonical_v4_score_100: 41,
          canonical_v4_verdict: "ACCEPTABLE",
          shadow_v4_score_100: 53,
          shadow_v4_verdict: "STRONG",
          score_delta: 12,
          affected_pillars: ["future", "valuation"],
          imputed_checks_count: 3,
          peer_label: "Capital Goods",
          market_cap_bucket: "micro",
          imputed_checks: [
            { title: "Future ROE", peer_pass_rate: 0.6, peer_count: 12 },
            { title: "PEG Ratio", peer_pass_rate: 0.5, peer_count: 10 },
          ],
        },
      },
    });
    await gotoApp(page, { tab: "picks" });
    await page.evaluate(() => window.openSwsModal("THINTEST"));

    const body = page.locator("#swsModalBody");
    await expect(body.locator(".sws-modal-score")).toContainText("41.0");
    const lab = body.locator('[data-testid="sws-snowflake-gap-lab"]');
    await expect(lab).toBeVisible();
    await expect(lab).toContainText("Experimental shadow V4");
    await expect(lab).toContainText("Canonical V4 remains the source of record");
    await expect(lab).toContainText("For review, not a recommendation");
    await expect(lab).toContainText("53.0");
    await expect(lab).toContainText("Future ROE");
  });

  test("renders Snowflake warning alongside Gap Lab when deep metadata flags insufficient checks", async ({ page }) => {
    await mockThinSwsStock(page, {
      insufficient: true,
      insufficient_count: 6,
      checked_count: 30,
      affected_pillars: ["Value", "Future"],
      by_pillar: {
        Value: { checked: 6, insufficient: 1 },
        Future: { checked: 6, insufficient: 5 },
      },
      samples: [
        { pillar: "Value", title: "PEG Ratio", reason_code: "OUTCOME_NULL" },
        { pillar: "Future", title: "High Growth Earnings", reason_code: "OUTCOME_NULL" },
        { pillar: "Future", title: "Earnings vs Market", reason_code: "OUTCOME_NULL" },
      ],
    }, {
      ticker: "TIMETECHNO",
      name: "Time Technoplast Limited",
      sector: "Materials",
      section_memberships: ["snowflake_gap_lab"],
      overview: {
        snowflake_check_matrix: null,
      },
      card: {
        v4_score_100: 65.7,
        v4_verdict: "TOP_PICK",
        composite_verdict: "TOP_PICK",
        snowflake_gap_lab: {
          label: "Experimental shadow V4",
          caveat: "For review, not a recommendation. Canonical V4 remains the source of record.",
          canonical_v4_score_100: 65.7,
          canonical_v4_verdict: "TOP_PICK",
          shadow_v4_score_100: 75,
          shadow_v4_verdict: "TOP_PICK",
          score_delta: 9.3,
          affected_pillars: ["valuation", "future"],
          imputed_checks_count: 6,
          peer_label: "Materials",
          market_cap_bucket: "midsmall4",
          imputed_checks: [
            { title: "PEG Ratio", peer_pass_rate: 0, peer_count: 9 },
            { title: "High Growth Earnings", peer_pass_rate: 0.556, peer_count: 9 },
            { title: "Earnings vs Market", peer_pass_rate: 0.667, peer_count: 9 },
          ],
        },
      },
    });
    await gotoApp(page, { tab: "picks" });
    await page.evaluate(() => window.openSwsModal("TIMETECHNO"));

    const body = page.locator("#swsModalBody");
    await expect(body.locator(".sws-modal-score")).toContainText("65.7");
    await expect(body.locator(".sws-modal-score")).not.toContainText("75.0");

    const warning = body.locator('[data-testid="sws-snowflake-data-warning"]');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("SWS data warning");
    await expect(warning).toContainText("6 of 30 SWS checks");
    await expect(warning).toContainText("Value, Future");
    await expect(warning).toContainText("Unavailable by section: Value 1 unavailable source check · Future 5 unavailable source checks");
    await expect(warning).toContainText("Snowflake score below is separate from source-data availability");
    await expect(warning).not.toContainText("Future 5/6");
    await expect(warning).toContainText("Examples: Value: PEG Ratio");
    await expect(warning).toContainText("High Growth Earnings");

    const lab = body.locator('[data-testid="sws-snowflake-gap-lab"]');
    await expect(lab).toBeVisible();
    await expect(lab).toContainText("Canonical V4 remains the source of record");
    await expect(lab).toContainText("75.0");
    await expect(lab).toContainText("High Growth Earnings");
  });

  test("section membership chips in the stock modal expose scroll controls", async ({ page }) => {
    await mockThinSwsStock(page, undefined, {
      section_memberships: [
        "top_ranked_30_v3",
        "best_to_buy_now",
        "deep_value",
        "quality_growth",
        "best_fundamentals",
        "midterm",
        "dividend_aristocrats",
        "smallcap_gems",
        "upcoming_earnings",
      ],
    });
    await page.setViewportSize({ width: 390, height: 812 });
    await gotoApp(page, { tab: "picks" });
    await page.evaluate(() => window.openSwsModal("THINTEST"));

    const body = page.locator("#swsModalBody");
    await expect(body.locator(".sws-modal-hero")).toBeVisible({ timeout: 10_000 });
    const rail = body.locator(".sws-modal-section-chips");
    const right = body.locator('.sws-modal-section-rail [data-scroll-dir="right"]');
    await expect(right).toBeVisible({ timeout: 5_000 });
    const before = await rail.evaluate((el) => el.scrollLeft);
    await right.click();
    await expect.poll(() => rail.evaluate((el) => el.scrollLeft)).toBeGreaterThan(before);
  });

  test("does not render Snowflake warning for old deep files or non-insufficient metadata", async ({ page }) => {
    await mockThinSwsStock(page, undefined);
    await gotoApp(page, { tab: "picks" });
    await page.evaluate(() => window.openSwsModal("THINTEST"));
    const body = page.locator("#swsModalBody");
    await expect(body.locator(".sws-modal-hero")).toBeVisible({ timeout: 10_000 });
    await expect(body.locator('[data-testid="sws-snowflake-data-warning"]')).toHaveCount(0);

    await page.unroute("**/api/sws-stock/THINTEST");
    await mockThinSwsStock(page, { insufficient: false, insufficient_count: 0, checked_count: 30, affected_pillars: [] });
    await page.evaluate(() => window.openSwsModal("THINTEST"));
    await expect(body.locator(".sws-modal-hero")).toBeVisible({ timeout: 10_000 });
    await expect(body.locator('[data-testid="sws-snowflake-data-warning"]')).toHaveCount(0);
  });

  test("renders raw zero and negative own P/E values in stock modal", async ({ page }) => {
    await mockThinSwsStock(page, undefined, {
      ticker: "PENEG",
      name: "Negative P/E Ltd",
      overview: {
        multiples: { pe: -12.3 },
        industry_benchmarks: { pe: 20 },
        pe_benchmark_source: { provider: "groww_refinitiv", label: "Groww/Refinitiv", industry_name: "Test", industry_pe: 20, company_pe: -12.3 },
        multiples_meta: { pe_source: "groww_refinitiv", pe_source_label: "Groww/Refinitiv" },
      },
    });
    await mockThinSwsStock(page, undefined, {
      ticker: "PEZERO",
      name: "Zero P/E Ltd",
      overview: {
        multiples: { pe: 0 },
        industry_benchmarks: { pe: 20 },
        pe_benchmark_source: { provider: "groww_refinitiv", label: "Groww/Refinitiv", industry_name: "Test", industry_pe: 20, company_pe: 0 },
        multiples_meta: { pe_source: "groww_refinitiv", pe_source_label: "Groww/Refinitiv" },
      },
    });
    await gotoApp(page, { tab: "picks" });

    await page.evaluate(() => window.openSwsModal("PENEG"));
    const body = page.locator("#swsModalBody");
    await expect(body.locator(".sws-modal-hero")).toBeVisible({ timeout: 10_000 });
    await expect(body).toContainText("-12.3x");

    await page.evaluate(() => window.openSwsModal("PEZERO"));
    await expect(body.locator(".sws-modal-hero")).toBeVisible({ timeout: 10_000 });
    await expect(body).toContainText("0.0x");
  });

  test("renders WALCHANNAG-shaped peer benchmarks when own P/E is unavailable", async ({ page }) => {
    await mockThinSwsStock(page, undefined, {
      ticker: "WALCHANNAG",
      name: "Walchandnagar Industries Limited",
      sector: "Capital Goods",
      overview: {
        multiples: { pe: null, pb: 4.38, ps: 5.7, ev_ebitda: 0 },
        net_margin_pct: 0,
        industry_benchmarks: {
          pe: 44.85265749196877,
          net_income_margin_1y: 0.1061182964,
          future_revenue_growth_3y: 0.5701956747,
        },
        pe_benchmark_source: { provider: "groww_refinitiv", label: "Groww/Refinitiv", industry_name: "Capital Goods", industry_pe: 44.85265749196877, company_pe: null },
      },
    });
    await gotoApp(page, { tab: "picks" });
    await page.evaluate(() => window.openSwsModal("WALCHANNAG"));

    const body = page.locator("#swsModalBody");
    await expect(body.locator(".sws-modal-hero")).toBeVisible({ timeout: 10_000 });
    await expect(body).toContainText("P/E");
    await expect(body).toContainText("vs Groww Capital Goods 44.9x");
    await expect(body).toContainText("Net margin (1Y)");
    await expect(body).toContainText("10.6%");
    await expect(body).toContainText("Future rev growth (3Y)");
    await expect(body).toContainText("57.0%");
  });

  test("cached quick stats render ownership metrics when available", async ({ page, request }) => {
    await gotoApp(page, { tab: "picks" });
    await waitForPicksLoaded(page);

    const tickers = await page.locator(".sws-pick-card").evaluateAll((cards) =>
      cards.map((card) => card.getAttribute("data-ticker")).filter(Boolean).slice(0, 40)
    );
    let target = null;
    let sourceDate = null;
    for (const ticker of tickers) {
      const res = await request.get(`/api/sws-stock/${encodeURIComponent(ticker)}`);
      if (!res.ok()) continue;
      const data = await res.json();
      const sourceMap = data?.deep?.overview?.source_map || {};
      const peProvider =
        data?.deep?.overview?.multiples_meta?.pe_source ||
        sourceMap["multiples.pe"]?.provider;
      if (
        data?.deep?.groww_source &&
        sourceMap.current_price_inr &&
        peProvider === "groww_refinitiv"
      ) {
        target = ticker;
        sourceDate = String(data.deep.groww_source.fetched_at || "").slice(0, 10);
        break;
      }
    }
    test.skip(!target, "No Groww-backed SWS pick fixture available in the current data snapshot.");

    await page.locator(`.sws-pick-card[data-ticker="${target}"]`).first().click();
    const body = page.locator("#swsModalBody");
    await expect(body.locator(".sws-modal-hero")).toBeVisible({ timeout: 10_000 });
    await expect(body).toContainText(/Quick stats\s+(SWS|Groww\/Refinitiv)/, { timeout: 5_000 });
    if (sourceDate) {
      await expect(body).toContainText(sourceDate, { timeout: 5_000 });
    }
    await expect(body).toContainText("P/E", { timeout: 5_000 });
    await expect(body).toContainText("Promoter %", { timeout: 5_000 });
  });
});
