// Earnings Watch — symbol/company search with autocomplete.
//
// What the search feature does (vs the older single-field Symbol filter):
//   • matches symbol-prefix OR company-name substring
//   • shows an autocomplete dropdown drawn from the in-memory snapshot
//     (upcoming + recent_results, deduped by symbol)
//   • renders an explicit "not found in next 60d or status tracker" banner when
//     the typed query has zero matches in either array
//   • overrides the sibling filters (days / verdict / quality / runup /
//     sector) so a stock surfaces if it's in the snapshot regardless of
//     what other filters are set
//
// Test 1 exercises the pure helpers via window.__earnings — runs in any
// auth mode, independent of admin-tab visibility. Test 2 drives the live
// UI end-to-end; self-skips when the Earnings tab isn't admin-visible in
// the current run (AUTH_ENABLED=false + no admin email → tab hidden), the
// same convention the other earnings specs follow.

import { test, expect } from "@playwright/test";
import { gotoApp, switchTab } from "./helpers/app.mjs";

const SYNTHETIC_SNAPSHOT = {
  window_days: 60,
  past_window_days: 14,
  events: [
    { symbol: "AARTIPHARM", company: "Aarti Pharmalabs Limited", days_until: 1, event_iso_date: "2026-05-18" },
    { symbol: "TMCV",       company: "Tata Motors",              days_until: 3, event_iso_date: "2026-05-20" },
    { symbol: "RELIANCE",   company: "Reliance Industries",      days_until: 7, event_iso_date: "2026-05-24" },
  ],
  recent_results: [
    { symbol: "TATAPOWER", company: "Tata Power", days_until: -5, event_iso_date: "2026-05-12" },
    { symbol: "INFY",      company: "Infosys",    days_until: -3, event_iso_date: "2026-05-14" },
  ],
};

