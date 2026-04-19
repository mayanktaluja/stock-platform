#!/usr/bin/env node
/**
 * Generate Nifty 500 stockList additions.
 *
 * Reads /tmp/nifty500.csv (from NSE's public CSV), dedups against the
 * existing stockList.js entries, maps NSE's "Industry" to our internal
 * sector taxonomy, and emits new JS-literal entries we can paste into
 * stockList.js.
 *
 * Usage: node scripts/build-nifty500.mjs > /tmp/nifty500-additions.js
 */

import { readFileSync } from "fs";
import { ALL_STOCKS } from "../stockList.js";

// NSE Industry → our sector taxonomy.
// Keep consistent with existing entries so the sector-neutral logic
// (max 2 per sector, excluded sectors) continues to work.
const INDUSTRY_TO_SECTOR = {
  "Financial Services": "Finance",
  "Banking": "Banking",
  "Banks": "Banking",
  "Information Technology": "IT",
  "Oil Gas & Consumable Fuels": "Energy",
  "Oil & Gas": "Energy",
  "Power": "Power",
  "Fast Moving Consumer Goods": "FMCG",
  "FMCG": "FMCG",
  "Consumer Durables": "Consumer",
  "Consumer Services": "Consumer",
  "Automobile and Auto Components": "Auto",
  "Automobile": "Auto",
  "Healthcare": "Pharma",
  "Pharma": "Pharma",
  "Metals & Mining": "Metals",
  "Metals": "Metals",
  "Construction Materials": "Cement",
  "Cement": "Cement",
  "Cement & Cement Products": "Cement",
  "Telecommunication": "Telecom",
  "Telecom": "Telecom",
  "Capital Goods": "Capital Goods",
  "Chemicals": "Chemicals",
  "Diversified": "Diversified",
  "Realty": "Real Estate",
  "Real Estate": "Real Estate",
  "Media Entertainment & Publication": "Media",
  "Media": "Media",
  "Textiles": "Textiles",
  "Services": "Services",
  "Construction": "Construction",
  "Forest Materials": "Forest",
};

function mapSector(industry) {
  if (!industry) return "Diversified";
  return INDUSTRY_TO_SECTOR[industry.trim()] || industry.trim();
}

const existing = new Set(ALL_STOCKS.map((s) => s.symbol));

const csvPath = "/tmp/nifty500.csv";
const raw = readFileSync(csvPath, "utf-8");
const lines = raw.split("\n").filter((l) => l.trim().length > 0);
const header = lines.shift();

const additions = [];
const existingTagUpdates = [];

for (const line of lines) {
  // CSV fields can contain commas inside quoted strings, but NSE's file
  // doesn't quote — so naive split works here. Defensive: cap at 5 fields.
  const parts = line.split(",");
  if (parts.length < 5) continue;
  const [name, industry, symbol] = parts;
  if (!symbol) continue;
  const tkr = symbol.trim() + ".NS";

  if (existing.has(tkr)) {
    existingTagUpdates.push(tkr);
    continue;
  }

  const sector = mapSector(industry);
  const cleanName = name.replace(/\s+Ltd\.?$/i, "").replace(/"/g, "").trim();
  additions.push({ symbol: tkr, name: cleanName, sector, indices: ["NIFTY500"] });
}

console.log(`// ${additions.length} NEW Nifty 500 entries (${existingTagUpdates.length} already in list — need NIFTY500 tag added manually)`);
console.log(`// Existing symbols that also belong in Nifty 500:`);
for (const s of existingTagUpdates) console.log(`//   ${s}`);
console.log("");
console.log("// Paste these into stockList.js under a new '// ========== NIFTY 500 ==========' section:");
console.log("");
for (const a of additions) {
  const escName = a.name.replace(/"/g, '\\"');
  console.log(`  { symbol: "${a.symbol}", name: "${escName}", sector: "${a.sector}", indices: ["NIFTY500"] },`);
}
