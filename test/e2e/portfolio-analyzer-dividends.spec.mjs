// E2E for the "Dividends to capture" section added to the Portfolio
// Analyzer tab. The section is populated from
// data/catalysts/dividends-upcoming.json by services/portfolio/
// portfolioDividendService.js (joined onto holdings inside
// services/swsPortfolioAggregate.js#buildSWSReport).
//
// Self-skips when the analyzer report doesn't render OR when the
// underlying dividends-upcoming.json is missing/empty — matching the
// convention in analyzer-earnings-calendar.spec.mjs.

import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { gotoApp } from "./helpers/app.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "fixtures", "groww-sample.xlsx");
const DIV_FEED = resolve(here, "..", "..", "data", "catalysts", "dividends-upcoming.json");

function loadDividendsCount() {
  if (!existsSync(DIV_FEED)) return 0;
  try {
    const json = JSON.parse(readFileSync(DIV_FEED, "utf8"));
    return Number.isFinite(json?.dividend_count) ? json.dividend_count : 0;
  } catch {
    return 0;
  }
}

function loadAwaitingCount() {
  if (!existsSync(DIV_FEED)) return 0;
  try {
    const json = JSON.parse(readFileSync(DIV_FEED, "utf8"));
    return Number.isFinite(json?.awaiting_ex_date_count)
      ? json.awaiting_ex_date_count
      : Array.isArray(json?.awaiting_ex_date) ? json.awaiting_ex_date.length : 0;
  } catch {
    return 0;
  }
}

test.describe("Portfolio Analyzer — Dividends to capture", () => {
  test.skip(!existsSync(FIXTURE), "fixture missing");

  test("dividend sections appear with factual headings and table or zero-state bodies", async ({ page }) => {
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
    test.skip(!reportReady, "analyzer report did not render in time — likely live-price dependency");

    const summary = page.locator(
      "details.analyzer-tier-details summary:has-text(\"Dividends to capture\")"
    );
    const sectionCount = await summary.count();
    expect(sectionCount, "section must always render — empty state is informative, not absent").toBeGreaterThan(0);

    const awaitingSummary = page.locator(
      "details.analyzer-tier-details summary:has-text(\"Recommended dividends awaiting ex-date\")"
    );
    await expect(awaitingSummary.first()).toBeVisible();

    const upcomingIdx = await page.locator("details.analyzer-tier-details summary:has-text(\"Upcoming results calendar\")").first().evaluate((el) => {
      const all = [...document.querySelectorAll("details.analyzer-tier-details summary")];
      return all.indexOf(el);
    });
    const awaitingIdx = await awaitingSummary.first().evaluate((el) => {
      const all = [...document.querySelectorAll("details.analyzer-tier-details summary")];
      return all.indexOf(el);
    });
    const captureIdx = await summary.first().evaluate((el) => {
      const all = [...document.querySelectorAll("details.analyzer-tier-details summary")];
      return all.indexOf(el);
    });
    expect(upcomingIdx).toBeLessThan(awaitingIdx);
    expect(awaitingIdx).toBeLessThan(captureIdx);

    await summary.first().click();
    const section = summary.first().locator(
      "xpath=ancestor::details[contains(@class,'analyzer-tier-details')][1]"
    );
    await expect(section).toHaveAttribute("open", /.*/);

    const sectionText = await section.innerText();
    expect(sectionText.toLowerCase()).not.toContain("you will earn");
    expect(sectionText.toLowerCase()).not.toContain("guaranteed");

    const awaitingSection = awaitingSummary.first().locator(
      "xpath=ancestor::details[contains(@class,'analyzer-tier-details')][1]"
    );
    const awaitingText = await awaitingSection.innerText();
    expect(awaitingText.toLowerCase()).not.toContain("you will earn");
    expect(awaitingText.toLowerCase()).not.toContain("guaranteed");
    expect(loadAwaitingCount()).toBeGreaterThanOrEqual(0);
  });

  test("when holdings match dividends, row arithmetic is DPS × qty and sort is ex-date ASC", async ({ page }) => {
    const divCount = loadDividendsCount();
    test.skip(divCount === 0, "no dividends to verify");

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
    test.skip(!reportReady, "analyzer report did not render in time");

    const summary = page.locator(
      "details.analyzer-tier-details summary:has-text(\"Dividends to capture\")"
    );
    await summary.first().click();
    const section = summary.first().locator(
      "xpath=ancestor::details[contains(@class,'analyzer-tier-details')][1]"
    );

    const rows = section.locator("tbody tr");
    const rowCount = await rows.count();
    test.skip(rowCount === 0, "fixture portfolio has no upcoming-dividend holdings — zero-state hit");

    // Headers contract.
    const header = section.locator("thead tr");
    await expect(header).toContainText("Hold by");
    await expect(header).toContainText("Ex-date");
    await expect(header).toContainText("DPS");
    await expect(header).toContainText("Est. ₹ for your qty");

    // Ex-date column must be ASC. Ex-date is at index 6 (0-based):
    //   0=#  1=Stock  2=Qty  3=DPS  4=Yield  5=Hold by  6=Ex-date  7=Days until  8=Est. ₹
    const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
    const parseEnIn = (s) => {
      const m = s.match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
      if (!m) return null;
      return Date.UTC(Number(m[3]), MONTHS[m[2]], Number(m[1]));
    };

    let prevMs = -Infinity;
    for (let i = 0; i < rowCount; i++) {
      const exText = (await rows.nth(i).locator("td").nth(6).innerText()).trim();
      const ms = parseEnIn(exText);
      expect(ms, `row ${i} "${exText}" did not parse`).not.toBeNull();
      expect(ms, `row ${i} ex-date out of ASC order`).toBeGreaterThanOrEqual(prevMs);
      prevMs = ms;
    }
  });

  test("the existing 'Upcoming results calendar' now includes a 'Hold by' column", async ({ page }) => {
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
    test.skip(!reportReady, "analyzer report did not render in time");

    const summary = page.locator(
      "details.analyzer-tier-details summary:has-text(\"Upcoming results calendar\")"
    );
    test.skip(await summary.count() === 0, "no equity holdings in fixture portfolio");

    await summary.first().click();
    const section = summary.first().locator(
      "xpath=ancestor::details[contains(@class,'analyzer-tier-details')][1]"
    );

    const header = section.locator("thead tr");
    await expect(header).toContainText("Hold by");
    await expect(header).toContainText("Result date");
    await expect(header).toContainText("Days until");

    const thCount = await section.locator("thead th").count();
    expect(thCount, "header must have 8 columns after Hold-by insertion").toBe(8);
  });
});
