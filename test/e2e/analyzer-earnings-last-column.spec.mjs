// E2E for the "Last earnings" column added to the Portfolio Analyzer's
// "Upcoming results calendar" table. Header text "Last earnings" must
// appear in the table, and every row's value in that column must either
// equal "—" (no SWS brief and no fundamentalsHistory coverage) or match
// the "DD Mon YYYY (quarter|annual)" shape emitted by the renderer in
// gated/app.js.
//
// Self-skips when the calendar section doesn't render — same convention
// as analyzer-earnings-calendar.spec.mjs and the rest of the analyzer
// specs that depend on live-price-gated rendering.

import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { gotoApp } from "./helpers/app.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures", "groww-sample.xlsx");

test.describe("Portfolio Analyzer — Last earnings column", () => {
  test.skip(!existsSync(FIXTURE), "fixture missing");

  test("header is present and every cell matches '—' or 'DD Mon YYYY (quarter|annual)'", async ({ page }) => {
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
    await expect(tableDetails).toHaveAttribute("open", /.*/);

    // Header text must contain the new column.
    const header = tableDetails.locator("thead tr");
    await expect(header).toContainText("Last earnings");

    const tableRows = tableDetails.locator("tbody tr");
    const rowCount = await tableRows.count();
    expect(rowCount).toBeGreaterThan(0);

    // The "Last earnings" column sits at td index 4 (zero-based):
    //   0=#  1=Stock  2=Sector  3=Position  4=Last earnings  5=Result date  6=Days until
    const VALID = /^(—|\d{1,2}\s+[A-Za-z]{3}\s+\d{4}(\s*\((quarter|annual)\))?)$/;

    // Track coverage so the assertion isn't satisfied purely by "—" — if the
    // fixture's tickers all map to covered SWS/fundamentals data, at least
    // one row should carry a real date. (If every row is "—" we don't fail —
    // the fixture might lean small-cap with sparse SWS coverage — but we
    // surface a warning via expect.soft below.)
    let datedRows = 0;
    for (let i = 0; i < rowCount; i++) {
      const text = (await tableRows.nth(i).locator("td").nth(4).innerText()).trim();
      expect(text, `row ${i} "${text}" does not match Last-earnings cell shape`).toMatch(VALID);
      if (text !== "—") datedRows++;
    }

    // Soft check — at least one row in a real-world fixture should carry a
    // date. If every row is "—" the renderer is technically correct but
    // the data plumbing might be broken; flag without failing.
    expect.soft(datedRows, "expected ≥1 row to carry a dated last-earnings cell").toBeGreaterThan(0);
  });
});
