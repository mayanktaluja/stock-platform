/**
 * Regression tests for services/whatIfSimulator.js — the slider-driven
 * "if I trim ₹X / deploy ₹Y" recompute that powers the analyzer's
 * what-if panel.
 *
 * Covers:
 *   • Baseline metrics on a clean portfolio
 *   • Trim mutation → invested + current scaled pro-rata
 *   • Trim with purchase date → realised tax computed
 *   • Top-up mutation → invested basis grows 1:1, no tax event
 *   • Fresh-buy mutation (ticker not held) → new row from freshPicks
 *   • Fresh-buy with no freshPicks entry → warning + skip
 *   • Trim that exceeds current value → warning + capped at full exit
 *   • Sector-mix delta math (positive + negative cross-sectors)
 *   • Health-score direction (concentrated trim → diversification up)
 *
 * Run with: node test/whatIfSimulator.test.mjs
 */

import { simulate } from "../services/whatIfSimulator.js";
import { buildFyContext } from "../taxEngine.js";

const TODAY = new Date("2026-05-04T00:00:00Z");

let pass = 0;
let fail = 0;

function assert(name, cond, got) {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.log("  ✗", name, "→ got", got);
  }
}

// ─── Helpers ───
function holding(ticker, sector, currentValue, invested, opts = {}) {
  return {
    sws: {
      ticker,
      sector,
      market_cap_inr: opts.mcCr ? opts.mcCr * 1e7 : 60000 * 1e7, // default large cap
      v3_score: opts.v3 ?? 50,
      beta: opts.beta ?? 1.0,
    },
    swsCovered: true,
    currentValue,
    invested,
    purchaseDate: opts.purchaseDate || null,
  };
}

// ──────────────────── Baseline ────────────────────

console.log("\nBaseline metrics\n");
{
  const r = simulate({
    scoredHoldings: [
      holding("RELIANCE", "Energy", 100000, 80000, { v3: 60 }),
      holding("HDFCBANK", "Banking", 50000, 40000, { v3: 65 }),
    ],
    mutations: [],
  });
  assert("baseline totalValue = 150K", r.baseline.totalValue === 150000, r.baseline.totalValue);
  assert("baseline holdingsCount = 2", r.baseline.holdingsCount === 2, r.baseline.holdingsCount);
  // Energy 100K / 150K = 66.7%; Banking 50K / 150K = 33.3%
  assert("baseline sector mix Energy ~66.7", r.baseline.sectorMix.Energy === 66.7, r.baseline.sectorMix);
  assert("baseline sector mix Banking ~33.3", r.baseline.sectorMix.Banking === 33.3, r.baseline.sectorMix);
  assert("baseline largestPositionPct ~66.7", r.baseline.largestPositionPct === 66.7, r.baseline.largestPositionPct);
  assert("baseline avgV3 weighted ~ 61.7", Math.abs(r.baseline.avgV3 - 61.7) < 0.5, r.baseline.avgV3);
  assert("no mutations → scenario === baseline (no delta)", r.deltas.healthScore === 0, r.deltas);
  assert("no mutations → mutationsApplied empty", r.mutationsApplied.length === 0, r.mutationsApplied);
}

// ──────────────────── Trim mutation ────────────────────

console.log("\nTrim mutation\n");
{
  const r = simulate({
    scoredHoldings: [
      holding("RELIANCE", "Energy", 100000, 80000, { v3: 60 }),
      holding("HDFCBANK", "Banking", 50000, 40000, { v3: 65 }),
    ],
    mutations: [{ ticker: "RELIANCE", deltaRupees: -50000 }],
  });
  // After trim: RELIANCE 50K (50%), HDFCBANK 50K (50%) → totalValue 100K
  assert("trim → totalValue 100K", r.scenario.totalValue === 100000, r.scenario.totalValue);
  assert("trim → mutationsApplied length 1", r.mutationsApplied.length === 1, r.mutationsApplied);
  assert("trim → kind=trim, trimPct=50", r.mutationsApplied[0].kind === "trim" && r.mutationsApplied[0].trimPct === 50,
    r.mutationsApplied[0]);
  // Sector mix flips: Banking 50%, Energy 50%
  assert("trim → Energy delta -16.7", r.deltas.sectorMix.Energy === -16.7, r.deltas.sectorMix);
  assert("trim → Banking delta +16.7", r.deltas.sectorMix.Banking === 16.7, r.deltas.sectorMix);
  // Single-name concentration drops (largest position 66.7% → 50%);
  // top-5 doesn't change because N=2 (top-5 always = 100% by definition
  // when N≤5). largestPositionPct is the sensitive signal.
  assert("trim → largestPositionPct down (less concentrated)",
    r.deltas.largestPositionPct < 0, r.deltas.largestPositionPct);
  assert("no purchaseDate → realisedTax = 0", r.realisedTax === 0, r.realisedTax);
}

// ──────────────────── Trim with tax ────────────────────

console.log("\nTrim with purchase date (LTCG path)\n");
{
  const fy = buildFyContext(TODAY, 0, 0);
  const r = simulate({
    scoredHoldings: [
      holding("X", "Tech", 300000, 100000, { v3: 70, purchaseDate: "2023-04-15" }),
    ],
    mutations: [{ ticker: "X", deltaRupees: -300000 }],
    fyContext: fy,
    today: TODAY,
  });
  // Full exit gain = ₹200K. After ₹1.25L exemption → ₹75K × 12.5% = ₹9,375
  assert("LTCG full-exit tax = ₹9,375", r.realisedTax === 9375, r.realisedTax);
  assert("trimPct = 100", r.mutationsApplied[0].trimPct === 100, r.mutationsApplied[0]);
}

