#!/usr/bin/env node
// Measures the Portfolio Analyzer action mix off a broker export WITHOUT
// booting the server — the before/after attribution harness for the Top-up
// cap levers (plan: portfolio-analyzer-fix-50-top-up).
//
//   node scripts/measure-analyzer-action-mix.mjs [file.xlsx|csv] \
//     [--json] [--out path] [--simulate-cap] [--abs-bar] [--k N]
//
// Default input is the committed synthetic fixture; pass the real Groww
// export path for a production baseline. Results depend on the local SWS
// data snapshot (data/sws/picks-latest.json + deep briefs) — run before/after
// comparisons on the SAME snapshot.
//
// Read-only by design: no NSE/Yahoo/LLM calls (unmatched rows are reported,
// not live-resolved), writes only stdout and the optional --out file.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePortfolioFile } from "../portfolioParser.js";
import { scoreHolding } from "../services/swsHoldingEngine.js";
import { buildSWSReport } from "../services/swsPortfolioAggregate.js";
import { ALL_TOPUP_ACTIONS } from "../services/actionLadder.js";
import { candidateBaseRank, holdingRankInputs, coreAddQualityFailures } from "../services/portfolio/addCandidateRank.js";
import { applyTopUpBadgeCap } from "../services/portfolio/topUpCapPolicy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const VALUE_FLAGS = new Set(["--out", "--k"]);
const positional = args.filter((a, i) =>
  !a.startsWith("--") && !VALUE_FLAGS.has(args[i - 1]) && !/^\d+$/.test(a));
const kOverride = (() => {
  const i = args.indexOf("--k");
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : null;
})();
const outPath = (() => {
  const i = args.indexOf("--out");
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
})();

const inputFile = positional[0]
  ? path.resolve(positional[0])
  : path.join(repoRoot, "test", "e2e", "fixtures", "portfolio-sample.csv");

