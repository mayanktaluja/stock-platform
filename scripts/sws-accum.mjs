#!/usr/bin/env node
// Append parsed stocks from a page-text file to the accumulator file.
// Usage:
//   node scripts/sws-accum.mjs /tmp/sws-page.txt [/tmp/sws-acc.json]
//
// Reads page text from the first arg, parses JSON-LD, appends to accumulator.
// Prints: "page N/M  +K stocks  total T" to stderr.

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function extractFirstJson(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (c === "\\" && inString) { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

function parsePageText(pageText) {
  const pageMatch = pageText.match(/Page\s+(\d+)\s+of\s+(\d+)\s*$/i);
  const currentPage = pageMatch ? parseInt(pageMatch[1]) : 1;
  const totalPages = pageMatch ? parseInt(pageMatch[2]) : 1;
  const companiesMatch = pageText.match(/(\d+)\s+companies/i);
  const totalCompanies = companiesMatch ? parseInt(companiesMatch[1]) : null;

  const jsonStr = extractFirstJson(pageText);
  if (!jsonStr) return { stocks: [], currentPage, totalPages, totalCompanies };

  let data;
  try { data = JSON.parse(jsonStr); } catch { return { stocks: [], currentPage, totalPages, totalCompanies }; }

  const itemList = data?.mainEntity?.[0]?.itemListElement;
  if (!Array.isArray(itemList)) return { stocks: [], currentPage, totalPages, totalCompanies };

  const stocks = [];
  for (const entry of itemList) {
    const item = entry?.item;
    if (!item?.url) continue;
    const swsUrl = item.url;
    const urlMatch = swsUrl.match(/\/stocks\/in\/([^/]+)\/(nse|bse)-([^/]+)\//i);
    const exchange = urlMatch ? urlMatch[2].toUpperCase() : "NSE";
    const sectorFromUrl = urlMatch ? urlMatch[1] : null;
    const ts = item.tickerSymbol;
    let ticker = "";
    if (exchange === "NSE" && typeof ts === "string" && ts.trim()) {
      ticker = ts.trim().toUpperCase();
    } else {
      ticker = String(ts ?? "").trim();
    }
    if (!ticker) continue;
    stocks.push({ ticker, name: item.name || item.legalName || null, exchange, sector: sectorFromUrl,
      industry: null, indices: [], market_cap_inr: null, sws_url: swsUrl, seed_only: false, curated: false });
  }
  return { stocks, currentPage, totalPages, totalCompanies };
}

function main() {
  const pageFile = process.argv[2];
  const accFile = process.argv[3] || "/tmp/sws-acc.json";
  if (!pageFile) { console.error("Usage: sws-accum.mjs <page-text-file> [acc-file]"); process.exit(1); }

  const pageText = fs.readFileSync(pageFile, "utf-8");
  const { stocks, currentPage, totalPages, totalCompanies } = parsePageText(pageText);

  let acc = [];
  try { acc = JSON.parse(fs.readFileSync(accFile, "utf-8")); } catch {}

  const seenUrls = new Set(acc.map(s => s.sws_url));
  const newStocks = stocks.filter(s => !seenUrls.has(s.sws_url));
  acc.push(...newStocks);

  fs.writeFileSync(accFile, JSON.stringify(acc));
  process.stderr.write(`  page ${currentPage}/${totalPages}  +${newStocks.length} stocks  total ${acc.length}` +
    (totalCompanies ? `  (${totalCompanies} co.)` : "") + "\n");
  // Output metadata as JSON for caller to read totalPages
  process.stdout.write(JSON.stringify({ currentPage, totalPages, totalCompanies, added: newStocks.length, total: acc.length }));
}

main();
