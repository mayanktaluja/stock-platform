#!/usr/bin/env node
// Divergence smoke test for the Layer-2 independent-fundamentals cross-check.
//
// Walks every holding in portfolio.json through services/swsHoldingEngine.js
// and prints a per-stock + aggregate report of how often the independent
// (fundamentalsV2.js) and SWS layers agree, where they diverge, and what the
// resulting confidence_delta is. Doubles as PR 1's verification artifact.
//
// Usage:  node scripts/smoke-sws-crosscheck.mjs
// Exit code: 0 always (this is a report, not a pass/fail gate).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scoreHolding } from "../services/swsHoldingEngine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORTFOLIO_PATH = path.resolve(__dirname, "..", "portfolio.json");

const portfolio = JSON.parse(fs.readFileSync(PORTFOLIO_PATH, "utf-8"));
const holdings = portfolio.stocks || [];

const rows = [];
for (const h of holdings) {
  const scored = scoreHolding({
    symbol: h.symbol,
    name: h.name,
    sector: h.sector,
    quantity: h.quantity,
    avgPrice: h.avgPrice,
    positionWeight: 0,
    sectorWeight: 0,
    pnlPercent: 0,
  }, { sectorWeights: {} });

  if (!scored.swsCovered) {
    rows.push({ symbol: h.symbol, status: "no-sws-data" });
    continue;
  }

  const cc = scored.sws?.crosscheck;
  rows.push({
    symbol: scored.sws.ticker,
    sector: scored.sws.sector,
    sws_action: scored.action,
    sws_v3: scored.sws.v3_score,
    sws_verdict: scored.sws.v3_verdict,
    cc_available: cc?.available === true,
    indep_score: cc?.independent_score ?? null,
    indep_verdict: cc?.independent_verdict ?? null,
    agreement_pct: cc?.pillar_agreement_pct ?? null,
    divergent: (cc?.divergent_pillars || []).map((d) => `${d.pillar}(${d.delta > 0 ? "+" : ""}${d.delta})`).join(","),
    governance: cc?.governance?.score ?? null,
    confidence_delta: cc?.confidence_delta ?? 0,
    reason: cc?.reason || cc?.unavailable_reason || "",
  });
}

console.log("\n=== Per-stock cross-check ===\n");
console.log(
  ["TICKER", "ACTION", "v3", "INDEP", "AGREE%", "DIVERGENT", "GOV", "Δconf"].map((h) => h.padEnd(11)).join(""),
);
console.log("─".repeat(90));
for (const r of rows) {
  if (r.status === "no-sws-data") {
    console.log(`${r.symbol.padEnd(13)} no-sws-data`);
    continue;
  }
  const cells = [
    r.symbol,
    r.sws_action || "—",
    r.sws_v3 != null ? r.sws_v3.toFixed(0) : "—",
    r.indep_score != null ? r.indep_score.toFixed(0) : "—",
    r.agreement_pct != null ? `${r.agreement_pct}%` : "—",
    r.divergent || "—",
    r.governance != null ? r.governance.toFixed(0) : "—",
    r.confidence_delta > 0 ? "+1" : r.confidence_delta < 0 ? "-1" : " 0",
  ];
  console.log(cells.map((c, i) => String(c).padEnd(i === 5 ? 25 : 11)).join(""));
}

const covered = rows.filter((r) => r.cc_available);
const totalCovered = covered.length;
const agree = covered.filter((r) => r.confidence_delta === +1).length;
const neutral = covered.filter((r) => r.confidence_delta === 0).length;
const diverge = covered.filter((r) => r.confidence_delta === -1).length;
const noFundamentals = rows.filter((r) => r.cc_available === false && r.status !== "no-sws-data").length;
const noSws = rows.filter((r) => r.status === "no-sws-data").length;

console.log("\n=== Aggregate ===\n");
console.log(`Sample portfolio   : ${rows.length} holdings`);
console.log(`SWS+Layer2 covered : ${totalCovered}`);
console.log(`Layer2 unavailable : ${noFundamentals}  (no fundamentals.json snapshot or v2 returned null)`);
console.log(`SWS uncovered      : ${noSws}`);
console.log("");
console.log(`Layers AGREE   (Δconf +1) : ${agree.toString().padStart(2)}  (${pct(agree, totalCovered)}%)`);
console.log(`Layers NEUTRAL (Δconf  0) : ${neutral.toString().padStart(2)}  (${pct(neutral, totalCovered)}%)`);
console.log(`Layers DIVERGE (Δconf -1) : ${diverge.toString().padStart(2)}  (${pct(diverge, totalCovered)}%) ← these will get conviction-softened in PR 3`);

console.log("\n=== Divergence detail (Δconf = -1) ===\n");
for (const r of covered.filter((c) => c.confidence_delta === -1)) {
  console.log(`${r.symbol}  ${r.sws_action}  v3=${r.sws_v3}  indep=${r.indep_score}`);
  console.log(`  divergent pillars: ${r.divergent || "(composite gap only)"}`);
  console.log(`  reason: ${r.reason}`);
  console.log("");
}

function pct(n, d) {
  if (!d) return "0";
  return ((n / d) * 100).toFixed(0);
}