// ──────────────────── Top-up mutation ────────────────────

console.log("\nTop-up mutation\n");
{
  const r = simulate({
    scoredHoldings: [
      holding("X", "Tech", 50000, 50000, { v3: 60 }),
    ],
    mutations: [{ ticker: "X", deltaRupees: 25000 }],
  });
  assert("top-up → totalValue 75K", r.scenario.totalValue === 75000, r.scenario.totalValue);
  assert("top-up → kind=top-up", r.mutationsApplied[0].kind === "top-up", r.mutationsApplied[0]);
  assert("top-up → no tax event", r.realisedTax === 0, r.realisedTax);
}

// ──────────────────── Fresh buy ────────────────────

console.log("\nFresh-buy mutation (new ticker)\n");
{
  const r = simulate({
    scoredHoldings: [
      holding("X", "Tech", 50000, 50000, { v3: 60 }),
    ],
    mutations: [{ ticker: "JSLL", deltaRupees: 30000 }],
    freshPicks: [{ ticker: "JSLL", sector: "Healthcare", market_cap_inr: 8000 * 1e7, v3_score: 83 }],
  });
  assert("fresh-buy → totalValue 80K", r.scenario.totalValue === 80000, r.scenario.totalValue);
  assert("fresh-buy → kind=fresh-buy", r.mutationsApplied[0].kind === "fresh-buy", r.mutationsApplied[0]);
  assert("fresh-buy → Healthcare appears in scenario sector mix",
    r.scenario.sectorMix.Healthcare === 37.5, r.scenario.sectorMix);
  assert("fresh-buy → Healthcare delta +37.5", r.deltas.sectorMix.Healthcare === 37.5, r.deltas.sectorMix);
}

// ──────────────────── Unknown fresh-buy ────────────────────

console.log("\nFresh-buy without freshPicks entry\n");
{
  const r = simulate({
    scoredHoldings: [holding("X", "Tech", 50000, 50000, { v3: 60 })],
    mutations: [{ ticker: "UNKNOWN", deltaRupees: 10000 }],
    freshPicks: [],
  });
  assert("unknown fresh-buy → warning emitted",
    r.warnings.some((w) => w.includes("UNKNOWN")), r.warnings);
  assert("unknown fresh-buy → no mutation applied",
    r.mutationsApplied.length === 0, r.mutationsApplied);
}

// ──────────────────── Over-trim ────────────────────

console.log("\nOver-trim (delta exceeds position)\n");
{
  const r = simulate({
    scoredHoldings: [holding("X", "Tech", 30000, 30000, { v3: 60 })],
    mutations: [{ ticker: "X", deltaRupees: -50000 }],
  });
  assert("over-trim → warning about exceeding", r.warnings.some((w) => w.includes("exceeds")), r.warnings);
  assert("over-trim → kind=full-exit", r.mutationsApplied[0]?.kind === "full-exit", r.mutationsApplied);
  assert("over-trim → scenario totalValue 0", r.scenario.totalValue === 0, r.scenario.totalValue);
}

// ──────────────────── Health direction ────────────────────

console.log("\nHealth score direction\n");
{
  // Concentrated portfolio (one stock at 80% weight)
  const r = simulate({
    scoredHoldings: [
      holding("BIG", "Tech", 800000, 400000, { v3: 60, beta: 1.4 }),
      holding("A", "Banking", 100000, 80000, { v3: 65 }),
      holding("B", "Energy", 100000, 80000, { v3: 55 }),
    ],
    mutations: [
      { ticker: "BIG", deltaRupees: -500000 },          // big trim of the over-concentrated name
      { ticker: "A", deltaRupees: 250000 },             // redistribute
      { ticker: "B", deltaRupees: 250000 },
    ],
  });
  assert("concentrated trim + redistribute → health up",
    r.deltas.healthScore > 0, r.deltas.healthScore);
  // Single-name concentration drops from 80% (BIG) to ~30% (after trim+redeploy).
  // largestPositionPct is the sensitive signal here — top-5 stays 100% with N=3.
  assert("concentrated trim → largestPositionPct down",
    r.deltas.largestPositionPct < 0, r.deltas.largestPositionPct);
}

// ──────────────────── Multi-mutation ────────────────────

console.log("\nMulti-mutation (trim + deploy)\n");
{
  // Plan-promised flow: trim ₹20K HAL, deploy ₹20K NETWEB → expect health up + sector concentration drop
  const r = simulate({
    scoredHoldings: [
      holding("HAL", "Capital Goods", 100000, 70000, { v3: 70 }),
      holding("HDFCBANK", "Banking", 60000, 60000, { v3: 65 }),
    ],
    mutations: [
      { ticker: "HAL", deltaRupees: -20000 },
      { ticker: "NETWEB", deltaRupees: 20000 },
    ],
    freshPicks: [{ ticker: "NETWEB", sector: "Tech", market_cap_inr: 12000 * 1e7, v3_score: 75 }],
  });
  assert("totalValue preserved (₹20K out, ₹20K in)",
    r.scenario.totalValue === r.baseline.totalValue, [r.baseline.totalValue, r.scenario.totalValue]);
  assert("Capital Goods sector down",
    (r.deltas.sectorMix["Capital Goods"] || 0) < 0, r.deltas.sectorMix);
  assert("Tech sector up (NETWEB landed)",
    (r.deltas.sectorMix.Tech || 0) > 0, r.deltas.sectorMix);
}

// ──────────────────── Summary ────────────────────

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
