// US Picks tab — render, currency, modal, filters, admin-gating.
//
// Self-skips when data/sws-us/picks-latest.json is absent (a fresh checkout
// without a US scrape). The test:e2e npm script builds a synthetic fixture
// first (build-us-picks-fixture.mjs), so CI always has data.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gotoApp } from "./helpers/app.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PICKS_PATH = path.join(__dirname, "..", "..", "data", "sws-us", "picks-latest.json");
const HAS_FIXTURE = fs.existsSync(PICKS_PATH);

// The harness runs with AUTH_ENABLED=false, so the global gate is open and the
// US read routes serve data. The TAB itself is client-gated on
// window.__starbhai_isAdmin — set it (as any admin-tab e2e would) before
// switching. gotoApp boots into the picks tab; we then flip to US Picks.
async function openUSPicks(page) {
  await gotoApp(page);
  await page.evaluate(() => { window.__starbhai_isAdmin = true; });
  await page.evaluate(() => window.switchTab("usPicks"));
  await expect(page.locator("#usPicksTab")).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(
    () => document.querySelectorAll("#usPicksContainer .sws-pick-card").length > 0,
    null,
    { timeout: 15_000 },
  );
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
    await page.evaluate(() => { window.__starbhai_isAdmin = false; window.__starbhai_isPersonal = false; });
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
    // Section headers are uppercased by CSS text-transform, so innerText is
    // "FINANCIAL HEALTH" / "REWARDS" — match case-insensitively.
    expect(txt).toMatch(/Health/i);
    expect(txt).toMatch(/Rewards/i);
    // PR2 parity: these sections were ABSENT from the old simplified US modal —
    // their presence proves the US tab now renders via the shared renderSwsModalCore.
    expect(txt).toMatch(/Score breakdown/i);
    expect(txt).toMatch(/Total returns/i);
    expect(txt).toMatch(/Snowflake/i);
    expect(txt).toMatch(/Quick stats/i);
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
    await page.evaluate(() => window.closeUSModal());
    await expect(modal).not.toHaveClass(/open/);
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
