import { strict as assert } from "node:assert";
import { heuristicClassifyCluster, WIRE_SIGNAL_VERSION } from "../services/newsWire/wireHeuristic.js";

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
    pass++;
  } catch (err) {
    console.log(`  not ok - ${name}\n      ${err.message}`);
    fail++;
  }
}

const cluster = (over = {}) => ({
  representative: over.text || "Nifty edges higher in quiet trade",
  members: [{ text: over.text || "Nifty edges higher in quiet trade" }],
  source_count: 1,
  breaking: false,
  symbols: [],
  categories: ["markets"],
  ...over,
});

test("bullish cluster → bullish direction", () => {
  const s = heuristicClassifyCluster(cluster({ text: "Reliance surges on strong Q1 profit beat, shares rally to record high" }));
  assert.equal(s.direction, "bullish");
  assert.equal(s.signal_version, WIRE_SIGNAL_VERSION);
});

test("bearish cluster → bearish direction", () => {
  const s = heuristicClassifyCluster(cluster({ text: "Market crash fears as Nifty plunges, selloff deepens on recession risk" }));
  assert.equal(s.direction, "bearish");
});

test("no keyword signal → neutral, low heat", () => {
  const s = heuristicClassifyCluster(cluster({ text: "Company to hold board meeting on Thursday to consider agenda items" }));
  assert.equal(s.direction, "neutral");
  assert.ok(s.impact <= 3);
});

test("breaking + multi-source raises heat vs a quiet singleton", () => {
  const quiet = heuristicClassifyCluster(cluster({ text: "Board meeting scheduled next week", source_count: 1, breaking: false }));
  const loud = heuristicClassifyCluster(cluster({
    text: "Fed slashes rates, markets plunge on recession fears",
    source_count: 3,
    breaking: true,
  }));
  assert.ok(loud.impact > quiet.impact);
});

test("heat clamps to 0-10, confidence to 0.3-0.85", () => {
  const s = heuristicClassifyCluster(cluster({
    text: "crash plunge selloff recession default downgrade tariff sanction fraud ban warning",
    source_count: 9,
    breaking: true,
    symbols: ["TCS"],
  }));
  assert.ok(s.impact >= 0 && s.impact <= 10);
  assert.ok(s.confidence >= 0.3 && s.confidence <= 0.85);
});

test("tickers come from cluster symbols", () => {
  const s = heuristicClassifyCluster(cluster({ text: "Reliance jumps on strong results", symbols: ["RELIANCE"] }));
  assert.deepEqual(s.tickers, ["RELIANCE"]);
});

test("sectors sniffed and signed by direction", () => {
  const s = heuristicClassifyCluster(cluster({ text: "Banking stocks slump as NPA fears and downgrade pressure lenders" }));
  assert.equal(s.direction, "bearish");
  const bank = s.sectors.find((x) => x.sector === "Banking");
  assert.ok(bank, "Banking sniffed");
  assert.ok(bank.impact < 0, "bearish → negative sector impact");
});

test("never throws on garbage input", () => {
  for (const bad of [null, undefined, {}, { representative: null }, { representative: "x", members: null }, 42, "str"]) {
    const s = heuristicClassifyCluster(bad);
    assert.equal(s.classifier_provider, "heuristic");
    assert.ok(["bullish", "bearish", "neutral"].includes(s.direction));
  }
});

test("emits the full interchangeable schema", () => {
  const s = heuristicClassifyCluster(cluster({ text: "Nifty gains on strong FII buying" }));
  for (const k of ["direction", "impact", "confidence", "tickers", "sectors", "category", "why", "breaking", "classifier_provider", "model_id", "signal_version", "generated_at"]) {
    assert.ok(k in s, `missing ${k}`);
  }
});

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