if (!fs.existsSync(inputFile)) {
  console.error(`input not found: ${inputFile}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Two-pass scoring — replicates server.js runSWSAnalysis (server.js:7667-7744).
// Pass 1 with zero weights pulls SWS price + sector; totals give real
// position/sector weights; pass 2 re-scores so weight-gated action mapping
// fires. Earnings snapshot / fundamentalsHistory / macro regime are omitted:
// they tune reasons and severity shading, not the score-band action family.
// ---------------------------------------------------------------------------
const parsed = parsePortfolioFile(fs.readFileSync(inputFile), path.basename(inputFile));
const equityHoldings = parsed.holdings.map((h) => {
  const qty = Number(h.quantity) || 0;
  const avg = Number(h.avgPrice) || 0;
  return { ...h, quantity: qty, avgPrice: avg, invested: qty * avg };
});

const firstPass = equityHoldings.map((h) =>
  scoreHolding({ ...h, positionWeight: 0, sectorWeight: 0, pnlPercent: 0 }, { sectorWeights: {} }),
);

let totalCurrent = 0;
const sectorCV = new Map();
const enrichedRows = firstPass.map((row) => {
  const pickFinite = (n) => (n != null && Number.isFinite(n) && n > 0 ? n : null);
  const swsPrice = row.swsCovered ? Number(row.sws?.current_price_inr) : null;
  const fallbackPrice = !row.swsCovered && row.sws?.current_price_inr != null
    ? Number(row.sws.current_price_inr) : null;
  const brokerPrice = Number(row.closePrice) || 0;
  const qty = Number(row.quantity) || 0;
  const invested = qty * (Number(row.avgPrice) || 0);
  const livePrice = pickFinite(swsPrice) ?? pickFinite(fallbackPrice) ?? (brokerPrice > 0 ? brokerPrice : null);
  const currentValue = livePrice != null ? qty * livePrice : invested;
  totalCurrent += currentValue;
  const sector = row.sector || (row.swsCovered ? row.sws.sector : null) || "Unclassified";
  sectorCV.set(sector, (sectorCV.get(sector) || 0) + currentValue);
  return { ...row, invested, currentValue, sector };
});

const sectorWeights = {};
for (const [sector, cv] of sectorCV.entries()) {
  sectorWeights[sector] = totalCurrent > 0 ? (cv / totalCurrent) * 100 : 0;
}

const scoredHoldings = enrichedRows.map((row) => {
  const positionWeight = totalCurrent > 0 ? (row.currentValue / totalCurrent) * 100 : 0;
  const sectorWeight = sectorWeights[row.sector] || 0;
  const pnlPercent = row.invested > 0 ? ((row.currentValue - row.invested) / row.invested) * 100 : 0;
  const rescored = scoreHolding(
    { ...row, positionWeight, sectorWeight, pnlPercent },
    { sectorWeights },
  );
  return {
    ...rescored,
    invested: Math.round(row.invested),
    currentValue: Math.round(row.currentValue),
    pnlPercent: Math.round(pnlPercent * 100) / 100,
    positionWeight: Math.round(positionWeight * 100) / 100,
    sectorWeight: Math.round(sectorWeight * 100) / 100,
  };
});

// ---------------------------------------------------------------------------
// Action mix — same bucketing as the UI bar (gated/app.js renderAnalyzerActionMixBar)
// ---------------------------------------------------------------------------
function bucketOf(action) {
  const a = String(action || "");
  if (a.startsWith("Reduction-")) return "Reduce";
  if (a === "Top-up-if-funded") return "Top-up (if funded)";
  if (a.startsWith("Top-up-") || ALL_TOPUP_ACTIONS.has(a)) return "Top-up";
  if (a === "HOLD") return "Hold";
  if (a === "EXIT" || a.startsWith("EXIT-")) return "Exit";
  return `other:${a}`;
}

function summarize(holdings) {
  const perAction = {};
  const perBucket = {};
  for (const h of holdings) {
    const a = h.action || "n/a";
    perAction[a] = (perAction[a] || 0) + 1;
    const b = bucketOf(a);
    perBucket[b] = (perBucket[b] || 0) + 1;
  }
  return { perAction, perBucket };
}

// Shared core add-quality gates (services/portfolio/addCandidateRank.js) —
// same thresholds the engine's badge gate and the plan's funding gate use.
function qualityGateFailures(sws) {
  return coreAddQualityFailures({
    v4_score: sws?.v4_score,
    valuation_confidence: sws?.valuation_confidence,
    valuation_band: sws?.valuation_band,
    upside_pct: sws?.upside_pct,
  });
}

const isTopUp = (h) => ALL_TOPUP_ACTIONS.has(h.action) && h.action !== "Top-up-if-funded";

// Pre-gate eligibility pool — the scoreBandAction Top-up entry conditions
// (v4 ≥ 47, upside ≥ 5, pw ≤ 8) BEFORE the add-quality/staleness/news gates.
// This is the "top-up-eligible share" KPI: it stays measurable even on a
// stale SWS snapshot (e.g. the 22-day Groww outage window) where the
// data-quality gate blocks every actual Top-up badge.
const potentialPool = scoredHoldings.filter((h) =>
  h.swsCovered
  && Number(h.sws?.v4_score) >= 47
  && Number(h.sws?.upside_pct) >= 5
  && Number(h.positionWeight) <= 8);
const candidates = scoredHoldings
  .filter((h) => h.swsCovered && isTopUp(h))
  .map((h) => {
    const rankScore = candidateBaseRank(holdingRankInputs(h));
    return { h, rankScore };
  })
  .sort((a, b) =>
    (b.rankScore - a.rankScore)
    || ((b.h.sws?.upside_pct ?? -Infinity) - (a.h.sws?.upside_pct ?? -Infinity))
    || ((b.h.sws?.v4_score ?? -Infinity) - (a.h.sws?.v4_score ?? -Infinity))
    || String(a.h.sws?.ticker || a.h.symbol).localeCompare(String(b.h.sws?.ticker || b.h.symbol)));

const bookCount = scoredHoldings.filter((h) => h.swsCovered).length;
const k = kOverride ?? Math.min(5, Math.max(1, Math.ceil(0.10 * bookCount)));

const baseline = summarize(scoredHoldings);
const report = buildSWSReport(scoredHoldings, {});

const result = {
  generated_for: path.basename(inputFile),
  holdings_total: scoredHoldings.length,
  sws_covered: bookCount,
  unmatched: (parsed.unmatched || []).map((u) => u.rawName || u.symbol),
  action_mix: baseline.perAction,
  bucket_mix: baseline.perBucket,
  topup_full_count: candidates.length,
  topup_pct_of_book: bookCount ? +((candidates.length / bookCount) * 100).toFixed(1) : 0,
  potential_pool_pre_gate: potentialPool.map((h) => ({
    ticker: h.sws?.ticker || h.symbol,
    v4: h.sws?.v4_score ?? null,
    upside_pct: h.sws?.upside_pct ?? null,
    action: h.action,
    blocked: (h.blockedReasons || []).slice(0, 1),
  })),
  potential_pool_pct_of_book: bookCount ? +((potentialPool.length / bookCount) * 100).toFixed(1) : 0,
  k,
  tier_sizes: Object.fromEntries(Object.entries(report.tiers || {}).map(([t, v]) => [t, (v.rows || []).length])),
  tierA_freed_rupees: report.tiers?.A?.freedRupees ?? null,
  add_candidates: candidates.map(({ h, rankScore }, i) => ({
    rank: i + 1,
    ticker: h.sws?.ticker || h.symbol,
    action: h.action,
    v4: h.sws?.v4_score ?? null,
    upside_pct: h.sws?.upside_pct ?? null,
    position_weight: h.positionWeight,
    rank_score: rankScore,
    quality_gate_failures: qualityGateFailures(h.sws),
    would_keep: i < k,
  })),
};

if (flags.has("--simulate-cap")) {
  // Authoritative simulation: run the REAL cap module over copies so the
  // script can never drift from production behavior.
  const sim = scoredHoldings.map((h) => ({ ...h, reasons: [...(h.reasons || [])] }));
  const capSummary = applyTopUpBadgeCap(sim, { enabled: true, ...(kOverride != null ? { k: kOverride } : {}) });
  result.simulated_cap = {
    k: capSummary.k,
    kept: capSummary.kept.map((x) => x.ticker),
    demoted_by_rank: capSummary.demotedByRank.map((x) => x.ticker),
    demoted_by_bar: flags.has("--abs-bar")
      ? result.add_candidates.filter((c) => c.would_keep && c.quality_gate_failures.length > 0).map((c) => c.ticker)
      : [],
  };
}

if (flags.has("--json")) {
  const json = JSON.stringify(result, null, 2);
  if (outPath) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(path.resolve(outPath), json + "\n");
    console.log(`wrote ${outPath}`);
  } else {
    console.log(json);
  }
} else {
  console.log(`\n=== Analyzer action mix — ${result.generated_for} ===`);
  console.log(`holdings: ${result.holdings_total} (SWS-covered ${result.sws_covered}); unmatched: ${result.unmatched.join(", ") || "none"}`);
  console.log(`\nPer action:`);
  for (const [a, n] of Object.entries(result.action_mix).sort((x, y) => y[1] - x[1])) console.log(`  ${a.padEnd(22)} ${n}`);
  console.log(`\nBuckets: ${Object.entries(result.bucket_mix).map(([b, n]) => `${b} ${n}`).join(" · ")}`);
  console.log(`\nFull TOP-UP count: ${result.topup_full_count} (${result.topup_pct_of_book}% of covered book); k would be ${k}`);
  console.log(`Pre-gate eligible pool (v4≥47, upside≥5, pw≤8): ${result.potential_pool_pre_gate.length} (${result.potential_pool_pct_of_book}% of covered book)`);
  for (const c of result.potential_pool_pre_gate) {
    console.log(`  ${String(c.ticker).padEnd(13)} v4 ${String(c.v4).padEnd(5)} upside ${String(c.upside_pct).padEnd(6)} → ${c.action}${c.blocked.length ? ` (blocked: ${c.blocked[0]})` : ""}`);
  }
  console.log(`Tier sizes: ${JSON.stringify(result.tier_sizes)}; Tier A freed ₹${result.tierA_freed_rupees}`);
  console.log(`\nRanked add candidates (top-${k} kept under the cap):`);
  console.log(`  #  ticker        v4    upside  pw     rank    gates          keep`);
  for (const c of result.add_candidates) {
    console.log(`  ${String(c.rank).padEnd(2)} ${String(c.ticker).padEnd(13)} ${String(c.v4 ?? "—").padEnd(5)} ${String(c.upside_pct ?? "—").padEnd(7)} ${String(c.position_weight).padEnd(6)} ${String(c.rank_score).padEnd(7)} ${(c.quality_gate_failures.join(",") || "pass").padEnd(14)} ${c.would_keep ? "KEEP" : "demote"}`);
  }
  if (result.simulated_cap) {
    console.log(`\nSimulated cap: kept [${result.simulated_cap.kept.join(", ")}]`);
    console.log(`  demoted by rank: [${result.simulated_cap.demoted_by_rank.join(", ")}]`);
    if (flags.has("--abs-bar")) console.log(`  demoted by bar (of kept): [${result.simulated_cap.demoted_by_bar.join(", ")}]`);
  }
  console.log("");
}
