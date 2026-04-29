#!/usr/bin/env node
// PR 4 smoke — exercises peer-substitute discovery and the sector-wipeout
// guard on the sample portfolio.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scoreHolding } from "../services/swsHoldingEngine.js";
import { buildSWSReport } from "../services/swsPortfolioAggregate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORTFOLIO_PATH = path.resolve(__dirname, "..", "portfolio.json");

const portfolio = JSON.parse(fs.readFileSync(PORTFOLIO_PATH, "utf-8"));
const holdings = portfolio.stocks || [];

const heldTickers = new Set(holdings.map((h) => (h.symbol || "").replace(/\.NS$/i, "")));

const scored = holdings.map((h) => scoreHolding({
  symbol: h.symbol, name: h.name, sector: h.sector,
  quantity: h.quantity, avgPrice: h.avgPrice,
  positionWeight: 0, sectorWeight: 0, pnlPercent: 0,
}, { sectorWeights: {}, heldTickers }));

console.log("=== Peer substitutes per holding ===\n");
console.log(["TICKER", "SECTOR", "v3", "TOP PEER", "WHY"].map((c, i) => c.padEnd(i === 0 ? 12 : i === 1 ? 18 : i === 2 ? 6 : i === 3 ? 14 : 0)).join(""));
console.log("─".repeat(100));
let withPeers = 0;
for (const h of scored) {
  if (!h.swsCovered) {
    console.log(`${(h.symbol || "—").padEnd(12)}  no-sws-data`);
    continue;
  }
  const peer = h.sws.peer_substitute;
  if (peer?.top_peer) {
    withPeers++;
    console.log(
      `${h.sws.ticker.padEnd(12)}${(h.sws.sector || "—").padEnd(18)}${`${h.sws.v3_score}`.padEnd(6)}${peer.top_peer.ticker.padEnd(14)}${peer.top_peer.why}`,
    );
  } else {
    console.log(`${h.sws.ticker.padEnd(12)}${(h.sws.sector || "—").padEnd(18)}${`${h.sws.v3_score}`.padEnd(6)}—`);
  }
}
console.log(`\nWith peer substitutes: ${withPeers}/${scored.length}`);

console.log("\n=== Sector-wipeout guard ===\n");
const report = buildSWSReport(scored, { freshCapitalInr: null, freshPickLimit: 8 });
const wipes = report.tiers.A.sector_wipeouts || [];
if (wipes.length === 0) {
  console.log("No single-sector wipeouts in current Reduction tier.");
} else {
  for (const w of wipes) {
    console.log(`⚠ ${w.sector}: ${w.warning} (${w.affected_tickers.join(", ")})`);
  }
}
