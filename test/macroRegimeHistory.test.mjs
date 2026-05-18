import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  regimeContentHash,
  historyFilePath,
  readLastLine,
  appendRegimeIfChanged,
} from "../services/macroRegimeHistory.js";

let _failed = 0;
function assert(name, cond, got) {
  if (cond) {
    console.log(`  ok: ${name}`);
  } else {
    console.log(`  FAIL: ${name}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ""}`);
    _failed += 1;
  }
}

function makeRegime(overrides = {}) {
  return {
    regime: "OIL_SHOCK",
    regimeLabel: "Oil Shock",
    severity: 3,
    confidence: 0.7,
    sectorImpacts: [
      { sector: "Oil & Gas", impact: 3, reason: "Crude price spike" },
      { sector: "Aviation", impact: -3, reason: "Fuel cost squeeze" },
    ],
    reasoning: "OPEC+ supply cut announcement triggered crude spike",
    headlineCount: 42,
    classifierProvider: "gemini-2.5-flash",
    generatedAt: "2026-05-18T06:00:00.000Z",
    ...overrides,
  };
}

console.log("macroRegimeHistory: regimeContentHash");
{
  const a = makeRegime();
  const b = makeRegime();
  assert("same input → same hash", regimeContentHash(a) === regimeContentHash(b));

  // Different severity → different hash (a real transition)
  const c = makeRegime({ severity: 4 });
  assert("severity change → hash differs", regimeContentHash(a) !== regimeContentHash(c));

  // Different regime → different hash
  const d = makeRegime({ regime: "WAR_ESCALATION" });
  assert("regime change → hash differs", regimeContentHash(a) !== regimeContentHash(d));

  // sectorImpacts order shouldn't matter
  const reordered = makeRegime({
    sectorImpacts: [
      { sector: "Aviation", impact: -3, reason: "Fuel cost squeeze" },
      { sector: "Oil & Gas", impact: 3, reason: "Crude price spike" },
    ],
  });
  assert("sectorImpacts re-ordering → same hash", regimeContentHash(a) === regimeContentHash(reordered));

  // generatedAt is excluded — different generatedAt should NOT trigger a new transition
  const newerSameContent = makeRegime({ generatedAt: "2026-05-18T08:00:00.000Z" });
  assert("generatedAt change → same hash", regimeContentHash(a) === regimeContentHash(newerSameContent));

  // Headline count is noise — excluded
  const moreHeadlines = makeRegime({ headlineCount: 99 });
  assert("headlineCount change → same hash", regimeContentHash(a) === regimeContentHash(moreHeadlines));

  // null / malformed
  assert("null → null hash", regimeContentHash(null) === null);
  assert("missing regime → null hash", regimeContentHash({ severity: 3 }) === null);
}

console.log("macroRegimeHistory: historyFilePath");
{
  const r2026 = makeRegime({ generatedAt: "2026-05-18T06:00:00.000Z" });
  const p2026 = historyFilePath(r2026, "/tmp/foo");
  assert("2026 → 2026.jsonl", p2026.endsWith("2026.jsonl"), p2026);

  const r2027 = makeRegime({ generatedAt: "2027-01-01T00:00:00.000Z" });
  const p2027 = historyFilePath(r2027, "/tmp/foo");
  assert("2027 → 2027.jsonl", p2027.endsWith("2027.jsonl"), p2027);

  // Missing generatedAt → today's year
  const rNoDate = makeRegime({ generatedAt: undefined });
  const pNoDate = historyFilePath(rNoDate, "/tmp/foo");
  const currentYear = new Date().getUTCFullYear();
  assert("missing generatedAt → current year", pNoDate.endsWith(`${currentYear}.jsonl`), pNoDate);
}

console.log("macroRegimeHistory: appendRegimeIfChanged");
{
  const tmp = mkdtempSync(path.join(tmpdir(), "macro-history-test-"));
  try {
    const r1 = makeRegime();
    // First append — content is new
    const result1 = appendRegimeIfChanged(r1, { historyDir: tmp });
    assert("first append → wrote", result1.appended === true);
    assert("first append → returned path", typeof result1.path === "string");

    // Same content → no-op
    const result2 = appendRegimeIfChanged(r1, { historyDir: tmp });
    assert("duplicate append → no-op", result2.appended === false && result2.reason === "unchanged");

    // Different generatedAt but same content → still no-op (generatedAt excluded)
    const r1b = makeRegime({ generatedAt: "2026-05-18T08:00:00.000Z" });
    const result3 = appendRegimeIfChanged(r1b, { historyDir: tmp });
    assert("same content different time → no-op", result3.appended === false);

    // Real transition (severity change)
    const r2 = makeRegime({ severity: 4 });
    const result4 = appendRegimeIfChanged(r2, { historyDir: tmp });
    assert("severity transition → wrote", result4.appended === true);

    // Verify file has exactly 2 lines
    const file = result1.path;
    const lines = readFileSync(file, "utf-8").trim().split("\n");
    assert("file has 2 lines after 2 transitions", lines.length === 2, lines.length);

    // Each line parses as JSON
    const parsed = lines.map((l) => JSON.parse(l));
    assert("line 0 is OIL_SHOCK sev3", parsed[0].regime === "OIL_SHOCK" && parsed[0].severity === 3);
    assert("line 1 is OIL_SHOCK sev4", parsed[1].regime === "OIL_SHOCK" && parsed[1].severity === 4);

    // Null / malformed inputs
    const resultNull = appendRegimeIfChanged(null, { historyDir: tmp });
    assert("null → no_regime", resultNull.appended === false && resultNull.reason === "no_regime");

    const resultMalformed = appendRegimeIfChanged({ foo: "bar" }, { historyDir: tmp });
    assert("malformed → no_regime", resultMalformed.appended === false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("macroRegimeHistory: readLastLine");
{
  const tmp = mkdtempSync(path.join(tmpdir(), "macro-history-test-"));
  try {
    const filePath = path.join(tmp, "test.jsonl");

    // Missing file
    assert("missing file → null", readLastLine(filePath) === null);

    // Empty file
    writeFileSync(filePath, "", "utf-8");
    assert("empty file → null", readLastLine(filePath) === null);

    // Single line
    writeFileSync(filePath, JSON.stringify({ regime: "CALM", severity: 1 }) + "\n", "utf-8");
    const single = readLastLine(filePath);
    assert("single line read", single && single.regime === "CALM");

    // Multiple lines — returns last
    writeFileSync(
      filePath,
      JSON.stringify({ regime: "CALM" }) + "\n" +
        JSON.stringify({ regime: "OIL_SHOCK" }) + "\n" +
        JSON.stringify({ regime: "WAR_ESCALATION" }) + "\n",
      "utf-8",
    );
    const last = readLastLine(filePath);
    assert("multi-line returns last", last && last.regime === "WAR_ESCALATION");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (_failed === 0) {
  console.log("macroRegimeHistory: PASS");
  process.exit(0);
} else {
  console.error(`macroRegimeHistory: FAIL (${_failed})`);
  process.exit(1);
}
