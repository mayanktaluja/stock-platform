// E2E for the new "Upcoming results calendar" section at the bottom of the
// Portfolio Analyzer tab. After uploading the fixture portfolio the analyzer
// report must include a collapsible <details> labelled "Upcoming results
// calendar" with one row per scored equity holding.
//
// Sort order (three blocks):
//   1. Future + today        — ascending by date (soonest first)
//   2. Past (stale)          — most-recently-past first, date suffixed " (past)"
//   3. Truly unknown / null  — "—"
//
// Self-skips when the fixture or live-price-dependent report doesn't surface,
// matching the convention in analyzer-reflow.spec.mjs and
// analyzer-action-mix.spec.mjs.

import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { gotoApp } from "./helpers/app.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures", "groww-sample.xlsx");

test.describe("Portfolio Analyzer — Upcoming results calendar", () => {
  test.skip(!existsSync(FIXTURE), "fixture missing");

  test("renders three sorted blocks: future asc, past newer-first, unknown last", async ({ page }) => {
    await gotoApp(page, { tab: "analyzer" });
    await page.locator("#analyzerFileInput").setInputFiles(FIXTURE);

    // Wait for the analyzer report to render. If it doesn't, the test self-
    // skips — the same pattern used by analyzer-reflow.spec.mjs.
    const reportReady = await page
      .waitForFunction(
        () => {
          const r = document.getElementById("analyzerReport");
          return r && r.style.display !== "none";
        },
        null,
        { timeout: 45_000 }
      )
      .then(() => true)
      .catch(() => false);
    test.skip(
      !reportReady,
      "analyzer report did not render in time — likely live-price dependency"
    );

    // Locate the new section's summary. The renderer only emits the section
    // when at least one scored equity holding exists, so a missing summary
    // means there were 0 equity holdings — skip in that case rather than fail.
    const summary = page.locator(
      "details.analyzer-tier-details summary:has-text(\"Upcoming results calendar\")"
    );
    const sectionCount = await summary.count();
    test.skip(
      sectionCount === 0,
      "no equity holdings in fixture portfolio — calendar section not emitted"
    );

    // Expand the <details> so the table is visible to subsequent locators.
    await summary.first().click();
    const tableDetails = summary.first().locator(
      "xpath=ancestor::details[contains(@class,'analyzer-tier-details')][1]"
    );
    await expect(tableDetails).toHaveAttribute("open", /.*/);

    const tableRows = tableDetails.locator("tbody tr");
    const rowCount = await tableRows.count();
    expect(rowCount).toBeGreaterThan(0);

    // Pull the date column (5th cell, index 4) for every row.
    const dateStrings = [];
    for (let i = 0; i < rowCount; i++) {
      const text = (await tableRows.nth(i).locator("td").nth(4).innerText()).trim();
      dateStrings.push(text);
    }

    const DASH = "—";
    const PAST_SUFFIX = "(past)";
    const classify = (s) => {
      if (s === DASH) return "unknown";
      if (s.includes(PAST_SUFFIX)) return "past";
      return "future";
    };

    // Block ordering: the sequence of classifications must follow
    //   future* → past* → unknown*
    // with each block contiguous and in that order. No future row may follow
    // a past row; no past row may follow an unknown row.
    let phase = 0; // 0=future, 1=past, 2=unknown
    const phaseFor = { future: 0, past: 1, unknown: 2 };
    for (let i = 0; i < dateStrings.length; i++) {
      const ph = phaseFor[classify(dateStrings[i])];
      expect(ph, `row ${i} "${dateStrings[i]}" violates block order`).toBeGreaterThanOrEqual(phase);
      phase = ph;
    }

    // Parse "16 May 2026" or "16 May 2026 (past)" → ms.
    const MONTHS = {
      Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
      Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
    };
    const parseEnIn = (s) => {
      const m = s.match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
      if (!m) return null;
      const month = MONTHS[m[2]];
      if (month == null) return null;
      return Date.UTC(Number(m[3]), month, Number(m[1]));
    };

    const todayUtcMs = Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      new Date().getUTCDate()
    );

    // Future block: monotonically non-decreasing AND every date is today-or-later.
    let prevFutureMs = -Infinity;
    for (let i = 0; i < dateStrings.length; i++) {
      if (classify(dateStrings[i]) !== "future") break;
      const ms = parseEnIn(dateStrings[i]);
      expect(ms, `future row ${i} "${dateStrings[i]}" did not parse`).not.toBeNull();
      expect(ms, `future row ${i} "${dateStrings[i]}" must be today-or-later`).toBeGreaterThanOrEqual(todayUtcMs - 86_400_000);
      expect(ms, `future row ${i} "${dateStrings[i]}" out of order`).toBeGreaterThanOrEqual(prevFutureMs);
      prevFutureMs = ms;
    }

    // Past block: every date is strictly before today, and order is
    // most-recent-first (descending). Note: we don't enforce strict descending
    // here because two rows could share the same past date — only "not earlier
    // than the next row" which is `prev >= curr`.
    let prevPastMs = Infinity;
    for (let i = 0; i < dateStrings.length; i++) {
      if (classify(dateStrings[i]) !== "past") continue;
      const ms = parseEnIn(dateStrings[i]);
      expect(ms, `past row ${i} "${dateStrings[i]}" did not parse`).not.toBeNull();
      expect(ms, `past row ${i} "${dateStrings[i]}" must be before today`).toBeLessThan(todayUtcMs);
      expect(ms, `past row ${i} "${dateStrings[i]}" out of order (should be newer-first)`).toBeLessThanOrEqual(prevPastMs);
      prevPastMs = ms;
    }
  });

  // Click-to-open behaviour. Rows in the calendar are wired to
  // openStockDetailModal('<ticker>', 'analyzer-earnings') so they open the
  // same universal stock detail modal used everywhere else on the platform
  // (search dropdown, watchlist, analyzer-track table, MF overlap, etc.).
  // We assert the lifecycle open + structural anchors (hero, ≥1 section)
  // borrowed from stock-detail-modal.spec.mjs so a silent renderer regression
  // is caught (modal opens but body fails to populate).
  test("clicking a row opens the universal stock detail modal", async ({ page }) => {
    await gotoApp(page, { tab: "analyzer" });
    await page.locator("#analyzerFileInput").setInputFiles(FIXTURE);

    const reportReady = await page
      .waitForFunction(
        () => {
          const r = document.getElementById("analyzerReport");
          return r && r.style.display !== "none";
        },
        null,
        { timeout: 45_000 }
      )
      .then(() => true)
      .catch(() => false);
    test.skip(
      !reportReady,
      "analyzer report did not render in time — likely live-price dependency"
    );

    const summary = page.locator(
      "details.analyzer-tier-details summary:has-text(\"Upcoming results calendar\")"
    );
    test.skip(
      await summary.count() === 0,
      "no equity holdings in fixture portfolio — calendar section not emitted"
    );

    await summary.first().click();
    const tableDetails = summary.first().locator(
      "xpath=ancestor::details[contains(@class,'analyzer-tier-details')][1]"
    );

    // Only rows with a non-empty tickerCell receive an onclick handler — the
    // ternary in renderSWSEarningsCalendar leaves empty-ticker rows static.
    // Self-skip if every row in the fixture is unclickable (theoretical, since
    // dedupe at line 5498 filters empty-key rows, but defensive).
    const clickableRow = tableDetails.locator("tbody tr[onclick]").first();
    test.skip(
      await clickableRow.count() === 0,
      "no clickable rows in calendar (all rows have empty tickerCell)"
    );

    await clickableRow.click();

    const backdrop = page.locator("#swsModalBackdrop");
    await expect(backdrop).toHaveClass(/open/, { timeout: 5_000 });

    // Hero is the structural anchor that proves renderSwsModal (or the
    // live-only fallback) reached the body — mirrors
    // stock-detail-modal.spec.mjs:44-45.
    const hero = page.locator("#swsModalBody .sws-modal-hero");
    await expect(hero, "#swsModalBody must contain .sws-modal-hero").toBeVisible({ timeout: 15_000 });

    // Silent-render-failure guard — a modal that opens with hero only and
    // no body sections is the High-tier regression flagged by the
    // 2026-05-16 audit. Mirrors stock-detail-modal.spec.mjs:52-56.
    const sectionCount = await page.locator("#swsModalBody .sws-modal-section").count();
    expect(
      sectionCount,
      "#swsModalBody must render at least one .sws-modal-section"
    ).toBeGreaterThan(0);

    // Lifecycle close — Escape must restore the page.
    await page.keyboard.press("Escape");
    await expect(backdrop).not.toHaveClass(/open/, { timeout: 5_000 });
  });
});
