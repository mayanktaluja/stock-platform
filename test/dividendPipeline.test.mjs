import assert from "node:assert/strict";
import {
  buildPreservedDividendPayload,
  extractAwaitingDividendsFromDeep,
  extractAwaitingDividendsFromNseAnnouncements,
  extractBseActionDividendRows,
  extractGrowwDividendRows,
  extractNseActionDividendRows,
  mergeAwaitingDividendRows,
  mergeConfirmedDividendRows,
  parseDividendAmount,
  parseMarketDate,
} from "../services/dividends/dividendPipeline.js";

let pass = 0, fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log("  ✓", name);
  } catch (err) {
    fail++;
    console.log("  ✗", name, "→", err.message);
  }
}

console.log("\ndividendPipeline tests\n");

check("parseMarketDate normalizes Groww UTC midnight-equivalent to IST market date", () => {
  assert.equal(parseMarketDate("2026-06-04T18:30:00.000Z"), "2026-06-05");
  assert.equal(parseMarketDate("05-Jun-2026"), "2026-06-05");
  assert.equal(parseMarketDate("05 Jun 2026"), "2026-06-05");
});

check("parseDividendAmount handles rupee formats and can sum special dividends", () => {
  assert.equal(parseDividendAmount("₹13.00"), 13);
  assert.equal(parseDividendAmount("Dividend - Rs 8.50 Per Share"), 8.5);
  assert.equal(parseDividendAmount("Dividend - Rs 8.35 Per Share & Special Dividend - Rs 3.35 Per Share", { sumAll: true }), 11.7);
});

check("Groww extractor dedupes announced/ex-date duplicate rows and keeps future rows", () => {
  const cache = {
    fetched_at: "2026-06-04T20:00:00.000Z",
    by_ticker: {
      ADANIPORTS: {
        events: [
          { title: "Dividend", type: "DIVIDEND", status: "Announced", announcement_date: "2026-05-27T18:30:00.000Z", ex_date: "2026-06-11T18:30:00.000Z", record_date: "2026-06-11T18:30:00.000Z", value: "₹7.50" },
          { title: "Dividend", type: "DIVIDEND", status: "Ex date", primary_date: "2026-06-11T18:30:00.000Z", ex_date: "2026-06-11T18:30:00.000Z", record_date: "2026-06-11T18:30:00.000Z", value: "₹7.50" },
          { title: "Dividend", type: "DIVIDEND", ex_date: "2025-06-11T18:30:00.000Z", record_date: "2025-06-11T18:30:00.000Z", value: "₹6.00" },
        ],
      },
    },
  };
  const out = extractGrowwDividendRows(cache, {
    todayIso: "2026-06-05",
    nowMs: Date.parse("2026-06-05T00:00:00.000Z"),
    maxAgeDays: 3,
  });
  assert.equal(out.status.usable, true);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].symbol, "ADANIPORTS");
  assert.equal(out.rows[0].ex_date, "2026-06-12");
  assert.equal(out.rows[0].dps, 7.5);
  assert.equal(out.rows[0].source, "groww-events");
});

check("Groww extractor returns no rows when cache is stale", () => {
  const out = extractGrowwDividendRows(
    { fetched_at: "2026-05-29T00:00:00.000Z", by_ticker: { X: { events: [] } } },
    { nowMs: Date.parse("2026-06-05T00:00:00.000Z"), maxAgeDays: 3 },
  );
  assert.equal(out.status.usable, false);
  assert.equal(out.rows.length, 0);
});

check("NSE/BSE extractors parse confirmed dividend action rows", () => {
  const nse = extractNseActionDividendRows([
    { symbol: "TATATECH", exDate: "18-Jun-2026", recDate: "18-Jun-2026", subject: "Dividend - Rs 8.35 Per Share & Special Dividend - Rs 3.35 Per Share" },
  ], { todayIso: "2026-06-05" });
  assert.equal(nse.length, 1);
  assert.equal(nse[0].dps, 11.7);

  const bse = extractBseActionDividendRows([
    { short_name: "HDFCBANK", Ex_date: "19 Jun 2026", RD_Date: "19 Jun 2026", Purpose: "Final Dividend - Rs. - 13.0000" },
    { short_name: "HDFCBANK#", Ex_date: "19 Jun 2026", RD_Date: "19 Jun 2026", Purpose: "Final Dividend - Rs. - 13.0000" },
  ], { todayIso: "2026-06-05" });
  assert.equal(bse.length, 1);
  assert.equal(bse[0].dps, 13);
});

check("confirmed merge prefers Groww, then NSE/BSE/SWS fallback", () => {
  const merged = mergeConfirmedDividendRows([
    { symbol: "RELIANCE", ex_date: "2026-06-05", dps: 6, source: "nse-actions" },
    { symbol: "RELIANCE", ex_date: "2026-06-05", dps: 6, source: "groww-events" },
    { symbol: "HDFCBANK", ex_date: "2026-06-19", dps: 13, source: "nse-actions" },
    { symbol: "INFY", ex_date: "2026-06-10", dps: 25, source: "bse-actions" },
  ], { growwUsable: true });
  assert.equal(merged.length, 3);
  assert.equal(merged.find((r) => r.symbol === "RELIANCE")?.source, "groww-events");
  assert.equal(merged.find((r) => r.symbol === "HDFCBANK")?.source, "nse-actions");
});

check("awaiting extractors keep recommendations separate from confirmed rows", () => {
  const sws = extractAwaitingDividendsFromDeep({
    ticker: "NETWEB",
    news: [{
      date: "2026-05-02T00:00:00.000Z",
      title: "Netweb Technologies India Limited Recommends Final Dividend",
      body: "recommended a final Dividend of INR 3 per Equity Share, subject to shareholder approval at the ensuing AGM.",
    }],
  });
  const nse = extractAwaitingDividendsFromNseAnnouncements([
    { symbol: "HGS", announced_at_iso: "2026-06-04", classification: "DIVIDEND", subject: "to consider recommendation/ declaration of dividend, if any." },
  ]);
  const merged = mergeAwaitingDividendRows([...sws, ...nse], [{ symbol: "HGS", ex_date: "2026-06-20" }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].symbol, "NETWEB");
  assert.equal(merged[0].dps, 3);
});

check("preservation payload keeps prior non-empty cache and marks metadata", () => {
  const prior = { built_at: "old", today_iso: "2026-06-04", dividends: [{ symbol: "X", ex_date: "2026-06-10" }] };
  const preserved = buildPreservedDividendPayload(prior, {
    reason: "zero-confirmed-dividends",
    attemptedCounts: { groww_events: 0 },
    todayIso: "2026-06-05",
  });
  assert.equal(preserved.preserved_from_prior, true);
  assert.equal(preserved.dividends.length, 1);
  assert.equal(preserved.preservation.reason, "zero-confirmed-dividends");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

