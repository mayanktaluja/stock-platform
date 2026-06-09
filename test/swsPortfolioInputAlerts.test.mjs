/**
 * Run with: node test/swsPortfolioInputAlerts.test.mjs
 */

import assert from "node:assert/strict";
import {
  formatAlertChangeSummary,
  buildPortfolioSwsInputAlerts,
  buildSwsInputAlertEmail,
  canonicalizeHoldingTicker,
  formatAlertStockLabel,
  normalizeSwsInputAlertPrefs,
} from "../services/swsPortfolioInputAlerts.js";

const market = {
  run_id: "run-1",
  alerts: [
    { ticker: "TCS", name: "TCS", change_hash: "a", changes: [{ field: "snowflake.total", previous: 10, current: 14 }] },
    { ticker: "INFY", name: "Infosys", change_hash: "b", changes: [{ field: "forecast", previous: "old", current: "new" }] },
  ],
};

const analyzerStore = {
  async read() {
    return { holdings: [{ symbol: "TCS.NS" }] };
  },
};
const fallbackAnalyzerStore = { async read() { return null; } };
const portfolioStore = {
  async read() {
    return { stocks: [{ symbol: "INFY.BO" }] };
  },
};

assert.equal(canonicalizeHoldingTicker({ symbol: "TCS.NS" }), "TCS");
assert.equal(canonicalizeHoldingTicker({ ticker: "infy.bo" }), "INFY");
assert.deepEqual(normalizeSwsInputAlertPrefs({}), { inApp: true, email: false });
assert.deepEqual(normalizeSwsInputAlertPrefs({ inApp: false, email: true }), { inApp: false, email: true });

const analyzerFirst = await buildPortfolioSwsInputAlerts("sub", market, { analyzerStore, portfolioStore });
assert.equal(analyzerFirst.source, "analyzer");
assert.deepEqual(analyzerFirst.alerts.map((a) => a.ticker), ["TCS"]);
assert.equal(analyzerFirst.suppressed_count, 1);

const fallback = await buildPortfolioSwsInputAlerts("sub", market, { analyzerStore: fallbackAnalyzerStore, portfolioStore });
assert.equal(fallback.source, "portfolio");
assert.deepEqual(fallback.alerts.map((a) => a.ticker), ["INFY"]);

const email = buildSwsInputAlertEmail({ alerts: analyzerFirst.alerts, runId: "run-1" });
assert.equal(email.subject, "SWS inputs changed for TCS");
assert.match(email.text, /Affected stock: TCS/);
assert.match(email.text, /What changed: snowflake\.total changed from 10 to 14/);
assert.match(email.text, /- snowflake\.total changed from 10 to 14/);
assert.match(email.html, /Affected stock: TCS/);
assert.match(email.text, /Review the Starbhai score\/report/);
assert.match(email.text, /no buy\/sell instruction/i);
assert.doesNotMatch(email.text, /(buy|sell)\s+TCS/i);

const multiEmail = buildSwsInputAlertEmail({ alerts: market.alerts, runId: "run-1" });
assert.equal(multiEmail.subject, "SWS inputs changed for 2 portfolio holding(s)");
assert.match(multiEmail.text, /Affected stocks: TCS, Infosys \(INFY\)/);
assert.equal(formatAlertStockLabel({ ticker: "INFY", name: "Infosys" }), "Infosys (INFY)");
assert.equal(formatAlertChangeSummary({ field: "forecast", previous: "old", current: "new" }), "forecast changed from old to new");

console.log("swsPortfolioInputAlerts tests passed");
