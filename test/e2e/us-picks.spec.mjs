// US Picks tab — render, currency, modal, filters, signed-in visibility.
//
// Self-skips when data/sws-us/picks-latest.json is absent (a fresh checkout
// without a US scrape). The test:e2e npm script builds a synthetic fixture
// first (build-us-picks-fixture.mjs), so CI always has data.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gotoApp } from "./helpers/app.mjs";

test.setTimeout(60_000);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PICKS_PATH = path.join(__dirname, "..", "..", "data", "sws-us", "picks-latest.json");
const HAS_FIXTURE = fs.existsSync(PICKS_PATH);

// The harness runs with AUTH_ENABLED=false, so the global gate is open and the
// US read routes serve data. gotoApp boots into the picks tab; we then flip to
// US Picks through the public tab contract.
async function openUSPicks(page) {
  await gotoApp(page);
  await page.evaluate(() => window.switchTab("usPicks"));
  await expect(page.locator("#usPicksTab")).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(
    () => document.querySelectorAll("#usPicksContainer .sws-pick-card").length > 0,
    null,
    { timeout: 15_000 },
  );
}

async function expectTotalReturnsHasPercentValues(bodyLocator) {
  const returnsSection = bodyLocator
    .locator("h4")
    .filter({ hasText: /^Total returns$/i })
    .locator("xpath=..");
  await expect(returnsSection).toBeVisible();
  const returnsText = await returnsSection.innerText();
  expect(returnsText).toMatch(/[+-]\d+(?:\.\d+)?%/);
  return returnsText;
}

async function quickStatsText(bodyLocator) {
  const section = bodyLocator
    .locator("h4")
    .filter({ hasText: /Quick stats/i })
    .locator("xpath=..");
  await expect(section).toBeVisible();
  return section.innerText();
}

