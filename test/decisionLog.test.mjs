// Tests for services/paperTrade/decisionLog.js — NDJSON audit log.
// Uses a temp dir via process.chdir so we don't write into real
// data/strategy/.
// Run: node test/decisionLog.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let ok = 0, fail = 0;
function it(name, fn) {
  try { fn(); console.log("  ✓", name); ok += 1; }
  catch (e) { console.log("  ✗", name, "\n   ", e && e.message); fail += 1; }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "decision-log-test-"));
const origCwd = process.cwd();
process.chdir(tmpDir);

const {
  logDecision,
  readDecisions,
  decisionsForSymbol,
  decisionsSince,
  DECISION_LOG_CONFIG,
} = await import("../services/paperTrade/decisionLog.js");

console.log("\ndecisionLog");

it("config exposes schema version + valid actions", () => {
  if (DECISION_LOG_CONFIG.SCHEMA_VERSION !== "decision-log-v1") throw new Error("schema mismatch");
  if (!DECISION_LOG_CONFIG.VALID_ACTIONS.includes("ENTRY")) throw new Error("missing ENTRY action");
  if (!DECISION_LOG_CONFIG.VALID_ACTIONS.includes("EXIT_FAILSAFE")) throw new Error("missing EXIT_FAILSAFE action");
});

it("logDecision throws on invalid action", () => {
  try { logDecision({ action: "BOGUS", symbol: "X", tier: "high", qty: 1, price_inr: 1 }); throw new Error("should have thrown"); }
  catch (e) { if (!/invalid action/.test(e.message)) throw e; }
});

it("logDecision throws on missing symbol / tier / qty / price", () => {
  for (const partial of [
    { action: "ENTRY" },
    { action: "ENTRY", symbol: "X" },
    { action: "ENTRY", symbol: "X", tier: "high" },
    { action: "ENTRY", symbol: "X", tier: "high", qty: 1 },
    { action: "ENTRY", symbol: "X", tier: "high", qty: 0, price_inr: 100 },
    { action: "ENTRY", symbol: "X", tier: "high", qty: 1, price_inr: -1 },
  ]) {
    try { logDecision(partial); throw new Error("should have thrown for " + JSON.stringify(partial)); }
    catch (e) { if (/should have thrown/.test(e.message)) throw e; }
  }
});

it("logDecision writes an NDJSON record to data/strategy/decisions.ndjson", () => {
  const rec = logDecision({
    action: "ENTRY",
    symbol: "INOXWIND",
    tier: "high",
    qty: 50,
    price_inr: 280,
    score_snapshot: { v3: 62, multibagger: 78 },
    counter_thesis: "Sector P/E is rich",
    macro_regime: "RISK_ON",
    pre_mortem: "If wind PLI is rolled back, thesis breaks",
    stop_price_inr: 196,
    target_price_inr: 840,
    notes: "First Anchor entry",
  });
  if (rec.notional_inr !== 14_000) throw new Error("notional mismatch: " + rec.notional_inr);
  const file = path.join(tmpDir, "data", "strategy", "decisions.ndjson");
  if (!fs.existsSync(file)) throw new Error("decisions.ndjson not created");
  const content = fs.readFileSync(file, "utf8");
  const parsed = JSON.parse(content.trim());
  if (parsed.symbol !== "INOXWIND" || parsed.qty !== 50) throw new Error("record mismatch");
  if (parsed.schema_version !== "decision-log-v1") throw new Error("schema_version missing");
});

it("logDecision appends, doesn't truncate", () => {
  logDecision({ action: "TRIM", symbol: "INOXWIND", tier: "high", qty: 25, price_inr: 420 });
  logDecision({ action: "EXIT_TARGET", symbol: "INOXWIND", tier: "high", qty: 25, price_inr: 840 });
  const all = readDecisions();
  if (all.length < 3) throw new Error(`expected ≥3 records, got ${all.length}`);
});

it("decisionsForSymbol filters correctly", () => {
  logDecision({ action: "ENTRY", symbol: "OTHER", tier: "conviction", qty: 100, price_inr: 80 });
  const inox = decisionsForSymbol("INOXWIND");
  if (inox.some((d) => d.symbol !== "INOXWIND")) throw new Error("symbol filter leaked");
  if (inox.length < 3) throw new Error("missing INOXWIND records");
});

it("decisionsSince filters by timestamp", () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const since = decisionsSince(future);
  if (since.length !== 0) throw new Error("future cutoff should return empty");
  const past = "1970-01-01T00:00:00Z";
  const all = decisionsSince(past);
  if (all.length === 0) throw new Error("past cutoff should return all");
});

it("readDecisions returns [] when file absent", () => {
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "decision-log-empty-"));
  const out = readDecisions({ path: path.join(tmp2, "no-file.ndjson") });
  if (out.length !== 0) throw new Error("expected []");
});

it("readDecisions skips malformed lines", () => {
  const file = path.join(tmpDir, "data", "strategy", "decisions.ndjson");
  fs.appendFileSync(file, "not-json-at-all\n");
  const all = readDecisions();
  if (all.length === 0) throw new Error("readDecisions threw on malformed line");
});

process.chdir(origCwd);
console.log(`\n  ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
