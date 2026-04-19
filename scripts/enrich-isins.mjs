#!/usr/bin/env node
/**
 * Adds `isin` field to every matching entry in stockList.js.
 *
 * Groww/Zerodha portfolio exports identify holdings by ISIN. Our
 * stockList identifies stocks by ticker ("HDFCBANK.NS"). We need a
 * bridge so the Portfolio Analyzer can resolve uploaded holdings →
 * platform-scored stocks.
 *
 * Source: /tmp/nifty500.csv already has ISIN Code column.
 *
 * Usage: node scripts/enrich-isins.mjs
 * Writes: stockList.js modified in place with `isin: "INE..."` fields
 */

import { readFileSync, writeFileSync } from "fs";

const NIFTY500_CSV = "/tmp/nifty500.csv";
const STOCKLIST_PATH = "stockList.js";

// 1. Build symbol → ISIN map from NSE CSV
const csv = readFileSync(NIFTY500_CSV, "utf-8");
const lines = csv.trim().split("\n").slice(1); // skip header

const symbolToIsin = new Map();
for (const line of lines) {
  const parts = line.split(",");
  if (parts.length < 5) continue;
  const [, , symbol, , isin] = parts;
  if (!symbol || !isin) continue;
  symbolToIsin.set(symbol.trim() + ".NS", isin.trim());
}
console.log(`Loaded ${symbolToIsin.size} ISINs from NSE CSV`);

// 2. Load stockList.js, add `isin: "..."` to each entry that has a mapping
let content = readFileSync(STOCKLIST_PATH, "utf-8");
const entryRegex = /\{\s*symbol:\s*"([^"]+)",([^}]+)\}/g;

let added = 0;
let skipped = 0;
let alreadyHad = 0;

const newContent = content.replace(entryRegex, (match, symbol, body) => {
  if (/\bisin:\s*"/.test(body)) {
    alreadyHad++;
    return match;
  }
  const isin = symbolToIsin.get(symbol);
  if (!isin) {
    skipped++;
    return match;
  }
  added++;
  // Insert isin after symbol, before next field
  return match.replace(
    `symbol: "${symbol}",`,
    `symbol: "${symbol}", isin: "${isin}",`,
  );
});

writeFileSync(STOCKLIST_PATH, newContent, "utf-8");
console.log(`Enriched: ${added} added, ${alreadyHad} already had, ${skipped} no match (not in Nifty 500).`);
