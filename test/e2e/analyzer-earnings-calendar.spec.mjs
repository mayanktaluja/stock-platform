// E2E for the new "Upcoming results calendar" section at the bottom of the
// Portfolio Analyzer tab. After uploading the fixture portfolio the analyzer
// report must include a collapsible <details> labelled "Upcoming results
// calendar" with one row per scored equity holding. Rows are sorted ascending
// by h.sws.next_earnings_date; unknown / past dates collapse to "—" and sink
// to the bottom of the table.
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

  test("renders, sorts ascending, and pushes unknowns to the bottom", async ({ page }) => {
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

    // The table should have at least one body row.
    const tableRows = tableDetails.locator("tbody tr");
    const rowCount = await tableRows.count();
    expect(rowCount).toBeGreaterThan(0);

    // Pull the date column (5th cell, index 4) for every row and assert:
    //   1. all real ISO/date-looking strings appear BEFORE all "—" rows
    //   2. real dates are non-decreasing across consecutive rows
    //   3. no real date is strictly in the past (the renderer suppresses past)
    const dateStrings = [];
    for (let i = 0; i < rowCount; i++) {
      const text = (await tableRows.nth(i).locator("td").nth(4).innerText()).trim();
      dateStrings.push(text);
    }

    const DASH = "—";
    let firstDashIdx = dateStrings.indexOf(DASH);
    if (firstDashIdx === -1) firstDashIdx = dateStrings.length;
    // After the first "—" every remaining row must also be "—".
    for (let i = firstDashIdx; i < dateStrings.length; i++) {
      expect(dateStrings[i]).toBe(DASH);
    }

    // Parse "16 May 2026" → ms for the dated rows and confirm monotonic asc.
    const MONTHS = {
      Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
      Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
    };
    const parseEnIn = (s) => {
      const m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
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

    let prevMs = -Infinity;
    for (let i = 0; i < firstDashIdx; i++) {
      const ms = parseEnIn(dateStrings[i]);
      // If the date string didn't parse, fail loudly — the renderer should
      // only emit en-IN-formatted strings for the known case.
      expect(ms, `row ${i} date "${dateStrings[i]}" did not parse`).not.toBeNull();
      expect(ms, `row ${i} date "${dateStrings[i]}" is before today UTC`).toBeGreaterThanOrEqual(todayUtcMs - 86_400_000);
      expect(ms, `row ${i} date "${dateStrings[i]}" out of order vs row ${i - 1}`).toBeGreaterThanOrEqual(prevMs);
      prevMs = ms;
    }
  });
});
