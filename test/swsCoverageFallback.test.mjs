// services/swsCoverageFallback.js unit tests.
//
// Audit gap: this 189-LOC module is the *only* path that emits a verdict
// for stocks SWS doesn't cover yet (recently demerged entities, fresh
// listings, out-of-universe names). Without it, a holding like TMCV
// (12% of the user's real book per the module docstring) would surface
// in the UI with `swsCovered: false, action: null` — i.e. zero opinion.
// With it, the user gets a low-confidence v2 verdict tagged
// `fallback_source: "fundamentalsV2"`. Until this PR there was no
// regression-safety net around that gating logic.
//
// The module exports a single public entrypoint, `buildFallbackHolding`,
// which decides:
//   1. Can we normalise the ticker to an `.NS` key? If not → null.
//   2. Is there a `fundamentals.json` snapshot for that key? If not → null.
//   3. Does fundamentalsV2.scoreFundamentalsV2 produce a result? If not → null.
//   4. Otherwise synthesise an SWS-shaped result (snowflake, v4 score, action
//      band, v2_recommendation narrative) so the UI can render it.
//
// These tests exercise all four branches via the real fundamentals.json
// (744 NSE names — RELIANCE.NS is the stable anchor for the covered case).
// No mocks: the module reads from disk via a hard-coded path, and the
// fundamentalsV2 scorer is pure-data.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFallbackHolding } from "../services/swsCoverageFallback.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FUNDAMENTALS_PATH = path.resolve(__dirname, "..", "fundamentals.json");

let ok = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log("  ✓", name); ok += 1; }
  catch (e) { console.log("  ✗", name, "\n   ", e && e.message); fail += 1; }
}

// Pick a stable anchor that will exist in fundamentals.json for the
// foreseeable future. RELIANCE is the largest NSE name by market cap and
// will not be dropped from the universe; if it ever is, this test will
// fail loudly with a clear message — which is the desired behaviour.
const ANCHOR_TICKER = "RELIANCE";
const ANCHOR_KEY = "RELIANCE.NS";

// Sanity guard: bail fast with a useful message if the test's data
// precondition is missing (committed file is required for CI).
function loadAnchorSnapshot() {
  if (!fs.existsSync(FUNDAMENTALS_PATH)) {
    throw new Error(`fundamentals.json missing at ${FUNDAMENTALS_PATH} — test cannot run without it`);
  }
  const raw = JSON.parse(fs.readFileSync(FUNDAMENTALS_PATH, "utf-8"));
  const snap = raw?.snapshots?.[ANCHOR_KEY];
  if (!snap) throw new Error(`${ANCHOR_KEY} not in fundamentals.json — pick a different anchor`);
  return snap;
}

const anchorSnap = loadAnchorSnapshot();

/* ───────────────────── [1] uncovered → null branches ─────────────────── */

console.log("[1] returns null when the ticker can't be resolved");
it("null ticker → null", () => {
  assert.equal(buildFallbackHolding({ ticker: null }), null);
});
it("undefined ticker → null", () => {
  assert.equal(buildFallbackHolding({ ticker: undefined }), null);
});
it("empty-string ticker → null", () => {
  assert.equal(buildFallbackHolding({ ticker: "" }), null);
});
it("ticker not in fundamentals.json → null (no fallback possible)", () => {
  // A deliberately-bogus ticker that will never exist in any universe.
  const out = buildFallbackHolding({ ticker: "NO_SUCH_TICKER_XYZ_9999", name: "Bogus", sector: "Test" });
  assert.equal(out, null);
});

/* ───────────────────── [2] covered → synthesised fallback ────────────── */

console.log("[2] returns a synthesised fallback for fundamentals-covered stock");
it("RELIANCE returns a non-null fallback object", () => {
  const out = buildFallbackHolding({ ticker: ANCHOR_TICKER });
  assert.ok(out, "expected a fallback object for RELIANCE");
});
it("top-level fallback flags are stamped correctly", () => {
  const out = buildFallbackHolding({ ticker: ANCHOR_TICKER });
  assert.equal(out.swsCovered, false, "swsCovered must be false on the fallback path");
  assert.equal(out.fallback, true, "fallback marker must be true so UI can badge it");
  assert.equal(out.fallback_source, "fundamentalsV2", "fallback_source identifies the scorer");
});
it("preserves the user's holding fields via spread", () => {
  // Holdings carry user position metadata (qty, avgCost, weight…). The
  // fallback must not drop them — downstream code reads them for sizing.
  const userHolding = { qty: 42, avgCost: 1234.5, currency: "INR", customField: "keepme" };
  const out = buildFallbackHolding({ ticker: ANCHOR_TICKER, holding: userHolding });
  assert.equal(out.qty, 42);
  assert.equal(out.avgCost, 1234.5);
  assert.equal(out.currency, "INR");
  assert.equal(out.customField, "keepme");
});

