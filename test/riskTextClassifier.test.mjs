import { classifyRiskText, _setKeywordsForTest } from "../services/riskLab/quality/riskTextClassifier.js";

let _failed = 0;
function assert(name, cond, got) {
  if (cond) {
    console.log(`  ok: ${name}`);
  } else {
    console.log(`  FAIL: ${name}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ""}`);
    _failed += 1;
  }
}

// KEC's actual SWS risks[] array (from data/sws/deep/KEC.json) — the
// canonical case the lab must catch.
const KEC_RISKS = [
  "Interest payments are not well covered by earnings",
  "Dividend of 1% is not well covered by free cash flows",
];

console.log("riskTextClassifier: KEC canonical case (default keywords from disk)");
{
  // Clear test override so loader reads the actual file
  _setKeywordsForTest(null);
  const r = classifyRiskText(KEC_RISKS);
  assert("KEC: detected", r.pts < 0, r.pts);
  assert(
    "KEC: interest_coverage flag fires",
    r.flags.some((f) => f.category === "interest_coverage"),
    r.flags,
  );
  assert(
    "KEC: cash_flow_weakness flag fires",
    r.flags.some((f) => f.category === "cash_flow_weakness"),
    r.flags,
  );
  assert("KEC: each flag cites a specific bullet", r.flags.every((f) => typeof f.evidence === "string" && f.evidence.length > 0));
  // -2 (interest) + -2 (cash flow) = -4 (at cap)
  assert("KEC: combined -4 pts (at cap)", r.pts === -4);
}

console.log("riskTextClassifier: per-category coverage (using injected taxonomy)");
{
  // Inject a minimal taxonomy for deterministic testing
  _setKeywordsForTest({
    interest_coverage: { patterns: ["interest\\s+coverage"], severity: -2, summary: "ICR" },
    margin_pressure: { patterns: ["margin\\s+pressure"], severity: -2, summary: "margin" },
    guidance_cut: { patterns: ["guidance\\s+cut"], severity: -3, summary: "guidance" },
    high_leverage: { patterns: ["high\\s+leverage"], severity: -1, summary: "leverage" },
  });

  // Single flag
  const r1 = classifyRiskText(["Interest coverage is weak"]);
  assert("single category fires", r1.flags.length === 1 && r1.pts === -2);

  // Multiple categories on different bullets
  const r2 = classifyRiskText([
    "Margin pressure from raw material inflation",
    "High leverage relative to industry",
  ]);
  assert("two categories fire", r2.flags.length === 2);
  assert("two categories pts sum", r2.pts === -3);

  // Cap at -4
  const r3 = classifyRiskText([
    "Interest coverage is weak",
    "Margin pressure squeezing earnings",
    "Guidance cut for FY27",
    "High leverage versus industry",
  ]);
  assert("cap at -4", r3.pts === -4);

  // Same category, multiple bullets — fires once (dedup)
  const r4 = classifyRiskText([
    "Interest coverage is weak this year",
    "Worsening interest coverage going forward",
  ]);
  assert("category fires once even with multiple bullets", r4.flags.length === 1);
}

console.log("riskTextClassifier: guards");
{
  _setKeywordsForTest(null);
  // Empty risks
  const r1 = classifyRiskText([]);
  assert("empty risks: 0 pts", r1.pts === 0);
  assert("empty risks: reason no_risks", r1.reason === "no_risks");

  // Null risks
  const r2 = classifyRiskText(null);
  assert("null risks: 0 pts", r2.pts === 0);

  // Non-array
  const r3 = classifyRiskText("just a string");
  assert("string risks: 0 pts", r3.pts === 0);

  // Risks with non-string entries (skipped)
  const r4 = classifyRiskText([null, 123, "Interest payments are not well covered by earnings"]);
  assert("mixed-type risks: still detects valid bullet", r4.pts < 0);

  // Risks that don't match any pattern
  const r5 = classifyRiskText(["Stock is currently overvalued by 30%"]);
  assert("benign risk: 0 pts", r5.pts === 0);
}

console.log("riskTextClassifier: case insensitivity");
{
  _setKeywordsForTest(null);
  const r = classifyRiskText(["INTEREST PAYMENTS ARE NOT WELL COVERED BY EARNINGS"]);
  assert("case insensitive: fires on uppercase", r.pts < 0);
}

if (_failed === 0) {
  console.log("riskTextClassifier: PASS");
  process.exit(0);
} else {
  console.error(`riskTextClassifier: FAIL (${_failed})`);
  process.exit(1);
}
