// Unit tests for the unmatched-equity residual that keeps the Portfolio
// Analyzer hero trio reflecting the user's FULL book (not just the SWS-covered
// subset). Regression guard for the bug where a 40-holding Groww upload with 2
// unresolved demerger rows showed "worth today ₹17.71 L" instead of ₹18.51 L.
//
// Numbers below mirror the real file
// Stocks_Holdings_Statement_3540358892_24-06-2026 (1).xlsx:
//   38 scored + 2 unmatched equity (VEDANTA IRON AND STEEL L, VEDANTA POWER).
//   residual invested 62,649 / current 71,842.

import {
  filterUnmatchedEquity,
  computeUnmatchedEquityResidual,
  slimUnmatchedForStorage,
  rebuildUnmatchedFromStored,
} from "../services/portfolio/unmatchedResidual.js";
import { __testing__ } from "../services/swsPortfolioAggregate.js";

const { buildSnapshot } = __testing__;

let pass = 0, fail = 0;
function assert(name, cond, got) {
  if (cond) { console.log(`✓ ${name}`); pass++; }
  else { console.log(`✗ ${name} — got: ${JSON.stringify(got)}`); fail++; }
}

// The two real unmatched rows from the user's Groww export.
const VEDANTA_UNMATCHED = [
  { rawName: "VEDANTA IRON AND STEEL L", instrumentType: "equity", matchType: "none", quantity: 1820, avgPrice: 25.06, closePrice: 29.41 },
  { rawName: "VEDANTA POWER LIMITED", instrumentType: "equity", matchType: "none", quantity: 420, avgPrice: 40.57, closePrice: 43.61 },
];

// ──── computeUnmatchedEquityResidual ────
{
  const r = computeUnmatchedEquityResidual(VEDANTA_UNMATCHED);
  assert("residual: count === 2", r.count === 2, r);
  // 1820*25.06 + 420*40.57 = 45609.2 + 17039.4 = 62648.6 → 62649
  assert("residual: invested === 62649 (broker cost basis)", r.invested === 62649, r);
  // 1820*29.41 + 420*43.61 = 53526.2 + 18316.2 = 71842.4 → 71842
  assert("residual: current === 71842 (qty*closePrice)", r.current === 71842, r);
}
{
  // closePrice ≤ 0 → current falls back to cost (avgPrice).
  const r = computeUnmatchedEquityResidual([{ instrumentType: "equity", quantity: 10, avgPrice: 100, closePrice: 0 }]);
  assert("residual: closePrice 0 falls back to avg for current", r.current === 1000 && r.invested === 1000, r);
}
{
  // MF / bond / F&O are NOT equity book value → excluded entirely.
  const mixed = [
    { instrumentType: "mf", quantity: 100, avgPrice: 50, closePrice: 60 },
    { instrumentType: "bond", quantity: 5, avgPrice: 1000, closePrice: 1010 },
    { instrumentType: "fno", quantity: 75, avgPrice: 20, closePrice: 25 },
    { instrumentType: "equity", quantity: 10, avgPrice: 100, closePrice: 110 },
  ];
  const r = computeUnmatchedEquityResidual(mixed);
  assert("residual: excludes mf/bond/fno, keeps equity", r.count === 1 && r.current === 1100, r);
}
{
  // "unknown" instrumentType is equity-like (exclude-list, not whitelist).
  const r = computeUnmatchedEquityResidual([{ instrumentType: "unknown", quantity: 4, avgPrice: 50, closePrice: 55 }]);
  assert("residual: keeps 'unknown' instrumentType", r.count === 1 && r.current === 220, r);
}
{
  // Empty / null / non-array → zeroed residual, never throws.
  assert("residual: [] → zeros", JSON.stringify(computeUnmatchedEquityResidual([])) === JSON.stringify({ count: 0, invested: 0, current: 0 }));
  assert("residual: null → zeros", computeUnmatchedEquityResidual(null).count === 0);
  assert("residual: undefined → zeros", computeUnmatchedEquityResidual(undefined).count === 0);
}

// ──── filterUnmatchedEquity ────
{
  const kept = filterUnmatchedEquity([
    { instrumentType: "equity" }, { instrumentType: "etf" }, { instrumentType: "unknown" },
    { instrumentType: "mf" }, { instrumentType: "bond" }, { instrumentType: "fno" },
  ]);
  assert("filter: keeps equity+etf+unknown, drops mf+bond+fno", kept.length === 3, kept.map((k) => k.instrumentType));
  assert("filter: null → []", filterUnmatchedEquity(null).length === 0);
}

