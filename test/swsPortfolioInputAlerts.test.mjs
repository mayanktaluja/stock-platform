/**
 * Run with: node test/swsPortfolioInputAlerts.test.mjs
 *
 * Covers the signal-field filter that powers both the Portfolio Analyzer
 * "SWS input changes" panel and the email digest: only the 5 snowflake pillars
 * + material fair_value.fair_value_inr + fair_value.upside_band survive; aliases
 * are normalized to canonical and deduped; noise (statements.*, snowflake.total,
 * v4_*, metadata, fiscal/forecast) and sub-2% FV moves are dropped; alerts left
 * empty are removed; alert severity + change_hash are recomputed from survivors.
 */

import assert from "node:assert/strict";
import {
  classifySwsInputAlertImpact,
  classifySwsInputChangeImpact,
  formatAlertChangeSummary,
  formatAlertFieldLabel,
  formatAlertImpactLabel,
  buildPortfolioSwsInputAlerts,
  buildSwsInputAlertEmail,
  canonicalizeHoldingTicker,
  digestPortfolioChanges,
  filterSignalChanges,
  formatAlertStockLabel,
  isMaterialFairValueChange,
  normalizeReductionHighlights,
  normalizeSwsInputAlertPrefs,
} from "../services/swsPortfolioInputAlerts.js";
import { stableHash } from "../services/swsInputSnapshot.js";

// --- filterSignalChanges --------------------------------------------------

// Keeps the 5 canonical pillars.
{
  const changes = ["value", "future", "past", "health", "dividend"].map((p) => ({
    field: `snowflake.${p}`,
    previous: 1,
    current: 2,
    severity: "medium",
  }));
  assert.deepEqual(
    filterSignalChanges(changes).map((c) => c.field).sort(),
    ["snowflake.dividend", "snowflake.future", "snowflake.health", "snowflake.past", "snowflake.value"],
  );
}

// Keeps material fair_value.fair_value_inr and fair_value.upside_band.
{
  const out = filterSignalChanges([
    { field: "fair_value.fair_value_inr", previous: 100, current: 110, severity: "medium" },
    { field: "fair_value.upside_band", previous: "FAIR", current: "DISCOUNT", severity: "medium" },
  ]);
  assert.equal(out.length, 2, "fair value + upside band kept");
}

// Fair value moves must clear a strict 2% materiality threshold unless they are
// availability/quality transitions.
assert.equal(isMaterialFairValueChange({ previous: 100, current: 102 }), false, "exactly 2% is suppressed");
assert.equal(isMaterialFairValueChange({ previous: 100, current: 102.01 }), true, "more than 2% is kept");
assert.equal(isMaterialFairValueChange({ previous: null, current: 120 }), true, "FV availability is kept");
assert.equal(isMaterialFairValueChange({ previous: 120, current: null }), true, "FV unavailability is kept");
assert.equal(isMaterialFairValueChange({ previous: 0, current: 10 }), true, "zero baseline is kept");
assert.equal(isMaterialFairValueChange({ previous: -100, current: -103 }), true, "negative baseline uses absolute previous");
assert.deepEqual(
  filterSignalChanges([{ field: "fair_value.fair_value_inr", previous: 100, current: 102, severity: "medium" }]),
  [],
  "sub-threshold FV-only changes are dropped",
);

// Drops all the noise fields.
{
  const noise = [
    "statements.rewards",
    "statements.risks",
    "snowflake.total",
    "snowflake.data_quality",
    "v4_score",
    "v4_verdict",
    "fair_value.fair_value_confidence",
    "fair_value.fair_value_source",
    "fair_value.fv_reconcile_reason",
    "fiscal",
    "forecast",
  ].map((field) => ({ field, previous: 1, current: 2, severity: "medium" }));
  assert.equal(filterSignalChanges(noise).length, 0, "every noise field dropped");
}

// Rewrites aliases to canonical and dedupes against the canonical form.
{
  const out = filterSignalChanges([
    { field: "snowflake.valuation", previous: 3, current: 4, severity: "medium" },
    { field: "snowflake.value", previous: 3, current: 4, severity: "medium" },
    { field: "snowflake.future_growth", previous: 1, current: 2, severity: "medium" },
  ]);
  // valuation -> value (kept first), value (dup, dropped), future_growth -> future
  assert.deepEqual(out.map((c) => c.field), ["snowflake.value", "snowflake.future"]);
}

// Alias-only input still surfaces the pillar under the canonical label.
{
  const out = filterSignalChanges([
    { field: "snowflake.dividends", previous: 2, current: 1, severity: "medium" },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].field, "snowflake.dividend");
}

// Non-array / empty input is safe.
assert.deepEqual(filterSignalChanges(null), []);
assert.deepEqual(filterSignalChanges(undefined), []);

// --- helpers + prefs (unchanged behaviour) --------------------------------