/* ───────────────────── [3] sws block shape ───────────────────────────── */

console.log("[3] sws block has the SWS-mirror shape");
it("ticker stripped of .NS, score/verdict/snowflake present", () => {
  const out = buildFallbackHolding({ ticker: ANCHOR_TICKER, name: "Test Name", sector: "Energy" });
  assert.equal(out.sws.ticker, "RELIANCE", "stored ticker is the bare symbol, no .NS");
  assert.equal(out.sws.name, "Test Name", "explicit name takes precedence over snapshot.name");
  assert.equal(out.sws.sector, "Energy", "explicit sector takes precedence over snapshot.sector");
  assert.equal(out.sws.band, "FALLBACK", "band is hard-coded FALLBACK for the fallback path");
  assert.equal(typeof out.sws.score, "number");
  assert.ok(out.sws.score >= 0 && out.sws.score <= 100, `score must be 0..100, got ${out.sws.score}`);
  assert.equal(typeof out.sws.verdict, "string", "verdict surfaced from V2");
  // v4 is the v2 score with a -10 conservative haircut (or null if v2 is null).
  assert.equal(typeof out.sws.v4_score, "number");
  assert.equal(out.sws.v4_score, Math.max(0, out.sws.v2_score - 10), "v4 = max(0, v2 - 10)");
});
it("falls back to snapshot.name / snapshot.sector when caller omits them", () => {
  // Don't pass name/sector — module should read them from fundamentals.json.
  const out = buildFallbackHolding({ ticker: ANCHOR_TICKER });
  assert.equal(out.sws.name, anchorSnap.name, "name defaults to snapshot.name");
  assert.equal(out.sws.sector, anchorSnap.sector, "sector defaults to snapshot.sector");
});
it("snowflake is 5 pillars of 0..6 ints, total = sum of pillars", () => {
  const out = buildFallbackHolding({ ticker: ANCHOR_TICKER });
  const s = out.sws.snowflake;
  const pillars = ["valuation", "future_growth", "past_performance", "financial_health", "dividends"];
  for (const p of pillars) {
    assert.equal(typeof s[p], "number", `${p} must be a number`);
    assert.ok(Number.isInteger(s[p]), `${p} must be an integer`);
    assert.ok(s[p] >= 0 && s[p] <= 6, `${p} = ${s[p]} out of [0..6]`);
  }
  const expectedTotal = pillars.reduce((acc, p) => acc + s[p], 0);
  assert.equal(s.total, expectedTotal, "snowflake.total = sum(pillars)");
  assert.equal(out.sws.snowflake_total, s.total, "snowflake_total mirrors snowflake.total");
});
it("financial multiples are surfaced from the snapshot via num()", () => {
  const out = buildFallbackHolding({ ticker: ANCHOR_TICKER });
  // num() returns the value when finite, fallback (null here) otherwise.
  // For RELIANCE we know pe / priceToBook / marketCap are numeric.
  assert.equal(typeof out.sws.current_price_inr, "number");
  assert.equal(typeof out.sws.market_cap_inr, "number");
  assert.equal(typeof out.sws.multiples.pe, "number");
  // PS is hard-coded null (not in fundamentals schema yet).
  assert.equal(out.sws.multiples.ps, null);
  // FV / upside / next-earnings are always null on the fallback path.
  assert.equal(out.sws.fair_value_inr, null, "fair value is unavailable on fallback");
  assert.equal(out.sws.upside_pct, null, "upside is unavailable on fallback");
  assert.equal(out.sws.next_earnings_date, null);
});

/* ───────────────────── [4] v2_recommendation block ───────────────────── */

console.log("[4] v2_recommendation block is shaped for the UI");
it("LOW conviction is stamped on every fallback recommendation", () => {
  const out = buildFallbackHolding({ ticker: ANCHOR_TICKER });
  const rec = out.sws.v2_recommendation;
  assert.ok(rec, "v2_recommendation must be present");
  assert.equal(rec.version, "v2-fallback");
  assert.equal(rec.conviction, "LOW", "fallback verdicts MUST be LOW conviction — we lack SWS catalyst/news overlay");
  assert.equal(rec.action_source, "fallback");
  assert.equal(rec.agreement.fallback, true);
  // Layer votes are zeroed because no layer fires on the fallback path.
  assert.equal(rec.layer_votes.crosscheck, 0);
  assert.equal(rec.layer_votes.catalyst, 0);
  assert.equal(rec.layer_votes.indianRisk, 0);
});
it("narrative is a 3-paragraph array of non-empty strings", () => {
  const out = buildFallbackHolding({ ticker: ANCHOR_TICKER });
  const paras = out.sws.v2_recommendation.narrative_paragraphs;
  assert.ok(Array.isArray(paras), "narrative_paragraphs must be an array");
  assert.equal(paras.length, 3, "exactly 3 paragraphs");
  for (const p of paras) {
    assert.equal(typeof p, "string");
    assert.ok(p.length > 0, "each paragraph must be non-empty");
  }
});
it("counter_thesis + falsification_trigger are present (SEBI-RA narrative requirements)", () => {
  const out = buildFallbackHolding({ ticker: ANCHOR_TICKER });
  const rec = out.sws.v2_recommendation;
  assert.equal(typeof rec.counter_thesis, "string");
  assert.ok(rec.counter_thesis.length > 0);
  assert.equal(typeof rec.falsification_trigger, "string");
  assert.ok(rec.falsification_trigger.length > 0);
});

