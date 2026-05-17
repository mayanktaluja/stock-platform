// Global search — NSE preference dedup.
//
// The platform is NSE-canonical everywhere downstream (picks file,
// watchlist storage, stock-detail modal). Prior to the dedup fix, the
// global search dropdown surfaced both `AJAXENGG.NS` and `AJAXENGG.BO`
// for dual-listed names, which felt like duplication to the user.
// These specs lock in the new contract via the live /api/search route
// (the dedup is server-side, so testing it via the live wire is the
// honest assertion):
//
//   1. Live /api/search with "reliance" — local universe match
//      (no Yahoo fallback fires) → every row .NS-suffixed, no two rows
//      share a bare ticker. The common case.
//
//   2. Live /api/search with "AJAXENGG.BO" (explicit BSE-suffix query)
//      → returns the .NS row. Locks in the F1 fix: the route strips
//      the trailing exchange suffix before dispatching to local + Yahoo,
//      and the dedup helper upgrades any .BO survivor to .NS.
//
//   3. RUN_LIVE_YAHOO=1 gated case — type "ajax" (Yahoo fallback path)
//      and assert one row per bare ticker. Skipped in CI to avoid
//      Yahoo flakiness; runnable locally for ad-hoc verification.
//
// Run with: npx playwright test test/e2e/search-nse-preference.spec.mjs

import { test, expect } from "@playwright/test";
import { gotoApp } from "./helpers/app.mjs";

async function readDropdownSymbols(page) {
  const rows = page.locator(".search-result-item");
  return rows.evaluateAll((els) =>
    els.map((el) => el.querySelector(".search-result-symbol")?.textContent?.trim() || "")
  );
}

function assertNoBareTickerDups(symbols) {
  const bareKeys = symbols.map((s) => s.replace(/\.(NS|BO)$/i, ""));
  expect(new Set(bareKeys).size, `no two rows should share a bare ticker; got ${JSON.stringify(symbols)}`).toBe(bareKeys.length);
}

test.describe("Global search — NSE preference dedup", () => {
  test("live /api/search: 'reliance' → one row per bare ticker, all .NS", async ({ page }) => {
    await gotoApp(page);

    const input = page.locator("#searchInput");
    const dropdown = page.locator("#searchResults");

    await input.click();
    await input.fill("reliance");
    await expect(dropdown).toHaveClass(/active/, { timeout: 5_000 });
    // Wait for at least one row to render (debounce + fetch + render).
    await expect(page.locator(".search-result-item").first()).toBeVisible({ timeout: 5_000 });

    const symbols = await readDropdownSymbols(page);
    expect(symbols.length, "at least one result").toBeGreaterThan(0);
    for (const sym of symbols) {
      expect(sym, `every row should be .NS-suffixed for a local-universe hit; got "${sym}"`).toMatch(/\.NS$/);
    }
    assertNoBareTickerDups(symbols);
  });

  test("live /api/search: explicit '.BO' query is normalised — returns .NS", async ({ page }) => {
    await gotoApp(page);

    // Hit the API directly via the page context so cookies/session match
    // the SPA's own fetches. AJAX Engineering is a recent (2025) IPO that
    // isn't in the curated universe, so this exercises the Yahoo-fallback
    // path AND the suffix-stripping normalisation in one shot.
    const json = await page.evaluate(async () => {
      const r = await fetch("/api/search?q=" + encodeURIComponent("AJAXENGG.BO"));
      return r.json();
    });

    test.skip(!json || !Array.isArray(json.results), "search route returned no payload — Yahoo likely unreachable in this env");

    const symbols = (json.results || []).map((r) => r.symbol);
    test.skip(symbols.length === 0, "no AJAXENGG results returned — Yahoo path quiet in this env");

    // Whatever Yahoo returns, after dedup there must be no two rows
    // sharing AJAXENGG as a bare key, and any AJAXENGG row must be .NS.
    assertNoBareTickerDups(symbols);
    const ajaxRow = symbols.find((s) => /^AJAXENGG\./i.test(s));
    expect(ajaxRow, "AJAXENGG must surface in the .BO-query response").toBeDefined();
    expect(ajaxRow).toMatch(/\.NS$/);
  });

  test("live Yahoo path: 'ajax' returns one row per bare ticker (RUN_LIVE_YAHOO=1)", async ({ page }) => {
    test.skip(process.env.RUN_LIVE_YAHOO !== "1", "live Yahoo path skipped by default — set RUN_LIVE_YAHOO=1 to enable");

    await gotoApp(page);
    const input = page.locator("#searchInput");
    const dropdown = page.locator("#searchResults");

    await input.click();
    await input.fill("ajax");
    await expect(dropdown).toHaveClass(/active/, { timeout: 10_000 });
    await expect(page.locator(".search-result-item").first()).toBeVisible({ timeout: 10_000 });

    const symbols = await readDropdownSymbols(page);
    assertNoBareTickerDups(symbols);
    const ajaxRow = symbols.find((s) => /^AJAXENGG\./i.test(s));
    if (ajaxRow) expect(ajaxRow).toMatch(/\.NS$/);
  });
});
