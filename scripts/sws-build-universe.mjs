// Build /data/sws/universe.json — the master list of stocks to scrape.
//
// Two paths:
//   1) Seed-only: read nseUniverseSupplement.json (1,677 NSE tickers we already have)
//      and synthesise SWS URLs. Fast, no browser needed, but may miss BSE-only listings.
//   2) Browser-driven (preferred long-term): a Claude session uses Chrome MCP to paginate
//      https://simplywall.st/stocks/in/market-cap-large and extract canonical SWS URLs +
//      market caps directly. Pipes the resulting JSON array to this script's stdin.
//
// CLI:
//   node scripts/sws-build-universe.mjs --seed
//       → uses nseUniverseSupplement.json, produces a baseline universe.
//   node scripts/sws-build-universe.mjs --from-stdin < tickers.json
//       → tickers.json is `[{ ticker, exchange, sws_url, market_cap_inr, name }, ...]`
//          (typically produced by the /sws-build-universe slash command via Chrome MCP).
//   node scripts/sws-build-universe.mjs --merge --from-stdin < tickers.json
//       → merges new tickers with existing universe.json (dedupe by ticker).

import fs from "node:fs";
import path from "node:path";
import { PATHS, UNIVERSE } from "./sws-config.mjs";

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function ensureDataDir() {
  fs.mkdirSync(PATHS.dataDir, { recursive: true });
  fs.mkdirSync(PATHS.deepDir, { recursive: true });
}

// Best-effort SWS URL guess from NSE ticker + sector hint.
// SWS canonical URLs need the sector slug we don't always have, so we use a probe path
// that the scraper handles by following the SWS auto-redirect.
function guessSwsUrlForNse(ticker) {
  // The /stocks/in/<sector>/nse-<lower>/... format requires sector.
  // Without it, we use a search-driven path that the scraper resolves at runtime.
  return `https://simplywall.st/search?query=${encodeURIComponent(ticker)}`;
}

async function fromSeed() {
  // Source 1: nseUniverseSupplement.json (1,677 NSE tickers, no market cap)
  const supplementPath = path.resolve(PATHS.repoRoot, "nseUniverseSupplement.json");
  let supplementArr = [];
  if (fs.existsSync(supplementPath)) {
    const seed = JSON.parse(fs.readFileSync(supplementPath, "utf-8"));
    supplementArr = seed.bySymbol ? Object.values(seed.bySymbol) : [];
  }

  // Source 2: stockList.js (503 curated stocks with NIFTY50/NIFTY NEXT 50 tags)
  let curatedArr = [];
  try {
    const m = await import(path.resolve(PATHS.repoRoot, "stockList.js"));
    curatedArr = m.ALL_STOCKS || [];
  } catch (e) {
    console.warn(`Could not load stockList.js: ${e.message}`);
  }

  // Merge: curated takes priority for indices info; supplement adds breadth
  const byTicker = new Map();
  function add(s, isCurated) {
    const rawSym = (s.symbol || s.ticker || "").toUpperCase();
    const ticker = rawSym.replace(/\.(NS|BO)$/i, "");
    if (!ticker) return;
    const existing = byTicker.get(ticker);
    const indices = (s.indices || []).slice();
    const merged = {
      ticker,
      name: s.name || existing?.name || null,
      exchange: rawSym.endsWith(".BO") ? "BSE" : "NSE",
      sector: s.sector || existing?.sector || null,
      industry: s.industry || existing?.industry || null,
      indices: existing
        ? [...new Set([...(existing.indices || []), ...indices])]
        : indices,
      market_cap_inr: Number(s.marketCap) || Number(s.market_cap_inr) || existing?.market_cap_inr || null,
      sws_url: guessSwsUrlForNse(ticker),
      seed_only: true,
      curated: isCurated || existing?.curated || false,
    };
    byTicker.set(ticker, merged);
  }
  for (const s of curatedArr) add(s, true);
  for (const s of supplementArr) add(s, false);

  console.log(`  Curated (stockList.js): ${curatedArr.length}`);
  console.log(`  Supplement (nseUniverseSupplement.json): ${supplementArr.length}`);
  console.log(`  Deduped total: ${byTicker.size}`);

  return prioritiseAndIndex([...byTicker.values()]);
}