/* ───────────────────── [5] action band + timing ──────────────────────── */

console.log("[5] action band falls within the known ladder set");
it("top-level action is one of the legal fallback labels", () => {
  const out = buildFallbackHolding({ ticker: ANCHOR_TICKER });
  // Either v2-mode (default) or legacy mode — both label families are valid.
  const legal = new Set([
    "HOLD",
    "Top-up-25%", "Top-up-modest",
    "Reduction-33%", "Reduction-25-33%", "Reduction-50%",
    "EXIT-staged", "EXIT",
  ]);
  assert.ok(legal.has(out.action), `unexpected action label: ${out.action}`);
});
it("timing block is shaped for the UI (verdict + window + reason)", () => {
  const out = buildFallbackHolding({ ticker: ANCHOR_TICKER });
  assert.ok(out.timing, "timing block must exist");
  assert.equal(typeof out.timing.verdict, "string");
  if (out.action === "HOLD") {
    assert.equal(out.timing.verdict, "n/a", "HOLD action ⇒ timing verdict is n/a");
    assert.equal(out.timing.window, null, "HOLD action ⇒ no execution window");
    assert.match(out.timing.reason, /Hold/, "HOLD reason must mention 'Hold'");
  } else {
    // Any non-HOLD action defers to post-lunch per the module convention.
    assert.equal(out.timing.verdict, "Yes-not-urgent");
    assert.equal(out.timing.window, "post-lunch");
    assert.match(out.timing.reason, /Fallback/);
  }
});
it("reasons array surfaces the 4 canonical fallback rationales", () => {
  const out = buildFallbackHolding({ ticker: ANCHOR_TICKER });
  assert.ok(Array.isArray(out.reasons), "reasons must be an array");
  assert.equal(out.reasons.length, 4, "exactly 4 reasons in the fallback narrative");
  assert.ok(out.reasons[0].includes("SWS doesn't cover"), "reason[0] explains the fallback trigger");
  assert.match(out.reasons[1], /Independent fundamentals score: \d+\/100/, "reason[1] cites the V2 composite");
  assert.match(out.reasons[2], /Snowflake .*\/30/, "reason[2] surfaces the snowflake total");
  assert.match(out.reasons[3], /HOLD/, "reason[3] explains the HOLD bias");
});

/* ───────────────────── [6] ticker normalisation ──────────────────────── */

console.log("[6] _toNseKey normalisation accepts multiple ticker shapes");
it("bare symbol → .NS resolves the same snapshot", () => {
  const bare = buildFallbackHolding({ ticker: "RELIANCE" });
  const dotNs = buildFallbackHolding({ ticker: "RELIANCE.NS" });
  assert.ok(bare && dotNs);
  // Same key resolved ⇒ same fundamentals snapshot ⇒ same v2 score.
  assert.equal(bare.sws.score, dotNs.sws.score, "bare and .NS forms must produce the same score");
});
it("BSE / NSE / BO suffixes are coerced to .NS", () => {
  const bse = buildFallbackHolding({ ticker: "RELIANCE.BSE" });
  const nse = buildFallbackHolding({ ticker: "RELIANCE.NSE" });
  const bo = buildFallbackHolding({ ticker: "RELIANCE.BO" });
  assert.ok(bse, ".BSE suffix should coerce to .NS and resolve");
  assert.ok(nse, ".NSE suffix should coerce to .NS and resolve");
  assert.ok(bo, ".BO suffix should coerce to .NS and resolve");
  // Cross-check: all coerce to the same NSE key ⇒ same score as bare.
  const bare = buildFallbackHolding({ ticker: "RELIANCE" });
  assert.equal(bse.sws.score, bare.sws.score);
  assert.equal(nse.sws.score, bare.sws.score);
  assert.equal(bo.sws.score, bare.sws.score);
});
it("whitespace around the ticker is stripped", () => {
  const padded = buildFallbackHolding({ ticker: "  RELIANCE  " });
  const tight = buildFallbackHolding({ ticker: "RELIANCE" });
  assert.ok(padded);
  assert.equal(padded.sws.score, tight.sws.score);
});

console.log(`\n=== ${ok} passed, ${fail} failed ===`);
if (fail) process.exit(1);