test.describe("US Picks tab", () => {
  test.skip(!HAS_FIXTURE, "no data/sws-us/picks-latest.json fixture present");

  test("renders sections + cards in USD ($), never ₹", async ({ page }) => {
    await openUSPicks(page);
    const container = page.locator("#usPicksContainer");
    expect(await container.locator(".sws-pick-card").count()).toBeGreaterThan(0);
    const text = await container.innerText();
    expect(text).toContain("$");
    expect(text).not.toContain("₹");
    await expect(container.locator('.sws-pick-section[data-section-key="top_ranked_30_v3"]')).toBeVisible();
  });

  test("open to all signed-in users: tab renders without the admin flag", async ({ page }) => {
    await gotoApp(page);
    await page.evaluate(() => { window.__starbhai_isAdmin = false; });
    await page.evaluate(() => window.switchTab("usPicks"));
    await expect(page.locator("#usPicksTab")).toBeVisible({ timeout: 10_000 });
  });

  test("modal opens with the full rich detail (score breakdown + returns + snowflake), all in $", async ({ page }) => {
    await openUSPicks(page);
    const firstTicker = await page
      .locator("#usPicksContainer .sws-pick-card")
      .first()
      .getAttribute("data-ticker");
    await page.evaluate((t) => window.openUSModal(t), firstTicker);
    const modal = page.locator("#usModalBackdrop");
    await expect(modal).toHaveClass(/open/, { timeout: 10_000 });
    const txt = await page.locator("#usModalBody").innerText();
    expect(txt).toContain("$");
    expect(txt).not.toContain("₹");
    // Section headers are uppercased by CSS text-transform. Rewards/Risks are
    // data-dependent, so assert only on the always-present rich-modal anchors.
    expect(txt).toMatch(/Health/i);
    // PR2 parity: these sections were ABSENT from the old simplified US modal —
    // their presence proves the US tab now renders via the shared renderSwsModalCore.
    expect(txt).toMatch(/Score breakdown/i);
    expect(txt).toMatch(/Total returns/i);
    await expectTotalReturnsHasPercentValues(page.locator("#usModalBody"));
    expect(txt).toMatch(/Snowflake/i);
    expect(txt).toMatch(/Quick stats/i);
    const quick = await quickStatsText(page.locator("#usModalBody"));
    if (/SWS \+ Yahoo|Yahoo fallback/i.test(quick)) {
      for (const value of ["Forward P/E", "24.6x", "ROE", "28.4%", "D/E", "42.0%", "Current ratio", "2.15x", "Gross margin", "45.6%", "Beta", "1.26"]) {
        expect(quick.toLowerCase()).toContain(value.toLowerCase());
      }
    } else {
      expect(quick).toContain("SWS");
    }
    // The reported bug left the header blank (Price —, Mcap —) because the modal
    // only read the deep brief. Assert the deep-sourced price actually surfaced.
    const hero = await page.locator("#usModalBody .sws-modal-hero").innerText();
    expect(hero).not.toMatch(/Price\s*—/);
    await page.evaluate(() => window.closeUSModal());
    await expect(modal).not.toHaveClass(/open/);
  });

  test("modal falls back to picks-card fields when the deep brief is unavailable", async ({ page }) => {
    await openUSPicks(page);
    // Simulate prod when the per-region deep tarball hasn't been bundled/extracted
    // yet: /api/us-stock returns a card but deep:null. The modal must still render
    // the header + snowflake from the card instead of a blank "—" everywhere.
    await page.route("**/api/us-stock/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ticker: "AAPL",
          deep: null,
          card: {
            ticker: "AAPL", name: "Apple", sector: "tech", currency: "USD",
            current_price_inr: 220, fair_value_inr: 250, upside_pct: 13.6, market_cap_inr: 3.2e12,
            v4_score_100: 78, v4_verdict: "TOP_PICK", composite_verdict: "TOP_PICK",
            v4_breakdown: {
              pts_health: 18, pts_future: 16, pts_valuation: 14, pts_past: 12,
              pts_fv_total: 8, pts_mom_1y: 6, pts_mom_3m: 3, pts_mom_1m: 1, pts_overlay: 0,
            },
            snowflake: { valuation: 3, future_growth: 4, past_performance: 6, financial_health: 5, dividends: 2 },
            snowflake_total: 20,
            returns_pct: { "1D": 1.2, "7D": -2.3, "1M": 3.4, "3M": -4.5, "1Y": 12.6 },
          },
          fundamentals_fallback: {
            source: "yahoo-finance2",
            yahoo_symbol: "AAPL",
            fetched_at: "2026-05-25T00:00:00.000Z",
            pe: 31.2,
            forward_pe: 24.6,
            pb: 6.4,
            ps: 7.8,
            ev_ebitda: 18.4,
            peg_ratio: 1.91,
            eps: 7.25,
            roe_pct: 28.4,
            roa_pct: 13.7,
            debt_to_equity_pct: 42.0,
            current_ratio: 2.15,
            gross_margin_pct: 45.6,
            operating_margin_pct: 29.7,
            net_margin_pct: 21.5,
            beta: 1.26,
            dividend_yield_pct: 0.72,
            payout_pct: 18,
            annual_dividend: 1.04,
            latest_revenue: 1.2e11,
            latest_net_income: 2.6e10,
            total_debt: 9.0e10,
            net_cash: -3.0e10,
            week52_low_inr: 180,
            week52_high_inr: 260,
          },
          in_sections: ["top_ranked_30_v3"],
          currency: "USD",
        }),
      }),
    );
    await page.evaluate(() => window.openUSModal("AAPL"));
    const modal = page.locator("#usModalBackdrop");
    await expect(modal).toHaveClass(/open/, { timeout: 10_000 });
    const hero = await page.locator("#usModalBody .sws-modal-hero").innerText();
    // Header values came from the card (deep was null) — not blank dashes.
    expect(hero).toContain("$");
    expect(hero).not.toMatch(/Price\s*—/);
    expect(hero).not.toMatch(/Fair value\s*—/);
    const txt = await page.locator("#usModalBody").innerText();
    // Snowflake hex falls back to card.snowflake (20/30 here).
    expect(txt).toMatch(/Snowflake/i);
    expect(txt).toContain("20/30");
    const quick = await quickStatsText(page.locator("#usModalBody"));
    expect(quick).toMatch(/Yahoo fallback/i);
    for (const value of ["P/E", "31.2x", "P/B", "6.40x", "EPS", "$7.25", "ROE", "28.4%", "D/E", "42.0%", "Net margin", "21.5%"]) {
      expect(quick.toLowerCase()).toContain(value.toLowerCase());
    }
    const returnsText = await expectTotalReturnsHasPercentValues(page.locator("#usModalBody"));
    for (const label of ["1D", "7D", "1M", "3M", "1Y"]) expect(returnsText).toContain(label);
    for (const value of ["+1.2%", "-2.3%", "+3.4%", "-4.5%", "+12.6%"]) expect(returnsText).toContain(value);
    await page.evaluate(() => window.closeUSModal());
    await expect(modal).not.toHaveClass(/open/);
  });

  test("modal falls back to deep overview when card FV fields are null", async ({ page }) => {
    await openUSPicks(page);
    await page.route("**/api/us-stock/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ticker: "HIMS",
          card: {
            ticker: "HIMS",
            name: "Hims & Hers Health, Inc.",
            sector: "Healthcare",
            currency: "USD",
            current_price_inr: 23.85,
            fair_value_inr: null,
            upside_pct: null,
            market_cap_inr: 5_497_120_256,
            v4_score_100: 47.8,
            v4_verdict: "STRONG",
            composite_verdict: "STRONG",
            v4_breakdown: {
              pts_health: 22,
              pts_future: 20,
              pts_valuation: 18,
              pts_past: 16,
              pts_fv_total: 7.3,
              pts_mom_1y: 0.7,
              pts_mom_3m: 2,
              pts_mom_1m: 1.2,
              pts_overlay: 0,
            },
            snowflake: { valuation: 3, future_growth: 5, past_performance: 0, financial_health: 3, dividends: 0 },
            snowflake_total: 11,
            returns_pct: { "1D": 0.4, "7D": 6.3, "1M": -22, "3M": 50.8, "1Y": -55.3 },
          },
          deep: {
            overview: {
              ticker: "HIMS",
              name: "Hims & Hers Health, Inc.",
              sector: "Healthcare",
              currency: "USD",
              current_price_inr: 23.85,
              fair_value_inr: 173.02,
              upside_pct: 625.45,
              market_cap_inr: 5_497_120_256,
              fifty_two_week: { low: 14.52, high: 66.18 },
              source_map: {
                fair_value_inr: { provider: "sws_analyst_fair_value" },
                upside_pct: { provider: "computed_from_sws_fv_price" },
                fifty_two_week: { provider: "sws_price_history" },
              },
            },
          },
          fundamentals_fallback: null,
          in_sections: ["midterm_quality_momentum"],
          currency: "USD",
        }),
      }),
    );
    await page.evaluate(() => window.openUSModal("HIMS"));
    const modal = page.locator("#usModalBackdrop");
    await expect(modal).toHaveClass(/open/, { timeout: 10_000 });
    const hero = await page.locator("#usModalBody .sws-modal-hero").innerText();
    expect(hero).toMatch(/Fair value\s+\$173\.02/);
    expect(hero).toMatch(/Upside\s+\+625\.5%/);
    expect(hero).toMatch(/52w\s+\$14\.52[\s\S]*\$66\.18/);
    expect(hero).not.toMatch(/Fair value\s*—/);
    expect(hero).not.toMatch(/Upside\s*—/);
  });

  test("collapsible sections: chip-nav + Expand/Collapse-all toggle the accordion", async ({ page }) => {
    await openUSPicks(page);
    await expect(page.locator("#usPicksContainer .sws-pick-chipnav")).toBeVisible();
    const hero = page.locator('#usPicksContainer .sws-pick-section[data-section-key="top_ranked_30_v3"]');
    await expect(hero).not.toHaveClass(/collapsed/); // hero open by default
    await page.locator("#usPicksContainer .sws-pick-chip-action", { hasText: "Collapse all" }).click();
    await expect(hero).toHaveClass(/collapsed/);
    await page.locator("#usPicksContainer .sws-pick-chip-action", { hasText: "Expand all" }).click();
    await expect(hero).not.toHaveClass(/collapsed/);
    await hero.locator(".section-header").click(); // header click toggles its own section
    await expect(hero).toHaveClass(/collapsed/);
  });

  test("search filter narrows then restores cards", async ({ page }) => {
    await openUSPicks(page);
    const before = await page.locator("#usPicksContainer .sws-pick-card").count();
    await page.fill("#usPicksSearchInput", "zzzznomatch_xyz");
    await expect(page.locator("#usPicksContainer")).toContainText(/No US stocks match/i);
    await page.click("#usPicksSearchClear");
    expect(await page.locator("#usPicksContainer .sws-pick-card").count()).toBe(before);
  });

  test("sector filter present; no India Nifty universe filter", async ({ page }) => {
    await openUSPicks(page);
    await expect(page.locator("#usPicksSectorFilter")).toBeVisible();
    expect(await page.locator("#usPicksSectorFilter option").count()).toBeGreaterThan(1);
    // The India universe filter must NOT exist inside the US tab.
    await expect(page.locator("#usPicksTab #picksUniverseFilter")).toHaveCount(0);
    const sectorText = await page.locator("#usPicksSectorFilter").innerText();
    expect(sectorText).not.toMatch(/Nifty/i);
  });
});