// ──── buildSnapshot: residual folds into DISPLAY totals only ────
function mkHolding({ invested, currentValue, action = "Hold", covered = true, snow = 20, v4 = 60, verdict = "FAIR" }) {
  return {
    invested, currentValue, action,
    swsCovered: covered,
    sws: covered ? { snowflake_total: snow, v4_score: v4, verdict } : undefined,
  };
}
{
  // 2 scored covered holdings + a residual standing in for unmatched rows.
  const scored = [
    mkHolding({ invested: 100000, currentValue: 120000 }),
    mkHolding({ invested: 50000, currentValue: 48000 }),
  ];
  const residual = { count: 2, invested: 62649, current: 71842 };
  const snap = buildSnapshot(scored, residual);

  assert("snapshot: totalInvested includes residual", snap.totalInvested === 100000 + 50000 + 62649, snap.totalInvested);
  assert("snapshot: totalCurrent includes residual", snap.totalCurrent === 120000 + 48000 + 71842, snap.totalCurrent);
  assert("snapshot: totalPnL = current − invested (augmented)", snap.totalPnL === snap.totalCurrent - snap.totalInvested, snap.totalPnL);
  const expectPct = Math.round((snap.totalCurrent - snap.totalInvested) / snap.totalInvested * 1000) / 10;
  assert("snapshot: totalPnLPct recomputed off augmented totals", snap.totalPnLPct === expectPct, snap.totalPnLPct);
  assert("snapshot: coveredCount = scored covered (2), excludes residual", snap.coveredCount === 2, snap.coveredCount);
  assert("snapshot: holdingsCount = scored count (2), unchanged semantic", snap.holdingsCount === 2, snap.holdingsCount);
  assert("snapshot: unmatchedCount = residual.count (2)", snap.unmatchedCount === 2, snap.unmatchedCount);
  assert("snapshot: uploadedEquityCount = scored + unmatched (4)", snap.uploadedEquityCount === 4, snap.uploadedEquityCount);
  // coverage_text in buildSWSReport reads coveredCount / uploadedEquityCount.
  assert("snapshot: coverage ratio would read '2/4'", `${snap.coveredCount}/${snap.uploadedEquityCount}` === "2/4");
}
{
  // No residual (null) → behaves exactly as before; new fields present + sane.
  const scored = [mkHolding({ invested: 100000, currentValue: 110000 })];
  const snap = buildSnapshot(scored, null);
  assert("snapshot: null residual → totals unchanged", snap.totalInvested === 100000 && snap.totalCurrent === 110000, snap);
  assert("snapshot: null residual → unmatchedCount 0", snap.unmatchedCount === 0, snap.unmatchedCount);
  assert("snapshot: null residual → uploadedEquityCount === holdingsCount", snap.uploadedEquityCount === snap.holdingsCount, snap);
}

// ──── persistence round-trip (rerun regression guard — adversarial C1) ────
// The hero residual must survive /analyze/rerun. Storage persists a slim shape;
// the rerun synth rebuilds parsed.unmatched from it. The residual computed on
// the rebuilt rows MUST equal the residual computed on the original parse —
// otherwise the headline regresses to SWS-covered-only on a tab-switch.
{
  const slim = slimUnmatchedForStorage(VEDANTA_UNMATCHED);
  assert("slim: keeps both equity rows", slim.length === 2, slim);
  assert("slim: carries qty/avg/close needed for residual", slim[0].quantity === 1820 && slim[0].avgPrice === 25.06 && slim[0].closePrice === 29.41, slim[0]);
  assert("slim: preserves rawName as name", slim[0].name === "VEDANTA IRON AND STEEL L", slim[0]);

  const rebuilt = rebuildUnmatchedFromStored(slim);
  assert("rebuild: restores rawName + matchType none", rebuilt[0].rawName === "VEDANTA IRON AND STEEL L" && rebuilt[0].matchType === "none", rebuilt[0]);

  const before = computeUnmatchedEquityResidual(VEDANTA_UNMATCHED);
  const after = computeUnmatchedEquityResidual(rebuilt);
  assert("round-trip: residual identical after store→rebuild", JSON.stringify(before) === JSON.stringify(after), { before, after });
}
{
  // mf/bond/fno never persisted → never rebuilt → never counted.
  const slim = slimUnmatchedForStorage([
    { rawName: "SOME BOND", instrumentType: "bond", quantity: 5, avgPrice: 1000, closePrice: 1010 },
    { rawName: "REAL EQUITY", instrumentType: "equity", quantity: 10, avgPrice: 100, closePrice: 110 },
  ]);
  assert("slim: drops bond, keeps equity", slim.length === 1 && slim[0].name === "REAL EQUITY", slim);
}
{
  // Missing / malformed stored field → empty, never throws.
  assert("rebuild: undefined → []", rebuildUnmatchedFromStored(undefined).length === 0);
  assert("rebuild: null → []", rebuildUnmatchedFromStored(null).length === 0);
  assert("rebuild: non-array → []", rebuildUnmatchedFromStored({}).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