test.describe("Earnings Watch — symbol/company search", () => {
  test("pure helpers: match, suggestions, empty-state (no admin gate)", async ({ page }) => {
    await gotoApp(page);

    // earnings.js loads with `defer`, so the IIFE has finished by the time
    // DOMContentLoaded resolves. Wait for the debug export rather than
    // racing on it.
    await page.waitForFunction(
      () => window.__earnings && typeof window.__earnings.buildSymbolSuggestions === "function",
      null,
      { timeout: 10_000 },
    );

    // 1. matchesSearchQuery: symbol prefix OR company substring, case-insensitive.
    const matchCases = await page.evaluate(() => {
      const { matchesSearchQuery } = window.__earnings;
      // Distinct symbol vs company so we can isolate the two match paths.
      const acme = { symbol: "ACMECORP", company: "Different Industries" };
      const reli = { symbol: "RELIANCE", company: "Reliance Industries" };
      return {
        emptyQ:       matchesSearchQuery(acme, ""),         // empty matches all
        symPrefix:    matchesSearchQuery(acme, "ACME"),     // symbol prefix hit
        symMidMiss:   matchesSearchQuery(acme, "MECORP"),   // symbol mid AND not in company → miss
        coSubstring:  matchesSearchQuery(acme, "DIFFERENT"),// company substring hit
        coSubstringLower: matchesSearchQuery(reli, "indust"),// case-insensitive company match
        miss:         matchesSearchQuery(acme, "ZZZZZ"),
      };
    });
    expect(matchCases).toEqual({
      emptyQ: true,
      symPrefix: true,
      symMidMiss: false,
      coSubstring: true,
      coSubstringLower: false,    // matchesSearchQuery expects an already-uppercased query (per its contract: caller normalizes)
      miss: false,
    });

    // 2. buildSymbolSuggestions: ranks upcoming over recent, dedupes by
    //    symbol, caps at 8, matches on company name too.
    const suggestionResults = await page.evaluate((snap) => {
      window.__earnings.__setSnapshotForTest(snap);
      const { buildSymbolSuggestions } = window.__earnings;
      return {
        tata: buildSymbolSuggestions("TATA").map(s => ({ sym: s.symbol, src: s.source })),
        reli: buildSymbolSuggestions("RELI").map(s => ({ sym: s.symbol, src: s.source })),
        aarti: buildSymbolSuggestions("AARTI").map(s => ({ sym: s.symbol, src: s.source })),
        infoCompany: buildSymbolSuggestions("INFOSYS").map(s => ({ sym: s.symbol, src: s.source })),
        missing: buildSymbolSuggestions("GOOGL"),
      };
    }, SYNTHETIC_SNAPSHOT);

    // "TATA" hits TMCV (upcoming, company="Tata Motors") and TATAPOWER
    // (recent, symbol prefix). Upcoming sorted first.
    expect(suggestionResults.tata).toEqual([
      { sym: "TMCV", src: "upcoming" },
      { sym: "TATAPOWER", src: "recent" },
    ]);
    expect(suggestionResults.reli).toEqual([{ sym: "RELIANCE", src: "upcoming" }]);
    expect(suggestionResults.aarti).toEqual([{ sym: "AARTIPHARM", src: "upcoming" }]);
    expect(suggestionResults.infoCompany).toEqual([{ sym: "INFY", src: "recent" }]);
    expect(suggestionResults.missing).toEqual([]);

    // 3. renderSearchEmptyState: hidden when query empty or any matches;
    //    visible with the typed query embedded when both arrays are empty.
    const emptyState = await page.evaluate(() => {
      const el = document.getElementById("earningsSearchEmptyState");
      if (!el) return { missing: true };
      const { renderSearchEmptyState } = window.__earnings;
      const reads = [];
      renderSearchEmptyState({ query: "", hasUpcomingMatches: false, hasRecentMatches: false });
      reads.push({ when: "empty-query", hidden: el.hidden, hasText: el.textContent.trim().length > 0 });
      renderSearchEmptyState({ query: "REL", hasUpcomingMatches: true, hasRecentMatches: false });
      reads.push({ when: "has-upcoming", hidden: el.hidden, hasText: el.textContent.trim().length > 0 });
      renderSearchEmptyState({ query: "GOOGL", hasUpcomingMatches: false, hasRecentMatches: false });
      reads.push({ when: "no-matches", hidden: el.hidden, includesQuery: el.textContent.includes("GOOGL"), includesNotFound: el.textContent.includes("no earnings in the next 60 days or status tracker past 14 days") });
      return reads;
    });
    expect(emptyState).toEqual([
      { when: "empty-query",   hidden: true,  hasText: false },
      { when: "has-upcoming",  hidden: true,  hasText: false },
      { when: "no-matches",    hidden: false, includesQuery: true, includesNotFound: true },
    ]);
  });

  test("UI integration: autocomplete + select + not-found banner", async ({ page }) => {
    await gotoApp(page);
    await switchTab(page, "earnings");

    const input = page.locator("#earningsSymbolFilter");
    const dropdown = page.locator("#earningsSymbolSuggestions");
    const emptyState = page.locator("#earningsSearchEmptyState");
    await expect(input).toBeVisible({ timeout: 10_000 });

    // Self-skip when the snapshot is empty (refresh-earnings.mjs hasn't
    // run, or the JSON file is missing) — same data-precondition convention
    // as test/e2e/earnings-recent-results.spec.mjs.
    const hasData = await page
      .waitForFunction(
        () => document.querySelectorAll(".earnings-card").length > 0,
        null,
        { timeout: 10_000 },
      )
      .then(() => true)
      .catch(() => false);
    test.skip(!hasData, "earnings-watch-latest.json has no events in this run");

    // Inject a synthetic snapshot via the test export so the assertions
    // don't hinge on whatever symbols happen to be in the live JSON today.
    // We assert via the dropdown contents (which the helpers read from
    // _earningsSnapshot directly), not the rendered grid (which the
    // background data fetch can race-overwrite).
    await page.evaluate((snap) => {
      window.__earnings.__setSnapshotForTest(snap);
    }, SYNTHETIC_SNAPSHOT);

    // 1. Typing a unique symbol prefix opens the dropdown with one row.
    await input.click();
    await input.fill("RELI");
    await expect(dropdown).toBeVisible();
    const rows = page.locator(".earnings-symbol-suggestion");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute("data-symbol", "RELIANCE");

    // 2. Typing a stock that's NOT in either snapshot collapses the
    //    dropdown AND shows the explicit empty-state banner.
    await input.fill("ZZZUNKNOWN");
    await expect(dropdown).toBeHidden();
    await expect(emptyState).toBeVisible();
    await expect(emptyState).toContainText("ZZZUNKNOWN");
    await expect(emptyState).toContainText("no earnings in the next 60 days or status tracker past 14 days");

    // 3. Lowercase company-name query — matches TWO TATA rows (upcoming
    //    TMCV "Tata Motors" + recent TATAPOWER "Tata Power"). Click the
    //    first row and verify the input populates + dropdown collapses.
    await input.fill("");
    await expect(emptyState).toBeHidden();
    await input.fill("tata");
    await expect(rows).toHaveCount(2);
    const tmcvRow = rows.filter({ hasText: "TMCV" }).first();
    await expect(tmcvRow).toBeVisible();
    await tmcvRow.click();
    await expect(input).toHaveValue("TMCV");
    await expect(dropdown).toBeHidden();
    await expect(input).toHaveAttribute("aria-expanded", "false");
  });
});