assert.equal(canonicalizeHoldingTicker({ symbol: "TCS.NS" }), "TCS");
assert.equal(canonicalizeHoldingTicker({ ticker: "infy.bo" }), "INFY");
assert.deepEqual(normalizeSwsInputAlertPrefs({}), { inApp: true, email: true });
assert.deepEqual(normalizeSwsInputAlertPrefs({ email: false }), { inApp: true, email: false });
assert.deepEqual(normalizeSwsInputAlertPrefs({ inApp: false, email: true }), { inApp: false, email: true });

// --- impact classification -------------------------------------------------

assert.equal(
  classifySwsInputChangeImpact({ field: "snowflake.value", previous: 1, current: 3 }),
  "positive",
  "higher snowflake pillar is positive",
);
assert.equal(
  classifySwsInputChangeImpact({ field: "snowflake.future", previous: 4, current: 3 }),
  "negative",
  "lower snowflake pillar is negative",
);
assert.equal(
  classifySwsInputChangeImpact({ field: "fair_value.fair_value_inr", previous: 100, current: 110 }),
  "positive",
  "higher finite fair value is positive",
);
assert.equal(
  classifySwsInputChangeImpact({ field: "fair_value.fair_value_inr", previous: 100, current: null }),
  "changed",
  "fair value availability loss is not forced into positive/negative",
);
assert.equal(
  classifySwsInputChangeImpact({ field: "fair_value.upside_band", previous: "DISCOUNT", current: "FAIR" }),
  "negative",
  "discount to fair is less attractive",
);
assert.equal(
  classifySwsInputChangeImpact({ field: "fair_value.upside_band", previous: "VERY_EXPENSIVE", current: "FAIR" }),
  "positive",
  "very expensive to fair is more attractive",
);
assert.equal(
  classifySwsInputAlertImpact([
    { field: "snowflake.value", previous: 2, current: 3 },
    { field: "snowflake.future", previous: 4, current: 3 },
  ]),
  "mixed",
);
assert.equal(formatAlertImpactLabel("positive"), "Positive");

// --- buildPortfolioSwsInputAlerts integration -----------------------------

const market = {
  run_id: "run-1",
  alerts: [
    {
      ticker: "TCS",
      name: "TCS",
      severity: "high",
      change_hash: "stale",
      changes: [
        { field: "snowflake.total", previous: 10, current: 14, severity: "high" },   // noise (dropped)
        { field: "snowflake.future", previous: 4, current: 3, severity: "medium" },  // signal
        { field: "statements.rewards", previous: 6, current: 6, severity: "medium" },// noise (dropped)
      ],
    },
    {
      ticker: "INFY",
      name: "Infosys",
      severity: "medium",
      change_hash: "b",
      changes: [{ field: "fair_value.fair_value_inr", previous: 100, current: 110, severity: "medium" }],
    },
    {
      // Held but only sub-threshold FV movement -> dropped.
      ticker: "ALEMBICLTD",
      name: "Alembic Limited",
      severity: "medium",
      change_hash: "tiny-fv",
      changes: [{ field: "fair_value.fair_value_inr", previous: 723.48, current: 725, severity: "medium" }],
    },
    {
      // Held but only noise -> dropped entirely from the panel/email.
      ticker: "WIPRO",
      name: "Wipro",
      severity: "medium",
      change_hash: "c",
      changes: [{ field: "statements.risks", previous: 2, current: 3, severity: "medium" }],
    },
    {
      // Market-wide unrelated changes must not inflate a portfolio user's suppressed count.
      ticker: "OUTSIDE",
      name: "Outside Portfolio",
      severity: "medium",
      change_hash: "outside",
      changes: [{ field: "snowflake.future", previous: 1, current: 2, severity: "medium" }],
    },
  ],
};

const analyzerStore = {
  async read() {
    return { holdings: [{ symbol: "TCS.NS" }, { symbol: "WIPRO.NS" }, { symbol: "ALEMBICLTD.NS" }] };
  },
};
const fallbackAnalyzerStore = { async read() { return null; } };
const portfolioStore = {
  async read() {
    return { stocks: [{ symbol: "INFY.BO" }] };
  },
};

const analyzerFirst = await buildPortfolioSwsInputAlerts("sub", market, { analyzerStore, portfolioStore });
assert.equal(analyzerFirst.source, "analyzer");
// TCS survives (its one signal field), WIPRO dropped (noise-only), INFY not held.
assert.deepEqual(analyzerFirst.alerts.map((a) => a.ticker), ["TCS"]);
const tcs = analyzerFirst.alerts[0];
assert.deepEqual(tcs.changes.map((c) => c.field), ["snowflake.future"], "noise stripped within the alert");
assert.equal(tcs.severity, "medium", "severity recomputed after dropping the high noise change");
assert.equal(tcs.change_hash, stableHash(tcs.changes), "change_hash recomputed from filtered changes");
assert.notEqual(tcs.change_hash, "stale");
assert.equal(analyzerFirst.suppressed_count, 2, "only held noise/sub-threshold alerts count as suppressed");
assert.equal(
  analyzerFirst.digest,
  digestPortfolioChanges([{ ...tcs, change_hash: stableHash(tcs.changes) }]),
  "digest excludes unrelated and sub-threshold-only alerts",
);

