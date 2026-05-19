// Risk Lab — live-search filter across ticker / verdict / flag category.
//
// Covers the four behaviours wired in gated/riskLab.js:
//   1. Typing a ticker prefix narrows the row set to matching tickers.
//   2. Typing a flag category narrows to stocks carrying that flag.
//   3. Search composes with sort — the active sort still applies to the
//      narrowed result set.
//   4. Search persists across lens switches (different from _sortState +
//      _showAll, which reset on lens change).
//
// Self-skips when /api/risk-lab/picks-adjusted is unavailable (disabled / not
// generated). Uses the Quality lens default (946 quality_flagged stocks in
// current production data); skips if the filter set is too small for the
// narrowing assertion.

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

const SEARCH_DEBOUNCE_MS = 200; // riskLab.js debounce is 150ms — pad a bit for CI

async function loadRiskLab(page, request) {
  const apiRes = await request.get("/api/risk-lab/picks-adjusted");
  if (apiRes.status() === 404 || apiRes.status() === 503) {
    test.skip(true, "Risk Lab disabled or picks-adjusted file not generated");
  }
  expect(apiRes.ok()).toBe(true);
  const body = await apiRes.json();
  const filtered = (body.stocks || []).filter(
    (s) => (s.quality_flags?.length || 0) > 0 || s.quality_veto?.vetoed,
  );
  if (filtered.length < 20) {
    test.skip(true, `Quality lens has only ${filtered.length} matches — too small for narrowing assertions`);
  }
  await gotoApp(page, { tab: "riskLab" });
  await expect(page.locator("button:has-text('Quality Lens')")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("risk-lab-search-input")).toBeVisible({ timeout: 10_000 });
  return { totalFiltered: filtered.length, stocks: filtered };
}

test.describe("Risk Lab — search filter", () => {
  test("Typing a ticker prefix narrows the visible row set", async ({ page, request }) => {
    const { stocks } = await loadRiskLab(page, request);
    // Pick a ticker prefix that should match at least 1 row but fewer than the
    // total. Use the first 3 chars of an arbitrary ticker from the data set.
    const sample = stocks.find((s) => (s.ticker || "").length >= 4);
    if (!sample) test.skip(true, "no ticker with ≥4 chars in payload");
    const prefix = sample.ticker.slice(0, 3);
    const expectedMatches = stocks.filter((s) => (s.ticker || "").toLowerCase().startsWith(prefix.toLowerCase())).length;
    // Cap at 100 (Show-all not clicked).
    const expectedVisible = Math.min(expectedMatches, 100);

    const input = page.getByTestId("risk-lab-search-input");
    await input.fill(prefix);
    await page.waitForTimeout(SEARCH_DEBOUNCE_MS);
    // After narrowing, every visible ticker starts with the prefix (case-insensitive).
    const tickerCells = await page.locator('[data-testid="risk-lab-row"] > div:first-child').allTextContents();
    expect(tickerCells.length).toBeGreaterThan(0);
    expect(tickerCells.length).toBeLessThanOrEqual(expectedVisible);
    for (const t of tickerCells) {
      expect(t.toLowerCase()).toContain(prefix.toLowerCase());
    }
  });

  test("Search matches flag-category text, not just ticker", async ({ page, request }) => {
    const { stocks } = await loadRiskLab(page, request);
    // Find a flag category that exists in the data.
    const flagSamples = stocks
      .flatMap((s) => (s.quality_flags || []).map((f) => f.category || f.type || f.overlay))
      .filter(Boolean);
    if (flagSamples.length === 0) test.skip(true, "no quality_flags in payload");
    // Pick the most common category for a stable assertion.
    const counts = {};
    for (const f of flagSamples) counts[f] = (counts[f] || 0) + 1;
    const topCategory = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    // Use a substring that's unlikely to also match a ticker. Just use the
    // category itself; e.g. "cash_flow_weakness".
    const input = page.getByTestId("risk-lab-search-input");
    await input.fill(topCategory);
    await page.waitForTimeout(SEARCH_DEBOUNCE_MS);
    const rowCount = await page.getByTestId("risk-lab-row").count();
    expect(rowCount).toBeGreaterThan(0);
    expect(rowCount).toBeLessThan(stocks.length); // narrowed from full set
  });

  test("Clearing the search restores the full lens-filtered set", async ({ page, request }) => {
    const { totalFiltered } = await loadRiskLab(page, request);
    const expectedInitial = Math.min(totalFiltered, 100); // 100-cap still applies
    // Initial state should already show capped row count.
    await expect(page.getByTestId("risk-lab-row")).toHaveCount(expectedInitial);
    const input = page.getByTestId("risk-lab-search-input");
    await input.fill("xyznosuchticker");
    await page.waitForTimeout(SEARCH_DEBOUNCE_MS);
    await expect(page.getByTestId("risk-lab-row")).toHaveCount(0);
    await input.fill("");
    await page.waitForTimeout(SEARCH_DEBOUNCE_MS);
    await expect(page.getByTestId("risk-lab-row")).toHaveCount(expectedInitial);
  });

  test("Search query persists across lens switches", async ({ page, request }) => {
    const { stocks } = await loadRiskLab(page, request);
    const sample = stocks.find((s) => (s.ticker || "").length >= 3);
    const prefix = sample.ticker.slice(0, 2);
    const input = page.getByTestId("risk-lab-search-input");
    await input.fill(prefix);
    await page.waitForTimeout(SEARCH_DEBOUNCE_MS);
    // Switch to Combined view — search query should still be in the input.
    await page.click("button:has-text('Combined view')");
    await expect(page.getByTestId("risk-lab-search-input")).toHaveValue(prefix);
    // Switch back to Quality — still preserved.
    await page.click("button:has-text('Quality Lens')");
    await expect(page.getByTestId("risk-lab-search-input")).toHaveValue(prefix);
  });

  test("Search + column sort compose — narrowed set is still sorted", async ({ page, request }) => {
    const { stocks } = await loadRiskLab(page, request);
    // Pick a 2-char prefix that should yield several matches.
    const sample = stocks.find((s) => (s.ticker || "").length >= 3);
    const prefix = sample.ticker.slice(0, 1);
    const input = page.getByTestId("risk-lab-search-input");
    await input.fill(prefix);
    await page.waitForTimeout(SEARCH_DEBOUNCE_MS);
    // Apply descending sort on Orig Score.
    await page.getByTestId("risk-lab-header-origScore").click();
    await expect(page.getByTestId("risk-lab-header-origScore"))
      .toHaveAttribute("aria-sort", "descending");
    // First three scores should be descending.
    const scoreCells = await page.locator('[data-testid="risk-lab-row"] > div:nth-child(3)').allTextContents();
    if (scoreCells.length < 2) test.skip(true, `only ${scoreCells.length} rows after search — too few for sort assertion`);
    const nums = scoreCells.slice(0, Math.min(3, scoreCells.length)).map((s) => parseFloat(s));
    for (let i = 1; i < nums.length; i++) {
      expect(nums[i]).toBeLessThanOrEqual(nums[i - 1]);
    }
  });
});
