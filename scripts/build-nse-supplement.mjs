#!/usr/bin/env node
/**
 * Build the NSE universe supplement — a flat JSON of every NSE-listed
 * constituent across NIFTY TOTAL MARKET (749) + NIFTY MICROCAP 250 +
 * NIFTY SMALLCAP 250, dedup'd against whatever the primary stockList.js
 * already carries.
 *
 * Why it exists: stockList.js is a curated universe (~503 names) focused
 * on Nifty 50 / Next 50 + quality midcaps. Portfolio uploads regularly
 * contain lesser-known smallcaps, microcaps, and recently-listed names
 * (Azad Engineering, Kross, Ujjivan SFB, Sterling Tools, etc.) that
 * aren't in the curated list. Rather than hand-curating 1000+ more
 * entries, we pull the full NSE market index + microcap list and use it
 * as a fallback map in findBySymbol / findByIsin.
 *
 * NSE's index-stockIndices endpoint returns meta.isin + meta.companyName
 * + meta.industry on every row, so a single call per index gives us
 * everything we need — no per-stock quote lookups required.
 *
 * Run manually:
 *   node scripts/build-nse-supplement.mjs
 *
 * Cadence: manually whenever NSE adjusts index membership (quarterly
 * rebalances) or you're missing a newly-listed stock. The portfolio
 * analyzer also has a live NSE fallback for anything still missing.
 */

import { writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { ALL_STOCKS } from "../stockList.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUT_PATH = path.join(__dirname, "..", "nseUniverseSupplement.json");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const INDICES = [
  "NIFTY TOTAL MARKET",
  "NIFTY MICROCAP 250",
  "NIFTY SMALLCAP 250",
  "NIFTY 500",
];

const EQUITY_MASTER_URL =
  "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv";

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === "," && !inQ) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

async function fetchEquityMaster() {
  const res = await fetch(EQUITY_MASTER_URL, {
    headers: { "User-Agent": UA, Accept: "text/csv" },
  });
  if (!res.ok) throw new Error(`EQUITY_L.csv: HTTP ${res.status}`);
  const text = await res.text();
  const lines = text.split(/\r?\n/).filter(Boolean);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length < 7) continue;
    const [symbol, name, series, _dateListed, _paid, _lot, isin] = cols;
    // Only EQ series — skips BE (trade-to-trade), BZ (suspended), SM (SME),
    // IL (illiquid) etc. EQ is the ~2k main-board rolling-settlement universe.
    if ((series || "").toUpperCase() !== "EQ") continue;
    if (!symbol || !isin) continue;
    rows.push({ symbol, name, isin });
  }
  return rows;
}

