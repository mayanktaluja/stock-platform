// End-to-end smoke for the data-thin gate against the user's real
// portfolio.json. Loads holdings → enriches with sws → calls buildSWSReport
// → asserts TMCV is in tiers.D (Watch), not tiers.A (Reductions), with the
// correct watchReason; and at least one OTHER holding is still in tiers.A
// (gate didn't accidentally drain all reductions).
//
// Run: node scripts/smoke-data-thin-gate.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scoreHolding } from "../services/swsHoldingEngine.js";
import { buildSWSReport } from "../services/swsPortfolioAggregate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// portfolio.json lives in the main checkout (gitignored so not in worktree).
const PORTFOLIO = path.resolve(__dirname, "..", "..", "..", "..", "portfolio.json");

const portfolio = JSON.parse(fs.readFileSync(PORTFOLIO, "utf-8"));
const holdings = Array.isArray(portfolio) ? portfolio : portfolio.stocks || portfolio.holdings || [];
console.log(`loaded ${holdings.length} holdings from ${PORTFOLIO}`);

const totalValue = holdings.reduce((s, h) => {
  return s + (Number(h.quantity) || 0) * (Number(h.avgPrice) || 0);
}, 0);

const enriched = holdings.map((h) => {
  const ticker = String(h.symbol || "").replace(/\.NS$/i, "");
  const positionValue = (Number(h.quantity) || 0) * (Number(h.avgPrice) || 0);
  const positionWeight = totalValue > 0 ? (positionValue / totalValue) * 100 : 0;
  return scoreHolding(
    {
      symbol: ticker,
      ticker,
      name: h.name,
      sector: h.sector,
      quantity: Number(h.quantity) || 0,
      avgPrice: Number(h.avgPrice) || 0,
      currentValue: positionValue,
      positionWeight,
    },
    { sectorWeights: {} },
  );
});

const report = buildSWSReport(enriched, { freshCapitalInr: 0 });
const A = report.tiers.A.rows;
const D = report.tiers.D.rows;

console.log(`Tier A (Reductions): ${A.length} holdings`);
console.log(`Tier D (Watch):      ${D.length} holdings`);

const isTmcv = (h) => (h.sws?.ticker || h.symbol || "").toUpperCase().startsWith("TMCV");
const tmcvInA = A.find(isTmcv);
const tmcvInD = D.find(isTmcv);

let pass = 0, fail = 0;
function assert(name, cond) {
  if (cond) { pass++; console.log("  ✓", name); }
  else      { fail++; console.log("  ✗", name); }
}

assert("TMCV NOT in Tier A (Reductions)", !tmcvInA);
assert("TMCV IS in Tier D (Watch)", !!tmcvInD);
if (tmcvInD) {
  console.log("    watchReason:", tmcvInD.watchReason);
  assert("TMCV watchReason mentions 'Insufficient SWS coverage'",
    /Insufficient SWS coverage/.test(tmcvInD.watchReason || ""));
}
assert("Tier A still has at least one holding (gate didn't drain everything)", A.length >= 1);

if (A.length >= 1) {
  console.log("    Tier A members:", A.map((h) => h.symbol || h.sws?.ticker).slice(0, 10).join(", "));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
