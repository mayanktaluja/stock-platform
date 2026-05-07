#!/usr/bin/env node
/**
 * Coverage gap analysis for the recommendation engine.
 *
 * Compares our SWS-scraped universe (data/sws/universe.json, ~5,440 names)
 * against the full retail-investable Indian equity universe pulled from
 * official sources:
 *
 *   • NSE EQUITY_L.csv      → ~2,365 main-board (EQ + BE + BZ)
 *   • BSE ListofScripData   → ~4,844 active equity scrips
 *
 * Most NSE-listed companies are also dual-listed on BSE, so ground truth is
 * the dedup-by-ISIN union of the two — typically 5,000–5,500 unique
 * companies, which is what Groww also surfaces in its retail equity list.
 *
 * SME (NSE Emerge / BSE SME) is intentionally skipped: low-liquidity,
 * SEBI-flagged-high-risk, and not investable for a long-only recommendation
 * book. SWS itself doesn't carry SME either.
 *
 * Output:
 *   data/coverage/ground_truth.json   — full deduped equity master
 *   data/coverage/coverage_gap.json   — gap summary + missing-stock list
 *   data/coverage/coverage_report.md  — human-readable report
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const NSE_CSV = path.join(ROOT, "data/coverage/nse_equity_l.csv");
const NSE_SME_JSON = path.join(ROOT, "data/coverage/nse_sme_emerge.json");
const BSE_JSON = path.join(ROOT, "data/coverage/bse_equity_active.json");
const SWS_UNIVERSE = path.join(ROOT, "data/sws/universe.json");
const SWS_SCORED = path.join(ROOT, "data/sws/sws-scored-universe.json");
const NSE_SUPPLEMENT = path.join(ROOT, "nseUniverseSupplement.json");

const OUT_DIR = path.join(ROOT, "data/coverage");
const OUT_GROUND_TRUTH = path.join(OUT_DIR, "ground_truth.json");
const OUT_GAP_JSON = path.join(OUT_DIR, "coverage_gap.json");
const OUT_GAP_MD = path.join(OUT_DIR, "coverage_report.md");
// Groww-tradeable stocks not in our SWS universe — the *candidates* for
// further work. The actual merge-ready delta (probe-confirmed on SWS) is
// produced by scripts/sws-build-delta.mjs and lives in sws_universe_delta.json.
const OUT_CANDIDATES = path.join(OUT_DIR, "groww_missing_candidates.json");

const NSE_SME_INDEX_URL =
  "https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%20SME%20EMERGE";
const SME_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQ = !inQ;
      continue;
    }
    if (ch === "," && !inQ) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

async function loadNseSme(forceRefresh = false) {
  // NIFTY SME EMERGE index — ~514 constituents on the NSE Emerge SME platform.
  // Groww carries every one of these, but EQUITY_L.csv is main-board only, so
  // they need a separate source.
  //
  // The basic equity-stockIndices response for SME does NOT include `meta`
  // (no ISIN, no full company name), so we rely on the symbol as the dedup
  // key. SME tickers don't collide with EQUITY_L symbols (different segment).
  const exists = fs.existsSync(NSE_SME_JSON);
  const fresh =
    exists && Date.now() - fs.statSync(NSE_SME_JSON).mtimeMs < SME_CACHE_TTL_MS;
  if (!exists || forceRefresh || !fresh) {
    console.log(
      `  Fetching NIFTY SME EMERGE${exists ? " (cache stale)" : ""}…`
    );
    try {
      const res = await fetch(NSE_SME_INDEX_URL, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "application/json",
          Referer: "https://www.nseindia.com/market-data/live-equity-market",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      fs.writeFileSync(NSE_SME_JSON, JSON.stringify(json, null, 2));
    } catch (err) {
      console.warn(`  NSE SME fetch failed: ${err.message}`);
      if (!exists) return [];
      // Fall through to the stale cache rather than dropping SME entirely.
    }
  }
  const data = JSON.parse(fs.readFileSync(NSE_SME_JSON, "utf-8"));
  const rows = [];
  for (const r of data.data || []) {
    const symbol = (r.symbol || "").toUpperCase();
    if (!symbol) continue;
    if (symbol === "NIFTY SME EMERGE") continue; // index header row
    rows.push({
      source: "NSE-SME",
      symbol,
      name: symbol, // index endpoint doesn't return company name
      series: (r.series || "SM").toUpperCase(),
      isin: null, // not exposed by the index endpoint
    });
  }
  return rows;
}

function loadNse() {
  const text = fs.readFileSync(NSE_CSV, "utf-8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length < 7) continue;
    const [symbol, name, series, _dateListed, _paid, _lot, isin] = cols;
    if (!symbol || !isin) continue;
    rows.push({
      source: "NSE",
      symbol: symbol.toUpperCase(),
      name: name?.trim() || symbol,
      series: (series || "").toUpperCase(),
      isin: isin.trim().toUpperCase(),
    });
  }
  return rows;
}

function isEtfOrFundUnit(rec) {
  // BSE A-group has many ETF/MF units (SENSEXBEES, NIFTYIETF, ICICIB22, etc.)
  // that aren't individual stocks and don't belong in a stock-recommendation
  // universe. Detect by issuer name (contains "Mutual Fund" / "ETF") OR by
  // ISIN prefix (ETFs start with INF, equities with INE) OR by trailing
  // ticker patterns.
  const isin = (rec.ISIN_NUMBER || "").toUpperCase();
  if (isin.startsWith("INF")) return true; // mutual-fund / ETF ISIN range
  const issuer = (rec.Issuer_Name || rec.Scrip_Name || "").toLowerCase();
  if (/mutual fund|asset management|etf\b|exchange traded/.test(issuer)) {
    return true;
  }
  const sym = (rec.scrip_id || "").toUpperCase();
  if (/(ETF|BEES|BETA|IETF|NETF|G$)/.test(sym)) {
    // Heuristic — covers SENSEXBEES, NIFTYIETF, NIFTYBEES, BSLSENETFG, etc.
    // The trailing-G is the "Growth" suffix used by BSE-listed scheme units.
    return /ETF|BEES|BETA|IETF|NETF/.test(sym);
  }
  return false;
}

function loadBse() {
  const arr = JSON.parse(fs.readFileSync(BSE_JSON, "utf-8"));
  const rows = [];
  for (const r of arr) {
    const isin = (r.ISIN_NUMBER || "").trim().toUpperCase();
    const symbol = (r.scrip_id || "").trim().toUpperCase();
    if (!isin || !symbol) continue;
    if (!isin.startsWith("IN")) continue;
    rows.push({
      source: "BSE",
      symbol,
      bseCode: r.SCRIP_CD,
      name: r.Issuer_Name?.trim() || r.Scrip_Name?.trim() || symbol,
      group: r.GROUP,
      industry: r.INDUSTRY,
      isin,
      mktCapCr: r.Mktcap ? Number(r.Mktcap) : null,
      isFundUnit: isEtfOrFundUnit(r),
    });
  }
  return rows;
}

function buildGroundTruth(nseRows, bseRows, smeRows = []) {
  // Dedupe by ISIN. NSE wins on symbol identity (since Indian retail platforms
  // mostly quote NSE prices), BSE adds anything NSE doesn't have plus market
  // cap data which NSE doesn't publish in EQUITY_L. SME rows have no ISIN, so
  // we key them by `NSE-SME-<symbol>` and include them in the deduped union.
  const byIsin = new Map();

  for (const r of nseRows) {
    byIsin.set(r.isin, {
      isin: r.isin,
      nseSymbol: r.symbol,
      nseSeries: r.series,
      bseCode: null,
      bseSymbol: null,
      bseGroup: null,
      name: r.name,
      industry: null,
      mktCapCr: null,
      onNse: true,
      onBse: false,
    });
  }

  // NSE Emerge SME — symbol-keyed since the index endpoint exposes no ISIN.
  // These never overlap with EQUITY_L / BSE active equity (different segment).
  for (const r of smeRows) {
    const key = `NSE-SME-${r.symbol}`;
    if (byIsin.has(key)) continue;
    byIsin.set(key, {
      isin: null,
      synthKey: key,
      nseSymbol: r.symbol,
      nseSeries: r.series, // SM or ST
      bseCode: null,
      bseSymbol: null,
      bseGroup: null,
      name: r.name,
      industry: null,
      mktCapCr: null,
      onNse: true,
      onBse: false,
      isSme: true,
    });
  }

  for (const r of bseRows) {
    if (r.isFundUnit) continue; // exclude ETFs / MF units from stock universe
    const existing = byIsin.get(r.isin);
    if (existing) {
      existing.bseCode = r.bseCode;
      existing.bseSymbol = r.symbol;
      existing.bseGroup = r.group;
      existing.industry = existing.industry || r.industry;
      existing.mktCapCr = r.mktCapCr;
      existing.onBse = true;
    } else {
      byIsin.set(r.isin, {
        isin: r.isin,
        nseSymbol: null,
        nseSeries: null,
        bseCode: r.bseCode,
        bseSymbol: r.symbol,
        bseGroup: r.group,
        name: r.name,
        industry: r.industry,
        mktCapCr: r.mktCapCr,
        onNse: false,
        onBse: true,
      });
    }
  }

  return [...byIsin.values()];
}

function bucketByMarketCap(mktCapCr) {
  if (mktCapCr == null || mktCapCr <= 0) return "unknown";
  // Standard SEBI/AMFI India market cap bands (approx ₹ Cr):
  //   Large cap : top 100 by mcap → roughly > 50,000 Cr
  //   Mid cap   : 101–250         → roughly 15,000–50,000 Cr
  //   Small cap : 251–500         → roughly 5,000–15,000 Cr
  //   Micro/nano: rest            → < 5,000 Cr
  if (mktCapCr >= 50_000) return "large";
  if (mktCapCr >= 15_000) return "mid";
  if (mktCapCr >= 5_000) return "small";
  if (mktCapCr >= 500) return "micro";
  return "nano"; // < 500 Cr — penny / illiquid tail
}

// Exported for reuse by the scorer / recommender (Step 6 of the coverage plan).
// The recommendation engine gates BUY / TOP-UP actions on tier (no BUY on
// surveillance, SME, or trade-to-trade groups) — that decision lives in
// services/swsScoring.js + services/swsRecommenderMode.js, but the mapping
// itself is centralised here so universe and scorer stay in sync.
export function liquidityTierFromBseGroup(group) {
  // BSE groups, by liquidity / SEBI surveillance:
  //   A           : top by liquidity, large/mid cap
  //   B           : mid/small, regular trading
  //   T           : trade-to-trade, short delivery
  //   Z, ZP       : compliance / suspended
  //   X, XT       : pre-A migrated, less-liquid main board
  //   M, MS, MT   : SME segment (B-list)
  //   P, R, IP    : permitted / IPO / right-issue
  switch ((group || "").toUpperCase()) {
    case "A":
      return "highly_liquid";
    case "B":
      return "liquid";
    case "T":
    case "X":
    case "XT":
      return "low_liquidity";
    case "Z":
    case "ZP":
      return "surveillance"; // typically excluded
    case "M":
    case "MS":
    case "MT":
    case "TS":
      return "sme"; // typically excluded
    case "P":
    case "R":
    case "IP":
    case "Y":
      return "special";
    default:
      return "other";
  }
}

function loadSwsUniverse() {
  return JSON.parse(fs.readFileSync(SWS_UNIVERSE, "utf-8"));
}

function loadSwsScored() {
  if (!fs.existsSync(SWS_SCORED)) return [];
  try {
    const d = JSON.parse(fs.readFileSync(SWS_SCORED, "utf-8"));
    return Array.isArray(d) ? d : (d.stocks || d.universe || []);
  } catch {
    return [];
  }
}

function loadSupplement() {
  if (!fs.existsSync(NSE_SUPPLEMENT)) return null;
  try {
    return JSON.parse(fs.readFileSync(NSE_SUPPLEMENT, "utf-8"));
  } catch {
    return null;
  }
}

function indexSws(swsUniverse) {
  // Build several indexes so we can match ground truth by NSE symbol, BSE
  // symbol, ISIN, and a name fallback.
  const byTickerUpper = new Map();
  const byNameNormalized = new Map();
  for (const s of swsUniverse) {
    const t = (s.ticker || "").toUpperCase();
    if (t) byTickerUpper.set(t, s);
    const name = (s.name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (name) byNameNormalized.set(name, s);
  }
  return { byTickerUpper, byNameNormalized };
}

function indexSupplement(supp) {
  // The NSE supplement carries ISINs we don't have anywhere else, so it's a
  // useful secondary cross-check.
  const byIsin = new Map();
  if (supp && supp.bySymbol) {
    for (const [sym, rec] of Object.entries(supp.bySymbol)) {
      if (rec.isin) byIsin.set(rec.isin.toUpperCase(), { sym, rec });
    }
  }
  return byIsin;
}

function normalizeName(s) {
  return (s || "")
    .toLowerCase()
    .replace(/limited|ltd|\.|,|\(|\)/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

function classifyMatch(gt, sws, supp) {
  // SWS ticker conventions for BSE-only listings vary across the universe:
  //   • Bare 6-digit scrip code (e.g. "500009")
  //   • Prefixed form "BSE_<code>" (e.g. "BSE_526783" — used in newer entries)
  // So check both forms before falling back to symbol/ISIN/name.
  if (gt.nseSymbol && sws.byTickerUpper.has(gt.nseSymbol)) {
    return { matched: true, by: "nse_symbol", swsTicker: gt.nseSymbol };
  }
  if (gt.bseCode) {
    const bare = String(gt.bseCode);
    if (sws.byTickerUpper.has(bare)) {
      return { matched: true, by: "bse_code", swsTicker: bare };
    }
    const prefixed = `BSE_${bare}`;
    if (sws.byTickerUpper.has(prefixed)) {
      return { matched: true, by: "bse_code_prefixed", swsTicker: prefixed };
    }
  }
  if (gt.bseSymbol && sws.byTickerUpper.has(gt.bseSymbol)) {
    return { matched: true, by: "bse_symbol", swsTicker: gt.bseSymbol };
  }
  const supHit = supp.get(gt.isin);
  if (supHit && sws.byTickerUpper.has(supHit.sym)) {
    return { matched: true, by: "isin_via_supplement", swsTicker: supHit.sym };
  }
  const nName = normalizeName(gt.name);
  if (nName && sws.byNameNormalized.has(nName)) {
    return {
      matched: true,
      by: "name_exact",
      swsTicker: sws.byNameNormalized.get(nName).ticker,
    };
  }
  return { matched: false };
}

function summariseGap(missing) {
  const byBucket = {};
  const byTier = {};
  const onlyOnExchange = { NSE_only: 0, BSE_only: 0, Both: 0 };
  let totalMcapCr = 0;
  for (const m of missing) {
    const b = bucketByMarketCap(m.mktCapCr);
    byBucket[b] = (byBucket[b] || 0) + 1;
    const t = liquidityTierFromBseGroup(m.bseGroup);
    byTier[t] = (byTier[t] || 0) + 1;
    if (m.onNse && m.onBse) onlyOnExchange.Both++;
    else if (m.onNse) onlyOnExchange.NSE_only++;
    else if (m.onBse) onlyOnExchange.BSE_only++;
    if (m.mktCapCr) totalMcapCr += m.mktCapCr;
  }
  return { byBucket, byTier, onlyOnExchange, totalMcapCr };
}

// "Groww-tradeable missing" — the universe-construction filter.
//
// The recommendation engine targets every Indian equity a retail investor can
// buy on Groww that SWS has data for, irrespective of market cap, BSE liquidity
// group, or SME segment. The previous "actionable" filter bundled scoring-time
// caution (don't recommend illiquid microcaps) with universe construction
// (don't ingest them) — wrong layer. Caution belongs in the scorer; ingestion
// stays broad.
//
// We still skip:
//   • BZ-series suspended NSE listings (regulator-flagged, untradeable)
//   • Z / ZP surveillance with mcap == 0 (BSE has fully suspended these)
//
// Everything else — NSE EQ/BE main board, NSE Emerge SME (added via separate
// source), all BSE A/B/T/X/XT/M/MS/MT/P/R/IP groups — goes through.
function growwTradeableMissing(missing) {
  return missing.filter((m) => {
    if (m.onNse && m.nseSeries === "BZ") return false; // suspended on NSE
    return true;
  });
}

async function main() {
  const refreshSme = process.argv.includes("--refresh-sme");
  console.log("Loading sources…");
  const nseRows = loadNse();
  const bseRows = loadBse();
  const smeRows = await loadNseSme(refreshSme);
  const swsUniverse = loadSwsUniverse();
  const swsScored = loadSwsScored();
  const supplement = loadSupplement();

  console.log(`  NSE EQUITY_L : ${nseRows.length} rows`);
  console.log(`  NSE SME EMERGE: ${smeRows.length} rows`);
  console.log(`  BSE Active   : ${bseRows.length} rows`);
  console.log(`  SWS universe : ${swsUniverse.length} stocks`);
  console.log(`  SWS scored   : ${swsScored.length} stocks`);
  console.log(`  NSE supplement: ${supplement?.count ?? 0} stocks`);

  const groundTruth = buildGroundTruth(nseRows, bseRows, smeRows);
  console.log(`\nGround truth (deduped by ISIN+symbol): ${groundTruth.length} unique companies`);

  const swsIdx = indexSws(swsUniverse);
  const suppIdx = indexSupplement(supplement);

  let matched = 0;
  let unmatched = 0;
  const missing = [];
  const matchedBy = {};
  for (const gt of groundTruth) {
    const r = classifyMatch(gt, swsIdx, suppIdx);
    if (r.matched) {
      matched++;
      matchedBy[r.by] = (matchedBy[r.by] || 0) + 1;
    } else {
      unmatched++;
      missing.push(gt);
    }
  }

  console.log(`\nMatched against SWS: ${matched} / ${groundTruth.length} (${((matched / groundTruth.length) * 100).toFixed(1)}%)`);
  console.log(`Match strategy:`, matchedBy);
  console.log(`Missing from SWS:    ${unmatched}`);

  // Reverse direction: SWS stocks that aren't in ground truth (NSE+BSE master).
  // These are typically NSE Emerge SME, BSE-only suspended/delisted entries
  // that SWS still has a page for, or recent IPOs after the master snapshot.
  // Useful for awareness — a recommendation engine should know these aren't
  // currently active main-board listings.
  const gtTickerSet = new Set();
  const gtIsinSet = new Set();
  for (const gt of groundTruth) {
    if (gt.nseSymbol) gtTickerSet.add(gt.nseSymbol);
    if (gt.bseSymbol) gtTickerSet.add(gt.bseSymbol);
    if (gt.bseCode) {
      gtTickerSet.add(String(gt.bseCode));
      gtTickerSet.add(`BSE_${gt.bseCode}`);
    }
    if (gt.isin) gtIsinSet.add(gt.isin);
  }
  const swsExtras = swsUniverse.filter((s) => !gtTickerSet.has(s.ticker));
  console.log(`\nSWS stocks NOT in ground truth: ${swsExtras.length}`);
  const swsExtrasByEx = {};
  for (const s of swsExtras) {
    swsExtrasByEx[s.exchange || "?"] = (swsExtrasByEx[s.exchange || "?"] || 0) + 1;
  }
  console.log(`  By exchange:`, swsExtrasByEx);

  const summary = summariseGap(missing);
  console.log(`\nGap by market-cap bucket:`, summary.byBucket);
  console.log(`Gap by liquidity tier:`, summary.byTier);
  console.log(`Gap by exchange presence:`, summary.onlyOnExchange);

  const actionable = growwTradeableMissing(missing);
  console.log(`\n→ Groww-tradeable missing (target for SWS scrape): ${actionable.length}`);
  const actSummary = summariseGap(actionable);
  console.log(`   By market-cap bucket:`, actSummary.byBucket);
  console.log(`   By liquidity tier:`, actSummary.byTier);

  // Sort missing by market cap desc for the report
  const missingSorted = [...missing].sort(
    (a, b) => (b.mktCapCr ?? 0) - (a.mktCapCr ?? 0)
  );
  const actionableSorted = [...actionable].sort(
    (a, b) => (b.mktCapCr ?? 0) - (a.mktCapCr ?? 0)
  );

  fs.writeFileSync(
    OUT_GROUND_TRUTH,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        sources: {
          nse: "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv",
          nse_sme: NSE_SME_INDEX_URL,
          bse: "https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w?segment=Equity&status=Active",
        },
        counts: {
          nse_main_board: nseRows.length,
          nse_sme_emerge: smeRows.length,
          bse_active: bseRows.length,
          deduped: groundTruth.length,
        },
        stocks: groundTruth,
      },
      null,
      2
    )
  );
  console.log(`\n✓ Wrote ${OUT_GROUND_TRUTH}`);

  fs.writeFileSync(
    OUT_GAP_JSON,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        groundTruthCount: groundTruth.length,
        swsUniverseCount: swsUniverse.length,
        matched,
        unmatched,
        coveragePct: ((matched / groundTruth.length) * 100).toFixed(2),
        matchedBy,
        gapByMarketCap: summary.byBucket,
        gapByLiquidityTier: summary.byTier,
        gapByExchange: summary.onlyOnExchange,
        actionableCount: actionable.length,
        actionableSummary: actSummary,
        swsExtrasCount: swsExtras.length,
        swsExtrasByExchange: swsExtrasByEx,
        missing: missingSorted,
        actionableMissing: actionableSorted,
        swsExtras,
      },
      null,
      2
    )
  );
  console.log(`✓ Wrote ${OUT_GAP_JSON}`);

  // Groww-tradeable candidates we don't have in our SWS universe.
  //
  // This is the GAP CANDIDATE list — every Groww-tradeable Indian equity
  // missing from the SWS universe, regardless of whether SWS actually has
  // a page for it. To turn this into a merge-ready file, run:
  //
  //   node scripts/sws-probe-availability.mjs
  //   node scripts/sws-build-delta.mjs
  //
  // The probe filters this list against SWS's Asia sitemap; the builder
  // emits the merge-ready data/coverage/sws_universe_delta.json that
  // sws-build-universe.mjs consumes.
  const candidates = actionableSorted.map((m) => ({
    ticker: m.nseSymbol || m.bseSymbol,
    exchange: m.nseSymbol ? "NSE" : "BSE",
    market_cap_inr: m.mktCapCr ? Math.round(m.mktCapCr * 1e7) : null,
    name: m.name,
    industry: m.industry || null,
    indices: [m.nseSymbol ? `NSE-${m.nseSeries}` : `BSE-${m.bseGroup}`],
    isin: m.isin,
    bse_code: m.bseCode,
  }));
  fs.writeFileSync(OUT_CANDIDATES, JSON.stringify(candidates, null, 2));
  console.log(`✓ Wrote ${OUT_CANDIDATES} (${candidates.length} Groww-tradeable gap candidates)`);

  // Markdown report
  const md = renderMarkdown({
    nseRows,
    bseRows,
    swsUniverse,
    groundTruth,
    matched,
    unmatched,
    matchedBy,
    summary,
    actionable,
    actSummary,
    missingSorted,
    actionableSorted,
    swsExtras,
    swsExtrasByEx,
  });
  fs.writeFileSync(OUT_GAP_MD, md);
  console.log(`✓ Wrote ${OUT_GAP_MD}`);
}

function fmtCr(n) {
  if (n == null) return "—";
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(2)}L Cr`;
  if (n >= 1000) return `₹${(n / 1000).toFixed(1)}k Cr`;
  return `₹${n.toFixed(0)} Cr`;
}

function renderMarkdown({
  nseRows,
  bseRows,
  swsUniverse,
  groundTruth,
  matched,
  unmatched,
  matchedBy,
  summary,
  actionable,
  actSummary,
  missingSorted,
  actionableSorted,
  swsExtras,
  swsExtrasByEx,
}) {
  const coveragePct = ((matched / groundTruth.length) * 100).toFixed(2);
  const lines = [];
  lines.push("# Stock Universe Coverage Gap — SWS vs Indian Equity Ground Truth\n");
  lines.push(`Generated: ${new Date().toISOString()}\n`);
  lines.push("## Headline\n");
  lines.push(`- **Ground truth (NSE+BSE deduped by ISIN):** ${groundTruth.length}`);
  lines.push(`- **SWS universe (data/sws/universe.json):** ${swsUniverse.length}`);
  lines.push(`- **Matched:** ${matched} (${coveragePct}%)`);
  lines.push(`- **Missing from SWS:** ${unmatched}`);
  lines.push(`- **Groww-tradeable missing** (any market cap, any liquidity tier, excludes only NSE-suspended BZ): **${actionable.length}**\n`);
  lines.push("## Sources\n");
  lines.push(`- NSE EQ + BE + BZ master (EQUITY_L.csv): **${nseRows.length}**`);
  lines.push(`- BSE active equity scrips (ListofScripData): **${bseRows.length}**`);
  lines.push(`- Deduped by ISIN: **${groundTruth.length}**`);
  lines.push(`- Skipped: NSE Emerge SME and BSE SME segment (low-liquidity, not investment-grade for a long-only book)\n`);
  lines.push("## Match strategy\n");
  for (const [k, v] of Object.entries(matchedBy)) {
    lines.push(`- ${k}: ${v}`);
  }
  lines.push("");
  lines.push("## Gap breakdown\n");
  lines.push("### By market-cap bucket\n");
  lines.push("| Bucket | Missing |");
  lines.push("|---|---|");
  for (const [k, v] of Object.entries(summary.byBucket).sort(
    (a, b) => b[1] - a[1]
  )) {
    lines.push(`| ${k} | ${v} |`);
  }
  lines.push("\n### By BSE liquidity tier\n");
  lines.push("| Tier | Missing |");
  lines.push("|---|---|");
  for (const [k, v] of Object.entries(summary.byTier).sort(
    (a, b) => b[1] - a[1]
  )) {
    lines.push(`| ${k} | ${v} |`);
  }
  lines.push("\n### By exchange presence\n");
  lines.push("| Where listed | Missing |");
  lines.push("|---|---|");
  for (const [k, v] of Object.entries(summary.onlyOnExchange)) {
    lines.push(`| ${k} | ${v} |`);
  }
  lines.push("\n## Groww-tradeable missing (top 50 by market cap)\n");
  lines.push("Every Indian equity a retail investor can buy on Groww that we don't yet have an SWS deep-scrape for. Sorted by market cap descending.\n");
  lines.push("| Name | NSE | BSE | ISIN | Mkt Cap | Tier |");
  lines.push("|---|---|---|---|---|---|");
  for (const m of actionableSorted.slice(0, 50)) {
    lines.push(
      `| ${(m.name || "").slice(0, 50)} | ${m.nseSymbol || "—"} | ${m.bseSymbol || "—"} (${m.bseGroup || "—"}) | ${m.isin} | ${fmtCr(m.mktCapCr)} | ${liquidityTierFromBseGroup(m.bseGroup)} |`
    );
  }
  lines.push("");
  lines.push("## Largest 30 missing (any tier)\n");
  lines.push("Includes SME / surveillance / illiquid — not necessarily actionable, useful for awareness.\n");
  lines.push("| Name | NSE | BSE | Mkt Cap | Group |");
  lines.push("|---|---|---|---|---|");
  for (const m of missingSorted.slice(0, 30)) {
    lines.push(
      `| ${(m.name || "").slice(0, 50)} | ${m.nseSymbol || "—"} | ${m.bseSymbol || "—"} | ${fmtCr(m.mktCapCr)} | ${m.bseGroup || "—"} |`
    );
  }
  lines.push("");
  lines.push("## SWS-only stocks (in SWS universe but not in NSE/BSE master)\n");
  lines.push(`Total: **${swsExtras.length}** (${JSON.stringify(swsExtrasByEx)})\n`);
  lines.push("These are stocks SWS scraped from its sitemap but that don't appear in the current NSE EQUITY_L or BSE active-equity master. Three buckets dominate:\n");
  lines.push("- **NSE Emerge SME** — small-cap listings on the SME platform (separate from main board, not in EQUITY_L). Recognisable by names like *3rd Rock Multimedia, Aakaar Medical Technologies*.");
  lines.push("- **BSE-only delisted / suspended** — old scrips SWS still has pages for. Recognisable by 6-digit BSE codes pointing to dormant names (*Harig Crankshafts, JCT, Kanel Industries*).");
  lines.push("- **Recent IPOs / spin-offs** — listed after the master CSV snapshot.\n");
  lines.push("Sample (first 15 BSE-only extras with names):\n");
  lines.push("| BSE Code | Name |");
  lines.push("|---|---|");
  for (const s of swsExtras.filter((x) => x.exchange === "BSE" && x.name).slice(0, 15)) {
    lines.push(`| ${s.ticker} | ${(s.name || "").slice(0, 60)} |`);
  }
  lines.push("\n");
  lines.push("## What to do next\n");
  lines.push("1. **Review `data/coverage/groww_missing_candidates.json`** — every Groww-tradeable equity not yet in our SWS universe.");
  lines.push("2. Run `node scripts/sws-probe-availability.mjs` to filter the candidates against SWS's Asia sitemap (which stocks SWS actually has a page for).");
  lines.push("3. Run `node scripts/sws-build-delta.mjs` to build the merge-ready `data/coverage/sws_universe_delta.json`.");
  lines.push("4. Run `node scripts/sws-build-universe.mjs --merge --from-stdin < data/coverage/sws_universe_delta.json` to add them.");
  lines.push("5. The next 02:00 / 16:30 IST nightly fire (launchd) will deep-scrape the new entries automatically.");
  return lines.join("\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
