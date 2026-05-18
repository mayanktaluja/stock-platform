import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { buildLabPayload, runRiskLab } from "../services/riskLab/labOrchestrator.js";

let _failed = 0;
function assert(name, cond, got) {
  if (cond) {
    console.log(`  ok: ${name}`);
  } else {
    console.log(`  FAIL: ${name}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ""}`);
    _failed += 1;
  }
}

function makePicksFixture(rows) {
  return {
    schema_version: "fixture-v1",
    scanned_at: "2026-05-18T00:00:00Z",
    universe_size: rows.length,
    sections: {
      top_ranked_30_v3: rows,
      // Duplicate ticker in second section to test dedup
      deep_value: rows.slice(0, 1),
    },
  };
}

function makeRegimeFixture(overrides = {}) {
  return {
    regime: "OIL_SHOCK",
    severity: 3,
    confidence: 0.7,
    sectorImpacts: [
      { sector: "Oil & Gas", impact: 3, reason: "spike" },
      { sector: "Aviation", impact: -3, reason: "fuel" },
    ],
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

console.log("riskLabOrchestrator: buildLabPayload");
{
  const rows = [
    { ticker: "ANANTRAJ", sector: "Diversified Financials", v3_verdict: "TOP_PICK", v3_score_100: 64.8 },
    { ticker: "JSLL", sector: "Healthcare", v3_verdict: "TOP_PICK", v3_score_100: 83.6 },
  ];
  const picks = makePicksFixture(rows);
  const regime = makeRegimeFixture();
  const payload = buildLabPayload(picks, regime);

  assert("has schema_version", payload.schema_version === "risk-lab-picks-v1");
  assert("has generated_at", typeof payload.generated_at === "string");
  assert("regime field projected", payload.regime?.regime === "OIL_SHOCK");
  assert("source_picks_scanned_at copied", payload.source_picks_scanned_at === "2026-05-18T00:00:00Z");
  assert("source_regime_generated_at copied", typeof payload.source_regime_generated_at === "string");

  // Dedup: ANANTRAJ appears in 2 sections but should be in output once
  assert("dedup: 2 unique stocks", payload.stocks.length === 2);
  assert("ANANTRAJ adjustment present", payload.stocks.find((s) => s.ticker === "ANANTRAJ"));
  assert("JSLL adjustment present", payload.stocks.find((s) => s.ticker === "JSLL"));

  // ANANTRAJ should be flagged (Real Estate under OIL_SHOCK via lab template)
  const anantraj = payload.stocks.find((s) => s.ticker === "ANANTRAJ");
  assert("ANANTRAJ flagged with delta", anantraj.macro_score_delta < 0, anantraj.macro_score_delta);

  // JSLL is Healthcare → normalized to Pharma → not in OIL_SHOCK impacts → no flag
  const jsll = payload.stocks.find((s) => s.ticker === "JSLL");
  assert("JSLL not flagged (Healthcare/Pharma not in OIL_SHOCK)", jsll.macro_score_delta === 0);

  // Summary
  assert("summary.total_stocks correct", payload.summary.total_stocks === 2);
  assert("summary.flagged_count = 1", payload.summary.flagged_count === 1);
  assert("summary.vetoed_count = 0", payload.summary.vetoed_count === 0);
}

console.log("riskLabOrchestrator: buildLabPayload — guards");
{
  // Empty picks → empty stocks, summary all zeros
  const emptyPayload = buildLabPayload(null, makeRegimeFixture());
  assert("null picks → 0 stocks", emptyPayload.stocks.length === 0);
  assert("null picks → summary.total = 0", emptyPayload.summary.total_stocks === 0);

  // Null regime → all rows pass through with 0 delta
  const passthroughPayload = buildLabPayload(
    makePicksFixture([{ ticker: "ANANTRAJ", sector: "Diversified Financials", v3_verdict: "TOP_PICK", v3_score_100: 64.8 }]),
    null,
  );
  assert("null regime → still 1 stock projected", passthroughPayload.stocks.length === 1);
  assert("null regime → delta 0", passthroughPayload.stocks[0].macro_score_delta === 0);

  // Empty sections → empty output (handles missing/malformed picks)
  const noSectionsPayload = buildLabPayload({ schema_version: "x", sections: null }, makeRegimeFixture());
  assert("malformed picks → 0 stocks", noSectionsPayload.stocks.length === 0);
}

console.log("riskLabOrchestrator: runRiskLab end-to-end");
{
  const tmp = mkdtempSync(path.join(tmpdir(), "risk-lab-test-"));
  try {
    const picksPath = path.join(tmp, "picks.json");
    const regimePath = path.join(tmp, "regime.json");
    const outPath = path.join(tmp, "out.json");

    const picks = makePicksFixture([
      { ticker: "ANANTRAJ", sector: "Diversified Financials", v3_verdict: "TOP_PICK", v3_score_100: 64.8 },
    ]);
    writeFileSync(picksPath, JSON.stringify(picks));
    writeFileSync(regimePath, JSON.stringify(makeRegimeFixture()));

    const result = runRiskLab({ picksPath, regimePath, outPath });
    assert("end-to-end: returns payload", result.payload && result.payload.schema_version);
    assert("end-to-end: not dry-run", result.dryRun === false);
    assert("end-to-end: file written", existsSync(outPath));

    const written = JSON.parse(readFileSync(outPath, "utf-8"));
    assert("written file has 1 stock", written.stocks.length === 1);
    assert("written file: ANANTRAJ flagged", written.stocks[0].macro_score_delta < 0);

    // Dry run doesn't write
    rmSync(outPath, { force: true });
    runRiskLab({ picksPath, regimePath, outPath, dryRun: true });
    assert("dry-run: no file written", !existsSync(outPath));

    // Missing picks file → still produces empty output (no throw)
    rmSync(picksPath, { force: true });
    rmSync(outPath, { force: true });
    const missingResult = runRiskLab({ picksPath, regimePath, outPath });
    assert("missing picks → empty stocks, no throw", missingResult.payload.stocks.length === 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (_failed === 0) {
  console.log("riskLabOrchestrator: PASS");
  process.exit(0);
} else {
  console.error(`riskLabOrchestrator: FAIL (${_failed})`);
  process.exit(1);
}
