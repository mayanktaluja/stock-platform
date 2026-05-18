import {
  parseCounterThesis,
  _setKeywordsForTest as _setCounterThesisKeywords,
} from "../services/riskLab/quality/counterThesisParser.js";
import {
  applySectorQualityOverlay,
  _setOverlaysForTest,
} from "../services/riskLab/quality/sectorQualityOverlay.js";

let _failed = 0;
function assert(name, cond, got) {
  if (cond) {
    console.log(`  ok: ${name}`);
  } else {
    console.log(`  FAIL: ${name}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ""}`);
    _failed += 1;
  }
}

// ─── counterThesisParser ────────────────────────────────────────────────
console.log("counterThesisParser: bullish stock with quality-killer triggers");
{
  _setCounterThesisKeywords(null);
  // JSLL canonical shape from live picks-latest
  const ct = {
    verdict_bias: "bullish",
    text: "+34.5% over 1Y — trend supports verdict.",
    falsification_trigger: [
      "next quarterly result misses estimates",
      "a new India-risk overlay materialises (ASM/GSM, promoter pledge spike)",
      "upside vs SWS FV compresses below 5% (currently 87.8%)",
    ],
  };
  const r = parseCounterThesis(ct);
  assert("bullish + 3 triggers: pts negative", r.pts < 0, r.pts);
  assert("bullish + 3 triggers: ≥3 flags", r.flags.length >= 3, r.flags.length);
  // Earnings miss + India risk + valuation compression — all 3 should fire
  const cats = r.flags.map((f) => f.category);
  assert("bullish: earnings_miss_trigger fires", cats.includes("earnings_miss_trigger"));
  assert("bullish: india_risk_trigger fires", cats.includes("india_risk_trigger"));
  assert("bullish: valuation_compression fires", cats.includes("valuation_compression"));
  // Capped at -3
  assert("bullish: pts capped at -3", r.pts === -3);
}

console.log("counterThesisParser: bearish bias → no penalty");
{
  _setCounterThesisKeywords(null);
  const ct = {
    verdict_bias: "bearish",
    text: "+20.4% over 1Y — trend is up despite verdict.",
    falsification_trigger: [
      "next quarterly result beats consensus by ≥ 10%",
      "a new analyst PT is raised by ≥ 15%",
    ],
  };
  const r = parseCounterThesis(ct);
  assert("bearish: no penalty", r.pts === 0);
  assert("bearish: 0 flags", r.flags.length === 0);
  assert("bearish: reason bias_bearish", r.reason === "bias_bearish");
}

console.log("counterThesisParser: text parses against generic taxonomy");
{
  _setCounterThesisKeywords(null);
  const ct = {
    verdict_bias: "bullish",
    text: "Interest payments are not well covered by earnings, and margin pressure persists.",
    falsification_trigger: null,
  };
  const r = parseCounterThesis(ct);
  // Generic categories from disk: interest_coverage + margin_pressure
  const cats = r.flags.map((f) => f.category);
  assert("text: interest_coverage fires", cats.includes("interest_coverage"));
  assert("text: margin_pressure fires", cats.includes("margin_pressure"));
}

console.log("counterThesisParser: guards");
{
  _setCounterThesisKeywords(null);
  assert("null → no penalty", parseCounterThesis(null).pts === 0);
  assert("missing bias → reason bias_missing", parseCounterThesis({ text: "x" }).reason === "bias_missing");
  // Empty bullish
  const r = parseCounterThesis({ verdict_bias: "bullish" });
  assert("bullish + no fields: 0 pts", r.pts === 0);
}

// ─── sectorQualityOverlay ───────────────────────────────────────────────
console.log("sectorQualityOverlay: KEC (Capital Goods + WC risk)");
{
  _setOverlaysForTest(null);
  const risks = [
    "Interest payments are not well covered by earnings",
    "Receivables are stretched relative to industry norm",
  ];
  const r = applySectorQualityOverlay("Capital Goods", risks);
  assert("KEC overlay: fires", r.pts < 0);
  assert("KEC overlay: epc_td_working_capital category", r.flags.some((f) => f.overlay === "epc_td_working_capital"));
  assert("KEC overlay: cites receivables bullet", r.flags[0].evidence.includes("Receivables"));
  assert("KEC overlay: -2 pts", r.pts === -2);
}

console.log("sectorQualityOverlay: Pharma USFDA risk");
{
  _setOverlaysForTest(null);
  const risks = ["USFDA inspection at Indore plant flagged warning letter risk"];
  const r = applySectorQualityOverlay("Pharmaceuticals & Biotech", risks);
  assert("Pharma USFDA: fires", r.pts < 0);
  assert("Pharma USFDA: -3 pts", r.pts === -3);
  assert("Pharma USFDA: category", r.flags.some((f) => f.overlay === "pharma_usfda"));
}

console.log("sectorQualityOverlay: Banking NPA risk");
{
  _setOverlaysForTest(null);
  const risks = ["Gross NPA ratio expanding QoQ; provision coverage weakening"];
  const r = applySectorQualityOverlay("Banks", risks);
  assert("Banking NPA: fires", r.pts < 0);
  assert("Banking NPA: -2 pts", r.pts === -2);
}

console.log("sectorQualityOverlay: no overlay fires for unrelated combo");
{
  _setOverlaysForTest(null);
  // IT Services + a generic interest-coverage risk → no sector overlay
  const r = applySectorQualityOverlay("IT Services", ["Interest payments not well covered by earnings"]);
  assert("IT + interest risk: no overlay", r.pts === 0);
  assert("IT + interest risk: reason no_overlay_fired", r.reason === "no_overlay_fired");
}

console.log("sectorQualityOverlay: cap at -4");
{
  _setOverlaysForTest({
    a: { sector_match: "test", risk_patterns: ["x"], severity: -3, summary: "a" },
    b: { sector_match: "test", risk_patterns: ["y"], severity: -3, summary: "b" },
    c: { sector_match: "test", risk_patterns: ["z"], severity: -3, summary: "c" },
  });
  const r = applySectorQualityOverlay("test sector", ["x", "y", "z"]);
  assert("3 overlays fire", r.flags.length === 3);
  assert("cap at -4 not -9", r.pts === -4);
}

console.log("sectorQualityOverlay: guards");
{
  _setOverlaysForTest(null);
  assert("no sector → 0 pts", applySectorQualityOverlay(null, ["x"]).pts === 0);
  assert("empty risks → 0 pts", applySectorQualityOverlay("Banking", []).pts === 0);
  assert("non-array risks → 0 pts", applySectorQualityOverlay("Banking", "string").pts === 0);
}

if (_failed === 0) {
  console.log("counterThesisAndSectorOverlay: PASS");
  process.exit(0);
} else {
  console.error(`counterThesisAndSectorOverlay: FAIL (${_failed})`);
  process.exit(1);
}