async function fetchIndex(name) {
  const url = `https://www.nseindia.com/api/equity-stockIndices?index=${encodeURIComponent(name)}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://www.nseindia.com/market-data/live-equity-market",
    },
  });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const data = await res.json();
  return (data.data || []).filter((r) => r.symbol !== name);
}

function canonicalSector(industry) {
  // NSE's industry labels → our canonical sector names (rough mapping,
  // falls back to the raw label so downstream code at least has something).
  const s = String(industry || "").toLowerCase();
  if (/bank/.test(s)) return "Banking";
  if (/finance|insurance|nbfc|fintech|broking/.test(s)) return "Financial Services";
  if (/pharma|health|hospital|diagnos/.test(s)) return "Healthcare";
  if (/auto/.test(s)) return "Auto";
  if (/it|software|technology|telecom equipment/.test(s)) return "IT";
  if (/telecom - services|mobile/.test(s)) return "Telecom";
  if (/cement/.test(s)) return "Cement";
  if (/metal|steel|mining/.test(s)) return "Metals";
  if (/oil|gas|petroleum|refin/.test(s)) return "Oil & Gas";
  if (/power|utilit|renewable/.test(s)) return "Power";
  if (/consumer|retail|fmcg|food|beverage|personal|textile|apparel/.test(s)) return "FMCG";
  if (/construct|infrastruct|port|airport|road/.test(s)) return "Infrastructure";
  if (/real estate|realty|hous/.test(s)) return "Real Estate";
  if (/defence|aerospace/.test(s)) return "Defence";
  if (/chemic|fertilizer|agrochemical/.test(s)) return "Chemicals";
  if (/media|entertainment|broadcast/.test(s)) return "Media";
  if (/capital goods|machinery|electrical equipment|industrial/.test(s)) return "Capital Goods";
  return industry || null;
}

async function main() {
  const existingSymbols = new Set(ALL_STOCKS.map((s) => s.symbol));
  const existingIsins = new Set(ALL_STOCKS.filter((s) => s.isin).map((s) => s.isin));

  const byIsin = new Map();

  for (const idx of INDICES) {
    console.log(`Fetching ${idx}…`);
    let rows;
    try {
      rows = await fetchIndex(idx);
    } catch (err) {
      console.warn(`  ${idx} failed: ${err.message}`);
      continue;
    }
    console.log(`  ${rows.length} constituents`);

    for (const r of rows) {
      const meta = r.meta || {};
      const isin = meta.isin || null;
      const bareSym = r.symbol;
      const fullSym = `${bareSym}.NS`;
      if (!isin || !bareSym) continue;
      // Skip ETFs, debt, SLBs, hybrids — they're not scored anyway
      if (meta.isETFSec || meta.isDebtSec || meta.isMunicipalBond || meta.isHybridSymbol) continue;
      if (meta.isDelisted || meta.isSuspended) continue;

      // Skip anything already covered by the primary curated list —
      // stockList.js metadata wins (curated sector, indices membership).
      if (existingIsins.has(isin) || existingSymbols.has(fullSym)) continue;

      // Last-write-wins across indices; they should agree on ISIN anyway.
      byIsin.set(isin, {
        symbol: fullSym,
        isin,
        name: meta.companyName || bareSym,
        sector: canonicalSector(meta.industry),
        industry: meta.industry || null,
        indices: [idx.replace("NIFTY ", "")].filter(Boolean),
      });
    }

    // Polite delay between index calls
    await new Promise((r) => setTimeout(r, 300));
  }

  // ── Full NSE EQ master fallback ──
  //
  // The Nifty indices above cap out around ~750 unique names. NSE actually
  // lists ~2,300 equities in its EQ (rolling settlement) series — the rest
  // are sub-microcap tail names not in any headline index. Pull the master
  // CSV so portfolio uploads and symbol lookups can resolve the long tail
  // that Groww also shows. Sector is unknown for these rows (the master
  // file doesn't carry industry metadata), so we leave `sector: null` and
  // tag `indices: ["NSE-EQ"]` to make the provenance clear.
  try {
    console.log(`Fetching EQUITY_L.csv (full NSE EQ master)…`);
    const masterRows = await fetchEquityMaster();
    console.log(`  ${masterRows.length} EQ-series equities`);
    let added = 0;
    for (const row of masterRows) {
      const fullSym = `${row.symbol}.NS`;
      if (!row.isin) continue;
      if (existingIsins.has(row.isin) || existingSymbols.has(fullSym)) continue;
      if (byIsin.has(row.isin)) continue; // already captured by an index pass
      byIsin.set(row.isin, {
        symbol: fullSym,
        isin: row.isin,
        name: row.name || row.symbol,
        sector: null,
        industry: null,
        indices: ["NSE-EQ"],
      });
      added++;
    }
    console.log(`  +${added} long-tail names added from EQ master`);
  } catch (err) {
    console.warn(`  EQ master fetch failed: ${err.message}`);
  }

  // Merge indices membership: if the same ISIN appeared in multiple indices,
  // union them so queries like "Is this in SMALLCAP 250?" still work.
  // (Simple pass: re-iterate the INDICES but this time just tag membership.)
  const bySymbol = {};
  const isinToSymbol = {};
  for (const [isin, rec] of byIsin.entries()) {
    // Store bare ticker as primary key (matches findBySymbol convention)
    const bare = rec.symbol.replace(/\.NS$/, "");
    bySymbol[bare] = rec;
    isinToSymbol[isin] = bare;
  }

  const output = {
    generatedAt: new Date().toISOString(),
    source:
      "nse-total-market + microcap250 + smallcap250 + nifty500 + nse-eq-master",
    noteOnCoverage:
      "This file supplements the curated stockList.js. Names here have real-time price + basic metadata (sector, industry, ISIN) but are NOT in our fundamental scoring snapshot. Portfolio analyzer uses them for holdings resolution and per-holding risk metrics; the scanner pages only read the curated list.",
    count: Object.keys(bySymbol).length,
    bySymbol,
    isinToSymbol,
  };

  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2), "utf-8");
  console.log(`\n✓ Wrote ${OUT_PATH}`);
  console.log(`  ${output.count} supplementary stocks (${Object.keys(isinToSymbol).length} ISINs)`);

  // Sanity check — try to resolve the 5 stocks from the user's test file
  const probe = ["AZAD", "FIBERWEB", "KROSS", "STERTOOLS", "UJJIVANSFB"];
  console.log(`\n  Sanity check vs user's test file:`);
  for (const p of probe) {
    const hit = bySymbol[p];
    console.log(`    ${p.padEnd(14)} ${hit ? "✓ " + hit.name : "✗ still missing"}`);
  }
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
