#!/usr/bin/env node
// PR 2 verification — exercises the catalyst (Layer 4) and Indian-risk
// (Layer 3) shadow attaches on the sample portfolio. Reports per-stock
// catalystScore, risk_score, surveillance flags, and the conviction
// nudges each layer would contribute.

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
  const cat = scored.sws.catalyst;
  const risk = scored.sws.indianRisk;
  rows.push({
    symbol: scored.sws.ticker,
    action: scored.action,
    cat_score: cat?.catalystScore ?? 0,
    cat_delta: cat?.confidence_delta ?? 0,
    cat_pending: (cat?.pending_catalysts || []).length,
    cat_eps: cat?.next_earnings_days,
    cat_summary: cat?.summary || "",
    risk_score: risk?.risk_score ?? 0,
    risk_delta: risk?.confidence_delta ?? 0,
    risk_flags: (risk?.risk_flags || []).length,
    risk_summary: risk?.summary || "",
    surv: risk?.surveillance ? `${risk.surveillance.list}${risk.surveillance.timeframe ? "/" + risk.surveillance.timeframe : ""}` : "—",
  });
}

console.log("\n=== Per-stock catalyst + risk layers ===\n");
console.log(["TICKER", "ACTION", "CATs", "Δcat", "PEND", "EPSd", "SURV", "RISKs", "Δrisk", "FLGs"]
  .map((h, i) => h.padEnd(i === 1 ? 17 : 7)).join(""));
console.log("─".repeat(110));
for (const r of rows) {
  if (r.status === "no-sws-data") {
    console.log(`${r.symbol.padEnd(17)} no-sws-data`);
    continue;
  }
  const cells = [
    r.symbol.padEnd(7),
    (r.action || "—").padEnd(17),
    `${r.cat_score >= 0 ? "+" : ""}${r.cat_score}`.padEnd(7),
    `${r.cat_delta > 0 ? "+1" : r.cat_delta < 0 ? "-1" : " 0"}`.padEnd(7),
    `${r.cat_pending}`.padEnd(7),
    `${r.cat_eps ?? "—"}`.padEnd(7),
    r.surv.padEnd(7),
    `${r.risk_score}`.padEnd(7),
    `${r.risk_delta > 0 ? "+1" : r.risk_delta < 0 ? "-1" : " 0"}`.padEnd(7),
    `${r.risk_flags}`.padEnd(7),
  ];
  console.log(cells.join(""));
}

const covered = rows.filter((r) => r.action !== undefined && r.action !== null && r.status !== "no-sws-data");
console.log("\n=== Aggregate ===\n");
console.log(`Covered                   : ${covered.length}`);
console.log(`Catalyst Δconf +1 (bullish): ${covered.filter((r) => r.cat_delta === +1).length}`);
console.log(`Catalyst Δconf  0          : ${covered.filter((r) => r.cat_delta === 0).length}`);
console.log(`Catalyst Δconf -1 (bearish): ${covered.filter((r) => r.cat_delta === -1).length}`);
console.log(`Risk Δconf -1 (overlay)    : ${covered.filter((r) => r.risk_delta === -1).length}`);
console.log(`Surveillance flagged       : ${covered.filter((r) => r.surv !== "—").length}`);

console.log("\n=== Holdings with active catalysts (top 10) ===\n");
for (const r of covered.filter((c) => c.cat_pending > 0).slice(0, 10)) {
  console.log(`${r.symbol}  ${r.action}  cat ${r.cat_score >= 0 ? "+" : ""}${r.cat_score}  → ${r.cat_summary}`);
}

console.log("\n=== Holdings with India-risk overlays ===\n");
for (const r of covered.filter((c) => c.risk_score < 0)) {
  console.log(`${r.symbol}  ${r.action}  risk ${r.risk_score}  → ${r.risk_summary}`);
}
