#!/usr/bin/env node
// Parse get_page_text output from SWS sector filter pages into a stock array.
// Reads page text from stdin, writes { stocks: [...], totalPages: N, totalCompanies: N } to stdout.
//
// Usage:
//   cat /tmp/page.txt | node scripts/sws-parse-page.mjs
//   cat /tmp/page.txt | node scripts/sws-parse-page.mjs --stocks-only   (raw array for --record)

import process from "node:process";

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

async function main() {
  const stocksOnly = process.argv.includes("--stocks-only");

  const pageText = await new Promise((res, rej) => {
    let d = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", c => d += c);
    process.stdin.on("end", () => res(d));
    process.stdin.on("error", rej);
  });

  // Extract total pages from "Page N of M" — this pagination line is at the very end of page text
  const pageMatch = pageText.match(/Page\s+(\d+)\s+of\s+(\d+)\s*$/i);
  const currentPage = pageMatch ? parseInt(pageMatch[1]) : 1;
  const totalPages = pageMatch ? parseInt(pageMatch[2]) : 1;

  // Extract total companies from "NNN companies" text
  const companiesMatch = pageText.match(/(\d+)\s+companies/i);
  const totalCompanies = companiesMatch ? parseInt(companiesMatch[1]) : null;

  // Extract JSON-LD
  const jsonStr = extractFirstJson(pageText);
  if (!jsonStr) {
    process.stderr.write("ERROR: No JSON-LD found in page text\n");
    const out = stocksOnly ? "[]" : JSON.stringify({ stocks: [], totalPages, currentPage, totalCompanies });
    process.stdout.write(out);
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(jsonStr);
  } catch (e) {
    process.stderr.write(`ERROR: Failed to parse JSON-LD: ${e.message}\n`);
    const out = stocksOnly ? "[]" : JSON.stringify({ stocks: [], totalPages, currentPage, totalCompanies });
    process.stdout.write(out);
    process.exit(1);
  }

  const itemList = data?.mainEntity?.[0]?.itemListElement;
  if (!Array.isArray(itemList) || itemList.length === 0) {
    process.stderr.write("ERROR: No itemListElement in JSON-LD\n");
    const out = stocksOnly ? "[]" : JSON.stringify({ stocks: [], totalPages, currentPage, totalCompanies });
    process.stdout.write(out);
    process.exit(1);
  }

  const stocks = [];
  for (const entry of itemList) {
    const item = entry?.item;
    if (!item?.url) continue;
    const swsUrl = item.url;

    // Determine exchange from URL slug: /stocks/in/{sector}/{nse|bse}-{slug}/...
    const urlMatch = swsUrl.match(/\/stocks\/in\/([^/]+)\/(nse|bse)-([^/]+)\//i);
    const exchange = urlMatch ? urlMatch[2].toUpperCase() : "NSE";
    const sectorFromUrl = urlMatch ? urlMatch[1] : null;

    // Ticker: NSE → use tickerSymbol string; BSE → use numeric/string code
    const ts = item.tickerSymbol;
    let ticker = "";
    if (exchange === "NSE" && ts != null && typeof ts === "string" && ts.trim()) {
      ticker = ts.trim().toUpperCase();
    } else if (exchange === "BSE") {
      ticker = String(ts).trim();
    } else {
      ticker = String(ts ?? "").trim().toUpperCase();
    }

    if (!ticker) continue;

    stocks.push({
      ticker,
      name: item.name || item.legalName || null,
      exchange,
      sector: sectorFromUrl,
      industry: null,
      indices: [],
      market_cap_inr: null,
      sws_url: swsUrl,
      seed_only: false,
      curated: false,
    });
  }

  if (stocksOnly) {
    process.stdout.write(JSON.stringify(stocks));
  } else {
    process.stdout.write(JSON.stringify({ stocks, totalPages, currentPage, totalCompanies }));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