const fallback = await buildPortfolioSwsInputAlerts("sub", market, { analyzerStore: fallbackAnalyzerStore, portfolioStore });
assert.equal(fallback.source, "portfolio");
assert.deepEqual(fallback.alerts.map((a) => a.ticker), ["INFY"]);
assert.deepEqual(fallback.alerts[0].changes.map((c) => c.field), ["fair_value.fair_value_inr"]);

// --- email body (now lists only signal fields) ----------------------------

const email = buildSwsInputAlertEmail({ alerts: analyzerFirst.alerts, runId: "run-1" });
assert.equal(email.subject, "SWS inputs changed for TCS");
assert.match(email.text, /Affected stock: TCS/);
assert.match(email.text, /TCS - Negative impact/);
assert.match(email.text, /- Negative impact: Future growth changed from 4 to 3/);
assert.doesNotMatch(email.text, /statements\./, "no noise fields leak into the email");
assert.doesNotMatch(email.text, /Alembic/, "sub-threshold FV alert does not leak into email text");
assert.match(email.html, /SWS inputs changed for TCS/);
assert.match(email.html, /<table role="presentation"/);
assert.match(email.html, />Stock</);
assert.match(email.html, />Impact</);
assert.match(email.html, />Signal</);
assert.doesNotMatch(email.html, />Severity</);
assert.match(email.html, /Future growth/);
assert.match(email.html, /Negative/);
assert.match(email.html, /#fee2e2/);
assert.doesNotMatch(email.html, /snowflake\.future/, "developer field labels do not leak into email HTML");
assert.doesNotMatch(email.html, /medium severity/i, "email does not repeat raw diff severity");
assert.match(email.text, /Review the Starbhai score\/report/);
assert.match(email.text, /no buy\/sell instruction/i);
assert.doesNotMatch(email.text, /(buy|sell)\s+TCS/i);

const reductionEmail = buildSwsInputAlertEmail({
  alerts: analyzerFirst.alerts,
  runId: "run-1",
  reductionHighlights: [{
    ticker: "TCS",
    name: "TCS",
    action: "Reduction-50%",
    tradeRupees: 99_000,
    reasons: ["Engine emitted Reduction-50% after evidence gate.", "SWS data is stale; verify price/FV before acting."],
  }],
});
assert.match(reductionEmail.text, /Portfolio Analyzer reduction review/);
assert.ok(
  reductionEmail.text.indexOf("Portfolio Analyzer reduction review") < reductionEmail.text.indexOf("TCS - Negative impact"),
  "reduction review renders before the SWS input-change detail",
);
assert.match(reductionEmail.text, /TCS - Reduction-50% review; estimated trim amount INR 99,000/);
assert.match(reductionEmail.text, /Please open Starbhai and verify before acting/);
assert.doesNotMatch(reductionEmail.text, /sell\s+TCS/i, "reduction highlight avoids direct trade instruction language");
assert.match(reductionEmail.html, /Portfolio Analyzer reduction review/);
assert.match(reductionEmail.html, /Analyzer action/);
assert.match(reductionEmail.html, /INR 99,000/);
assert.equal(normalizeReductionHighlights([{ ticker: "TCS" }]).length, 0, "missing action is not renderable as a reduction highlight");

const multiEmail = buildSwsInputAlertEmail({
  alerts: [analyzerFirst.alerts[0], fallback.alerts[0]],
  runId: "run-1",
});
assert.equal(multiEmail.subject, "SWS inputs changed for 2 portfolio holding(s)");
assert.match(multiEmail.text, /Affected stocks: TCS, Infosys \(INFY\)/);
assert.match(multiEmail.text, /Fair value changed from INR 100 to INR 110 \(\+10\.00%\)/);
assert.match(multiEmail.text, /Infosys \(INFY\) - Positive impact/);
assert.match(multiEmail.html, /Fair value/);
assert.match(multiEmail.html, /INR 100/);
assert.match(multiEmail.html, /\+10\.00%/);
assert.match(multiEmail.html, /Positive/);
assert.match(multiEmail.html, /#dcfce7/);

const changedEmail = buildSwsInputAlertEmail({
  alerts: [{
    ticker: "NULLFV",
    name: "Null Fair Value",
    changes: [{ field: "fair_value.fair_value_inr", previous: null, current: 120 }],
  }],
  runId: "run-1",
});
assert.match(changedEmail.text, /Changed impact: Fair value changed from n\/a to INR 120 \(Availability change\)/);
assert.match(changedEmail.html, /Changed/);

assert.equal(formatAlertStockLabel({ ticker: "INFY", name: "Infosys" }), "Infosys (INFY)");
assert.equal(
  formatAlertChangeSummary({ field: "snowflake.future", previous: 4, current: 3 }),
  "Future growth changed from 4 to 3",
);
assert.equal(formatAlertFieldLabel("fair_value.fair_value_inr"), "Fair value");

console.log("swsPortfolioInputAlerts tests passed");