function dedupeAndIndex(arr) {
  const seen = new Map();
  for (const s of arr) {
    const key = s.ticker;
    if (!seen.has(key)) seen.set(key, s);
    else {
      const cur = seen.get(key);
      if (cur.exchange === "BSE" && s.exchange === "NSE") seen.set(key, s);
    }
  }
  return prioritiseAndIndex([...seen.values()]);
}

// Sort: NIFTY50 first, then NIFTY NEXT 50, then NIFTY500, then market-cap-known,
// then the rest. Within each tier sort by market cap desc when known.
function prioritiseAndIndex(arr) {
  function tier(s) {
    const idx = s.indices || [];
    if (idx.includes("NIFTY50")) return 1;
    if (idx.includes("NIFTY NEXT 50")) return 2;
    if (idx.includes("NIFTY 500") || idx.includes("NIFTY500")) return 3;
    if (idx.includes("MIDCAP 150") || idx.includes("MIDCAP150")) return 4;
    if (idx.includes("SMALLCAP 250") || idx.includes("SMALLCAP250")) return 5;
    if (idx.includes("MICROCAP 250") || idx.includes("MICROCAP250")) return 6;
    return 7;
  }
  const sorted = [...arr].sort((a, b) => {
    const ta = tier(a), tb = tier(b);
    if (ta !== tb) return ta - tb;
    const ma = a.market_cap_inr ?? -Infinity;
    const mb = b.market_cap_inr ?? -Infinity;
    return mb - ma;
  });
  return sorted.map((s, i) => ({ index: i, ...s }));
}

function writeUniverse(arr) {
  ensureDataDir();
  const tmp = PATHS.universe + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
  fs.renameSync(tmp, PATHS.universe);
  writeUniverseMeta(arr.length);
}

// Sidecar metadata so universe.json's staleness is monitorable by
// /api/health/snapshots. universe.json itself is a bare JSON array with no
// room for a top-level timestamp, and ~13 scripts read it as an array — a
// sidecar avoids a breaking shape change.
function writeUniverseMeta(count) {
  const meta = { generatedAt: new Date().toISOString(), count };
  const tmp = PATHS.universeMeta + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
  fs.renameSync(tmp, PATHS.universeMeta);
}

function loadExistingUniverse() {
  if (!fs.existsSync(PATHS.universe)) return [];
  try {
    return JSON.parse(fs.readFileSync(PATHS.universe, "utf-8"));
  } catch {
    return [];
  }
}

async function main() {
  const args = process.argv.slice(2);
  const useSeed = args.includes("--seed");
  const fromStdin = args.includes("--from-stdin");
  const merge = args.includes("--merge");

  let universe = [];

  if (useSeed) {
    universe = await fromSeed();
    console.log(`Seed mode: ${universe.length} total entries (priority-ordered)`);
  }

  if (fromStdin) {
    const raw = await readStdin();
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) {
      console.error(`Could not parse stdin as JSON: ${e.message}`);
      process.exit(2);
    }
    if (!Array.isArray(parsed)) {
      console.error(`Stdin JSON must be an array.`);
      process.exit(2);
    }
    if (merge) {
      const existing = loadExistingUniverse();
      universe = dedupeAndIndex([...existing, ...parsed]);
    } else {
      universe = dedupeAndIndex(parsed);
    }
    console.log(`Stdin mode: ${universe.length} entries (${merge ? "merged" : "fresh"})`);
  }

  if (!useSeed && !fromStdin) {
    console.error(`Usage:
  node scripts/sws-build-universe.mjs --seed
  node scripts/sws-build-universe.mjs --from-stdin [--merge] < tickers.json
`);
    process.exit(2);
  }

  writeUniverse(universe);
  console.log(`Wrote ${universe.length} entries to ${PATHS.universe}`);
  console.log(`Top 10 by market cap:`);
  for (const s of universe.slice(0, 10)) {
    const mc = s.market_cap_inr ? `₹${(s.market_cap_inr / 1e12).toFixed(2)}t` : "(no cap)";
    console.log(`  ${String(s.index).padStart(4)}  ${s.ticker.padEnd(12)} ${mc}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
